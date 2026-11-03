import { createHash, randomBytes } from "node:crypto";

export interface ExecutionGuardStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ExecutionPlanRef {
  planID: string;
  revision: string;
  digest: string;
  phase: "running" | "blocked";
  actionIDs: string[];
}

export interface AttemptRecord {
  attemptID: string;
  actionID: string;
  actionIDs?: string[];
  ordinal: number;
  decisionCode: string;
  canonicalInputHash: string;
  resultClass: string;
  exitCode?: number;
  errorHash?: string;
  resourceDigests?: { before: string[]; after: string[] };
  durationMs?: number;
  inputBytes?: number;
  outputBytes?: number;
  repair?: {
    kind: "git-stage-manifest";
    repairedActionID: string;
    manifestHash: string;
    relation: "equal" | "narrower";
  };
  recordedAt: number;
}

export interface ExecutionGuardResult {
  decision: "continue" | "retry" | "block" | "discard";
  code: string;
  retryAllowed: boolean;
  requiresPlanRevision?: boolean;
  attempt?: AttemptRecord;
}

export interface ExecutionGuardSnapshot {
  plan: { planID: string; revision: string; digest: string; phase: "running" | "blocked" };
  attempts: AttemptRecord[];
  counters: { modelCalls: number; planRevisions: number; loopBlocks: number };
}

export interface ExecutionGuard {
  inspectAdapterRepair(input: Record<string, unknown>): Promise<ExecutionGuardResult>;
  recordAttempt(input: Record<string, unknown>): Promise<ExecutionGuardResult>;
  snapshot(): Promise<ExecutionGuardSnapshot>;
}

interface PersistedGuardState extends ExecutionGuardSnapshot {
  schema: 1;
  kind: "malahor.execution-attempts";
  ordinals: Record<string, number>;
  declaredActionIDs: string[];
  lastFailureSignature?: string;
  failureSignatures: Record<string, string>;
  failureResources: Record<string, string[]>;
  repairs: string[];
}

interface AdapterRepair {
  equivalent: true;
  kind: "git-stage-manifest";
  sourceActionID: string;
  repairedActionID: string;
  repairedInputHash: string;
  manifestHash: string;
  relation: "equal" | "narrower";
}

export function createExecutionGuard(input: Record<string, unknown>): ExecutionGuard {
  const plan = parsePlan(input.plan);
  const storage = isStorage(input.storage) ? input.storage : undefined;
  const now = typeof input.now === "function" ? input.now as () => number : Date.now;
  const key = `planning/v5/attempts/${plan.planID}/${plan.revision}`;
  let queue = Promise.resolve();
  let loaded: PersistedGuardState | undefined;

  const withState = async <T>(operation: (state: PersistedGuardState) => Promise<T> | T): Promise<T> => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!loaded) loaded = await loadState(storage, key, plan);
      const result = await operation(loaded);
      if (storage) await storage.set(key, structuredClone(loaded));
      return result;
    } finally {
      release();
    }
  };

  return {
    inspectAdapterRepair: (repair) => withState((state) => inspectRepair(state, repair)),
    recordAttempt: (attempt) => withState((state) => record(state, attempt, now)),
    snapshot: () => withState((state) => snapshotOf(state)),
  };
}

function inspectRepair(state: PersistedGuardState, input: Record<string, unknown>): ExecutionGuardResult {
  const actionIDs = attemptActionIDs(input);
  if (actionIDs.length !== 1 || !state.declaredActionIDs.includes(actionIDs[0]!)) {
    return { decision: "block", code: "ACTION_NOT_DECLARED", retryAllowed: false, requiresPlanRevision: true };
  }
  const repair = parseAdapterRepair(input.adapterRepair);
  if (!repair) return { decision: "block", code: "ADAPTER_REPAIR_EXHAUSTED", retryAllowed: false };
  if (repair.sourceActionID !== actionIDs[0]) {
    return { decision: "block", code: "ACTION_NOT_DECLARED", retryAllowed: false, requiresPlanRevision: true };
  }
  if (state.repairs.includes(adapterRepairKey(actionIDs[0]!, repair))) {
    return { decision: "block", code: "ADAPTER_REPAIR_EXHAUSTED", retryAllowed: false };
  }
  return { decision: "retry", code: "ADAPTER_REPAIR_AVAILABLE", retryAllowed: true };
}

