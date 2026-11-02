import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { validState, type PlanState } from "../cli/core/planning";
import type { PlanningAuthority } from "../cli/core/planning-authority";

const ARCHIVE_SCHEMA = 1;
const ARCHIVE_KIND = "malahor.plan.archive";
const POINTER_KIND = "malahor.plan.archive-pointer";
const LIVE_PREFIX = "planning/v5/";
const LEGACY_LIVE_PREFIX = "planning/v4/";
const ARCHIVE_PREFIX = "planning/archive/v1/plans";
const MAX_ARCHIVE_BYTES = 64 * 1024;
const DEFAULT_SCAN_LIMIT = 500;
const SCAN_PAGE_SIZE = 100;
const TERMINAL_PHASES = new Set<PlanState["phase"]>(["completed", "revoked", "superseded"]);

export interface PlanningStorageScanOptions {
  prefix: string;
  after?: string;
  limit?: number;
}

export interface PlanningStorageScanResult {
  entries: readonly { key: string; value: unknown }[];
  next?: string;
}

export interface PlanningRetentionStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove?: (key: string) => Promise<void>;
  scan?: (options: PlanningStorageScanOptions) => Promise<PlanningStorageScanResult>;
}

export interface PlanPersistenceResult {
  status: "live" | "archived" | "retained";
  removed: number;
  reason?: string;
}

export interface PlanCompactionResult {
  supported: boolean;
  scanned: number;
  compacted: number;
  removed: number;
  failed: number;
  truncated: boolean;
}

interface PlanArchiveEnvelope {
  schema: 1;
  kind: typeof ARCHIVE_KIND;
  encoding: "gzip-base64";
  planID: string;
  revision: string;
  project: string;
  phase: PlanState["phase"];
  digest: string;
  sha256: string;
  compressedSha256: string;
  uncompressedBytes: number;
  payload: string;
}

interface PlanArchivePointer {
  schema: 1;
  kind: typeof POINTER_KIND;
  planID: string;
  revision: string;
  project: string;
  phase: PlanState["phase"];
  digest: string;
  archiveKey: string;
}

export function planKey(sessionID: string): string {
  if (!/^ses[A-Za-z0-9_-]{1,128}$/.test(sessionID)) throw new Error("ID de sesion no evaluable.");
  return `planning/v5/sessions/${sessionID}`;
}

export function planRecordKey(planID: string): string {
  assertPlanID(planID);
  return `planning/v5/plans/${planID}`;
}

export function planRevisionKey(planID: string, revision: string): string {
  assertPlanID(planID);
  assertRevision(revision);
  return `${planRecordKey(planID)}/revisions/${revision}`;
}

export function legacyPlanKey(sessionID: string): string {
  if (!/^ses[A-Za-z0-9_-]{1,128}$/.test(sessionID)) throw new Error("ID de sesion no evaluable.");
  return `planning/v4/sessions/${sessionID}`;
}

export function legacyPlanRecordKey(planID: string): string {
  assertPlanID(planID);
  return `planning/v4/plans/${planID}`;
}

export function legacyPlanRevisionKey(planID: string, revision: string): string {
  assertPlanID(planID);
  assertRevision(revision);
  return `${legacyPlanRecordKey(planID)}/revisions/${revision}`;
}

export function planArchiveRecordKey(planID: string): string {
  assertPlanID(planID);
  return `${ARCHIVE_PREFIX}/${planID}`;
}

export function planArchiveRevisionKey(planID: string, revision: string): string {
  assertRevision(revision);
  return `${planArchiveRecordKey(planID)}/revisions/${revision}`;
}

export async function persistPlanState(
  storage: PlanningRetentionStorage,
  state: PlanState,
  authority: PlanningAuthority,
): Promise<PlanPersistenceResult> {
  await writeLiveState(storage, state);
  if (!TERMINAL_PHASES.has(state.phase)) return { status: "live", removed: 0 };

  const result = await archiveAndPrune(storage, state, authority);
  return result.ok && result.removed === 3
    ? { status: "archived", removed: result.removed }
    : { status: "retained", removed: result.removed, reason: result.reason ?? "compactacion incompleta" };
}