function record(
  state: PersistedGuardState,
  input: Record<string, unknown>,
  now: () => number,
): ExecutionGuardResult {
  const actionIDs = attemptActionIDs(input);
  if (actionIDs.length === 0 || actionIDs.some((actionID) => !state.declaredActionIDs.includes(actionID))) {
    if (input.optional === true && input.source === "diagnostic") {
      return {
        decision: "discard",
        code: "ACTION_NOT_DECLARED",
        retryAllowed: false,
        requiresPlanRevision: false,
      };
    }
    return {
      decision: "block",
      code: "ACTION_NOT_DECLARED",
      retryAllowed: false,
      requiresPlanRevision: true,
    };
  }

  const primary = actionIDs[0]!;
  const repair = parseAdapterRepair(input.adapterRepair);
  if (repair && repair.sourceActionID !== primary) {
    return { decision: "block", code: "ACTION_NOT_DECLARED", retryAllowed: false, requiresPlanRevision: true };
  }
  const ordinal = (state.ordinals[primary] ?? 0) + 1;
  state.ordinals[primary] = ordinal;
  const result = isRecord(input.result) ? input.result : {};
  const resultClass = safeLabel(result.class, "not-run");
  const decisionCode = safeLabel(input.decisionCode, "UNKNOWN");
  const canonicalInputHash = safeHashRef(input.canonicalInputHash, "sha256:unavailable");
  const candidateNow = now();
  const recordedAt = finiteNonNegative(candidateNow) ? candidateNow : Date.now();
  const attempt: AttemptRecord = {
    attemptID: attemptID(state, actionIDs, ordinal, canonicalInputHash, recordedAt),
    actionID: primary,
    ...(actionIDs.length > 1 ? { actionIDs: [...actionIDs] } : {}),
    ordinal,
    decisionCode,
    canonicalInputHash,
    resultClass,
    ...(integer(result.exitCode) ? { exitCode: result.exitCode as number } : {}),
    ...(typeof result.errorHash === "string" ? { errorHash: safeHashRef(result.errorHash, "sha256:unavailable") } : {}),
    ...attemptMetrics(input),
    ...(repair ? { repair: {
      kind: repair.kind,
      repairedActionID: repair.repairedActionID,
      manifestHash: repair.manifestHash,
      relation: repair.relation,
    } } : {}),
    recordedAt,
  };
  state.attempts.push(attempt);

  if (decisionCode === "HOST_ASK" || decisionCode === "HOST_DENY") {
    delete state.failureSignatures[primary];
    delete state.failureResources[primary];
    state.lastFailureSignature = undefined;
    return { decision: "block", code: decisionCode, retryAllowed: false, attempt };
  }

  if (decisionCode === "ACTION_SERIALIZATION_MISMATCH") {
    const repairKey = repair && adapterRepairKey(primary, repair);
    if (repairKey && !state.repairs.includes(repairKey)) {
      state.repairs.push(repairKey);
      return { decision: "retry", code: "ADAPTER_REPAIR_APPLIED", retryAllowed: true, attempt };
    }
    return { decision: "block", code: "ADAPTER_REPAIR_EXHAUSTED", retryAllowed: false, attempt };
  }

  if (resultClass === "success") {
    clearFailuresAfterProgress(state, attempt.resourceDigests);
    return { decision: "continue", code: "AUTHORIZED", retryAllowed: false, attempt };
  }

  if (resultClass === "failure") {
    const signature = failureSignature(actionIDs, attempt);
    if (state.failureSignatures[primary] === signature) {
      state.counters.loopBlocks += 1;
      return {
        decision: "block",
        code: "LOOP_GUARD_STALLED",
        retryAllowed: false,
        requiresPlanRevision: false,
        attempt,
      };
    }
    state.failureSignatures[primary] = signature;
    state.failureResources[primary] = attempt.resourceDigests?.after.length
      ? [...attempt.resourceDigests.after]
      : [...attempt.resourceDigests?.before ?? []];
    state.lastFailureSignature = signature;
    return { decision: "retry", code: "TECHNICAL_RETRY", retryAllowed: true, attempt };
  }

  if (decisionCode !== "AUTHORIZED") {
    return { decision: "block", code: decisionCode, retryAllowed: false, attempt };
  }
  return { decision: "continue", code: "AUTHORIZED", retryAllowed: false, attempt };
}