/** V5 prevalece. Un registro V5 presente pero inválido nunca cae a V4. */
export async function loadActivePlanRaw(
  storage: PlanningRetentionStorage,
  sessionID: string,
): Promise<unknown> {
  const currentRead = await strictGet(storage, planKey(sessionID));
  if (!currentRead.ok) return { kind: "malahor.plan.storage-unavailable" };
  const current = currentRead.value;
  if (current !== undefined) return current;
  const legacy = await strictGet(storage, legacyPlanKey(sessionID));
  return legacy.ok ? legacy.value : { kind: "malahor.plan.storage-unavailable" };
}

export async function loadActivePlan(
  storage: PlanningRetentionStorage,
  sessionID: string,
  authority: PlanningAuthority,
): Promise<PlanState | undefined> {
  const raw = await loadActivePlanRaw(storage, sessionID);
  return validState(raw, authority) ? raw : undefined;
}

export async function loadPlanRecord(
  storage: PlanningRetentionStorage,
  planID: string,
  authority: PlanningAuthority,
): Promise<PlanState | undefined> {
  const currentRead = await strictGet(storage, planRecordKey(planID));
  if (!currentRead.ok) return undefined;
  const live = currentRead.value;
  if (live !== undefined) return validState(live, authority) ? live : undefined;
  const legacyRead = await strictGet(storage, legacyPlanRecordKey(planID));
  if (!legacyRead.ok) return undefined;
  const legacy = legacyRead.value;
  if (legacy !== undefined) return validState(legacy, authority) ? legacy : undefined;

  const rawPointer = await safeGet(storage, planArchiveRecordKey(planID));
  const pointer = parsePointer(rawPointer, planID);
  if (!pointer) return undefined;
  const archived = await safeGet(storage, pointer.archiveKey);
  const state = decodeArchive(archived, authority);
  return state && pointerMatchesState(pointer, state) ? state : undefined;
}

export async function compactTerminalPlans(
  storage: PlanningRetentionStorage,
  authority: PlanningAuthority,
  options: { maxEntries?: number } = {},
): Promise<PlanCompactionResult> {
  if (typeof storage.scan !== "function" || typeof storage.remove !== "function") {
    return { supported: false, scanned: 0, compacted: 0, removed: 0, failed: 0, truncated: false };
  }

  const maxEntries = boundedLimit(options.maxEntries);
  const candidates = new Map<string, PlanState>();
  let scanned = 0;
  let truncated = false;

  for (const prefix of [LIVE_PREFIX, LEGACY_LIVE_PREFIX]) {
    let after: string | undefined;
    while (scanned < maxEntries) {
      let page: PlanningStorageScanResult;
      try {
        page = await storage.scan({
          prefix,
          ...(after ? { after } : {}),
          limit: Math.min(SCAN_PAGE_SIZE, maxEntries - scanned),
        });
      } catch {
        return { supported: true, scanned, compacted: 0, removed: 0, failed: 1, truncated };
      }
      if (!page || !Array.isArray(page.entries)
        || (page.next !== undefined && (typeof page.next !== "string" || page.next.length === 0))
        || (page.entries.length === 0 && page.next !== undefined)) {
        return { supported: true, scanned, compacted: 0, removed: 0, failed: 1, truncated };
      }
      for (const entry of page.entries) {
        scanned++;
        if (!validState(entry.value, authority) || !TERMINAL_PHASES.has(entry.value.phase)) continue;
        candidates.set(planIdentity(entry.value), entry.value);
        if (scanned >= maxEntries) break;
      }
      if (!page.next) break;
      if (scanned >= maxEntries) {
        truncated = true;
        break;
      }
      if (page.next === after) {
        return { supported: true, scanned, compacted: 0, removed: 0, failed: 1, truncated };
      }
      after = page.next;
    }
    if (scanned >= maxEntries) {
      truncated = true;
      break;
    }
  }

  let compacted = 0;
  let removed = 0;
  let failed = 0;
  for (const state of candidates.values()) {
    const result = await archiveAndPrune(storage, state, authority);
    removed += result.removed;
    if (result.ok) compacted++;
    else failed++;
  }
  return { supported: true, scanned, compacted, removed, failed, truncated };
}

async function writeLiveState(storage: PlanningRetentionStorage, state: PlanState): Promise<void> {
  const keys = liveStateKeys(state);
  await storage.set(keys.revision, state);
  await storage.set(keys.plan, state);
  await storage.set(keys.session, state);
}