function attemptMetrics(input: Record<string, unknown>): Partial<AttemptRecord> {
  const resourceDigests = isRecord(input.resourceDigests) ? input.resourceDigests : undefined;
  const before = stringList(resourceDigests?.before).map((value) => safeHashRef(value, "sha256:unavailable"));
  const after = stringList(resourceDigests?.after).map((value) => safeHashRef(value, "sha256:unavailable"));
  return {
    ...(before.length || after.length ? { resourceDigests: { before, after } } : {}),
    ...(finiteNonNegative(input.durationMs) ? { durationMs: input.durationMs as number } : {}),
    ...(finiteNonNegative(input.inputBytes) ? { inputBytes: input.inputBytes as number } : {}),
    ...(finiteNonNegative(input.outputBytes) ? { outputBytes: input.outputBytes as number } : {}),
  };
}

function parsePlan(value: unknown): ExecutionPlanRef {
  if (!isRecord(value) || typeof value.planID !== "string" || !/^[a-f0-9]{32}$/.test(value.planID)
    || typeof value.revision !== "string" || !/^[a-f0-9]{32}$/.test(value.revision)
    || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
    || value.phase !== "running" || !Array.isArray(value.actionIDs)
    || value.actionIDs.length === 0
    || value.actionIDs.some((actionID) => typeof actionID !== "string" || !/^[a-f0-9]{64}$/.test(actionID))) {
    throw new Error("Plan de execution guard no evaluable.");
  }
  return {
    planID: value.planID,
    revision: value.revision,
    digest: value.digest,
    phase: "running",
    actionIDs: [...new Set(value.actionIDs as string[])],
  };
}

async function loadState(
  storage: ExecutionGuardStorage | undefined,
  key: string,
  plan: ExecutionPlanRef,
): Promise<PersistedGuardState> {
  if (storage) {
    const existing = await storage.get(key);
    if (validPersisted(existing, plan)) {
      const migrated = structuredClone(existing) as PersistedGuardState;
      migrated.failureSignatures ??= {};
      migrated.failureResources ??= {};
      if (migrated.lastFailureSignature && Object.keys(migrated.failureSignatures).length === 0) {
        const last = migrated.attempts.at(-1);
        if (last) {
          migrated.failureSignatures[last.actionID] = migrated.lastFailureSignature;
          migrated.failureResources[last.actionID] = [
            ...(last.resourceDigests?.after.length ? last.resourceDigests.after : last.resourceDigests?.before ?? []),
          ];
        }
      }
      return migrated;
    }
    if (existing !== undefined) throw new Error("Ledger de intentos existente no verificable.");
  }
  return {
    schema: 1,
    kind: "malahor.execution-attempts",
    plan: { planID: plan.planID, revision: plan.revision, digest: plan.digest, phase: "running" },
    attempts: [],
    counters: { modelCalls: 0, planRevisions: 0, loopBlocks: 0 },
    ordinals: {},
    declaredActionIDs: [...plan.actionIDs],
    failureSignatures: {},
    failureResources: {},
    repairs: [],
  };
}