async function archiveAndPrune(
  storage: PlanningRetentionStorage,
  state: PlanState,
  authority: PlanningAuthority,
): Promise<{ ok: boolean; removed: number; reason?: string }> {
  try {
    const archiveKey = planArchiveRevisionKey(state.planID, state.revision);
    const envelope = encodeArchive(state);
    await storage.set(archiveKey, envelope);
    const verifiedArchive = decodeArchive(await storage.get(archiveKey), authority);
    if (!verifiedArchive || !sameRevision(verifiedArchive, state)) {
      return { ok: false, removed: 0, reason: "archivo terminal no verificable" };
    }

    const pointer = archivePointer(state, archiveKey);
    await storage.set(planArchiveRecordKey(state.planID), pointer);
    const verifiedPointer = parsePointer(await storage.get(planArchiveRecordKey(state.planID)), state.planID);
    if (!verifiedPointer || !pointerMatchesState(verifiedPointer, state)) {
      return { ok: false, removed: 0, reason: "indice de archivo no verificable" };
    }

    if (typeof storage.remove !== "function") {
      return { ok: false, removed: 0, reason: "remove no disponible; archivo verificado y copias conservadas" };
    }
    return removeMatchingLiveRecords(storage, state, authority);
  } catch (error) {
    return { ok: false, removed: 0, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function removeMatchingLiveRecords(
  storage: PlanningRetentionStorage,
  state: PlanState,
  authority: PlanningAuthority,
): Promise<{ ok: boolean; removed: number; reason?: string }> {
  if (!storage.remove) return { ok: false, removed: 0, reason: "remove no disponible" };
  const keys = [
    liveStateKeys(state).revision,
    liveStateKeys(state).plan,
    liveStateKeys(state).session,
  ];
  const candidates: Array<{ key: string; value: PlanState }> = [];
  for (const key of keys) {
    const current = await safeGet(storage, key);
    if (validState(current, authority) && sameRevision(current, state)) {
      candidates.push({ key, value: current });
    }
  }

  const removed: Array<{ key: string; value: PlanState }> = [];
  for (const candidate of candidates) {
    const current = await safeGet(storage, candidate.key);
    if (!validState(current, authority) || !sameRevision(current, candidate.value)) continue;
    try {
      await storage.remove(candidate.key);
      if (await safeGet(storage, candidate.key) !== undefined) {
        throw new Error(`storage no retiro ${candidate.key}`);
      }
      removed.push(candidate);
    } catch (error) {
      const restored = await restoreRemovedRecords(storage, removed);
      return {
        ok: false,
        removed: removed.length - restored,
        reason: `retiro incompleto; copias restauradas: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true, removed: removed.length };
}

async function restoreRemovedRecords(
  storage: PlanningRetentionStorage,
  removed: Array<{ key: string; value: PlanState }>,
): Promise<number> {
  let restored = 0;
  for (const candidate of [...removed].reverse()) {
    try {
      const current = await storage.get(candidate.key);
      if (current !== undefined) continue;
      await storage.set(candidate.key, candidate.value);
      const verified = await storage.get(candidate.key);
      if (isRecord(verified) && verified.proof === candidate.value.proof) restored++;
    } catch {
      // El caller informa cuantas copias no pudieron restaurarse; nunca sobreescribe otra revision.
    }
  }
  return restored;
}

function encodeArchive(state: PlanState): PlanArchiveEnvelope {
  const serialized = JSON.stringify(state);
  const raw = Buffer.from(serialized, "utf8");
  if (raw.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Plan terminal demasiado grande para archivar.");
  const compressed = gzipSync(raw, { level: 9 });
  return {
    schema: ARCHIVE_SCHEMA,
    kind: ARCHIVE_KIND,
    encoding: "gzip-base64",
    planID: state.planID,
    revision: state.revision,
    project: state.project,
    phase: state.phase,
    digest: state.digest,
    sha256: createHash("sha256").update(raw).digest("hex"),
    compressedSha256: createHash("sha256").update(compressed).digest("hex"),
    uncompressedBytes: raw.byteLength,
    payload: compressed.toString("base64"),
  };
}

function decodeArchive(value: unknown, authority: PlanningAuthority): PlanState | undefined {
  if (!isArchiveEnvelope(value) || !canonicalBase64(value.payload)) return undefined;
  try {
    const compressed = Buffer.from(value.payload, "base64");
    if (createHash("sha256").update(compressed).digest("hex") !== value.compressedSha256) return undefined;
    const raw = gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES });
    if (raw.byteLength !== value.uncompressedBytes
      || createHash("sha256").update(raw).digest("hex") !== value.sha256) return undefined;
    const state = JSON.parse(raw.toString("utf8")) as unknown;
    if (!validState(state, authority) || !archiveMatchesState(value, state)) return undefined;
    return state;
  } catch {
    return undefined;
  }
}

function archivePointer(state: PlanState, archiveKey: string): PlanArchivePointer {
  return {
    schema: ARCHIVE_SCHEMA,
    kind: POINTER_KIND,
    planID: state.planID,
    revision: state.revision,
    project: state.project,
    phase: state.phase,
    digest: state.digest,
    archiveKey,
  };
}

function parsePointer(value: unknown, planID: string): PlanArchivePointer | undefined {
  if (!isRecord(value) || value.schema !== ARCHIVE_SCHEMA || value.kind !== POINTER_KIND
    || value.planID !== planID || typeof value.revision !== "string" || !/^[a-f0-9]{32}$/.test(value.revision)
    || typeof value.project !== "string" || typeof value.phase !== "string" || !TERMINAL_PHASES.has(value.phase as PlanState["phase"])
    || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
    || typeof value.archiveKey !== "string"
    || value.archiveKey !== planArchiveRevisionKey(planID, value.revision)) return undefined;
  return value as unknown as PlanArchivePointer;
}

function isArchiveEnvelope(value: unknown): value is PlanArchiveEnvelope {
  return isRecord(value) && value.schema === ARCHIVE_SCHEMA && value.kind === ARCHIVE_KIND
    && value.encoding === "gzip-base64" && typeof value.planID === "string" && /^[a-f0-9]{32}$/.test(value.planID)
    && typeof value.revision === "string" && /^[a-f0-9]{32}$/.test(value.revision)
    && typeof value.project === "string" && typeof value.phase === "string"
    && TERMINAL_PHASES.has(value.phase as PlanState["phase"])
    && typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest)
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    && typeof value.compressedSha256 === "string" && /^[a-f0-9]{64}$/.test(value.compressedSha256)
    && typeof value.uncompressedBytes === "number" && Number.isInteger(value.uncompressedBytes)
    && value.uncompressedBytes > 0 && value.uncompressedBytes <= MAX_ARCHIVE_BYTES
    && typeof value.payload === "string" && value.payload.length <= MAX_ARCHIVE_BYTES * 2;
}

function archiveMatchesState(archive: PlanArchiveEnvelope, state: PlanState): boolean {
  return archive.planID === state.planID && archive.revision === state.revision
    && archive.project === state.project && archive.phase === state.phase && archive.digest === state.digest;
}

function pointerMatchesState(pointer: PlanArchivePointer, state: PlanState): boolean {
  return pointer.planID === state.planID && pointer.revision === state.revision
    && pointer.project === state.project && pointer.phase === state.phase && pointer.digest === state.digest;
}

function sameRevision(left: PlanState, right: PlanState): boolean {
  return left.planID === right.planID && left.revision === right.revision
    && left.digest === right.digest && left.proof === right.proof && left.phase === right.phase;
}

function planIdentity(state: PlanState): string {
  return `${state.planID}\0${state.revision}\0${state.digest}\0${state.phase}`;
}

function liveStateKeys(state: PlanState): { session: string; plan: string; revision: string } {
  return state.version === 5
    ? {
        session: planKey(state.sessionID),
        plan: planRecordKey(state.planID),
        revision: planRevisionKey(state.planID, state.revision),
      }
    : {
        session: legacyPlanKey(state.sessionID),
        plan: legacyPlanRecordKey(state.planID),
        revision: legacyPlanRevisionKey(state.planID, state.revision),
      };
}

function canonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try { return Buffer.from(value, "base64").toString("base64") === value; }
  catch { return false; }
}

async function safeGet(storage: PlanningRetentionStorage, key: string): Promise<unknown> {
  try { return await storage.get(key); }
  catch { return undefined; }
}

async function strictGet(
  storage: PlanningRetentionStorage,
  key: string,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try { return { ok: true, value: await storage.get(key) }; }
  catch { return { ok: false }; }
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SCAN_LIMIT;
  if (!Number.isInteger(value) || value < 1) return DEFAULT_SCAN_LIMIT;
  return Math.min(value, 5_000);
}

function assertPlanID(value: string): void {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error("ID de plan no evaluable.");
}

function assertRevision(value: string): void {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error("Revision de plan no evaluable.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