function validPersisted(value: unknown, plan: ExecutionPlanRef): value is PersistedGuardState {
  if (!isRecord(value) || value.schema !== 1 || value.kind !== "malahor.execution-attempts"
    || !isRecord(value.plan) || value.plan.planID !== plan.planID || value.plan.revision !== plan.revision
    || value.plan.digest !== plan.digest || (value.plan.phase !== "running" && value.plan.phase !== "blocked")
    || !Array.isArray(value.attempts) || !isRecord(value.counters) || !isRecord(value.ordinals)
    || !Array.isArray(value.declaredActionIDs) || !Array.isArray(value.repairs)
    || (value.failureSignatures !== undefined && !isRecord(value.failureSignatures))
    || (value.failureResources !== undefined && !isRecord(value.failureResources))) return false;
  return (value.declaredActionIDs as unknown[]).every((item) => typeof item === "string" && plan.actionIDs.includes(item));
}

function clearFailuresAfterProgress(
  state: PersistedGuardState,
  digests: AttemptRecord["resourceDigests"],
): void {
  if (!digests || digests.before.length === 0 || sameStrings(digests.before, digests.after)) return;
  const changed = new Set(digests.before);
  for (const [actionID, resources] of Object.entries(state.failureResources)) {
    if (!resources.some((resource) => changed.has(resource))) continue;
    delete state.failureResources[actionID];
    delete state.failureSignatures[actionID];
  }
  state.lastFailureSignature = undefined;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function snapshotOf(state: PersistedGuardState): ExecutionGuardSnapshot {
  return structuredClone({ plan: state.plan, attempts: state.attempts, counters: state.counters });
}

function attemptActionIDs(input: Record<string, unknown>): string[] {
  const ids = Array.isArray(input.actionIDs) ? input.actionIDs : [input.actionID];
  if (ids.some((item) => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item))) return [];
  return ids as string[];
}

function parseAdapterRepair(value: unknown): AdapterRepair | undefined {
  if (!isRecord(value) || value.equivalent !== true || value.kind !== "git-stage-manifest"
    || typeof value.sourceActionID !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceActionID)
    || typeof value.repairedActionID !== "string" || !/^[a-f0-9]{64}$/.test(value.repairedActionID)
    || typeof value.repairedInputHash !== "string" || value.repairedInputHash.length > 256
    || typeof value.manifestHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.manifestHash)
    || (value.relation !== "equal" && value.relation !== "narrower")) return undefined;
  return {
    equivalent: true,
    kind: "git-stage-manifest",
    sourceActionID: value.sourceActionID,
    repairedActionID: value.repairedActionID,
    repairedInputHash: safeHashRef(value.repairedInputHash, "sha256:unavailable"),
    manifestHash: value.manifestHash,
    relation: value.relation,
  };
}

function adapterRepairKey(actionID: string, repair: AdapterRepair): string {
  return [actionID, repair.repairedActionID, repair.repairedInputHash, repair.manifestHash, repair.relation].join("\0");
}

function failureSignature(actionIDs: string[], attempt: AttemptRecord): string {
  return createHash("sha256").update(JSON.stringify({
    actionIDs,
    canonicalInputHash: attempt.canonicalInputHash,
    resultClass: attempt.resultClass,
    exitCode: attempt.exitCode,
    errorHash: attempt.errorHash,
    resourceDigests: attempt.resourceDigests,
  })).digest("hex");
}

function attemptID(
  state: PersistedGuardState,
  actionIDs: string[],
  ordinal: number,
  inputHash: string,
  recordedAt: number,
): string {
  return `att_${createHash("sha256").update(JSON.stringify({
    planID: state.plan.planID,
    revision: state.plan.revision,
    actionIDs,
    ordinal,
    inputHash,
    recordedAt,
    nonce: randomBytes(8).toString("hex"),
  })).digest("hex").slice(0, 24)}`;
}

function safeHashRef(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 256 || /[\u0000\r\n]/u.test(value)) return fallback;
  return value;
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function integer(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

function finiteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStorage(value: unknown): value is ExecutionGuardStorage {
  return isRecord(value) && typeof value.get === "function" && typeof value.set === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
