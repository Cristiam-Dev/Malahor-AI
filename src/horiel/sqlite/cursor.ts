import { createHash } from "node:crypto";

import { HorielError } from "../core/errors";
import { HORIEL_RANKING_VERSION } from "../core/query";
import type { StoreSearchRequest } from "../core/store";

export type SearchRankTuple = readonly [
  scopePriority: number,
  scopeDistance: number,
  pinned: number,
  textScore: number,
  updatedAt: string,
  relationCount: number,
  memoryId: string,
];

interface CursorPayload {
  version: 1;
  rankingVersion: number;
  storeId: string;
  sequence: number;
  requestHash: string;
  after: SearchRankTuple;
}

interface CursorEnvelope {
  payload: CursorPayload;
  checksum: string;
}

export function searchRequestHash(request: StoreSearchRequest): string {
  return hash(stableSerialize({
    rankingVersion: HORIEL_RANKING_VERSION,
    scope: request.scope,
    terms: request.terms,
    includeAncestors: request.includeAncestors,
    rollup: request.rollup,
    includeGlobal: request.includeGlobal,
    types: request.types ?? [],
    tags: request.tags ?? [],
    limit: request.limit,
  }));
}

export function encodeSearchCursor(input: {
  storeId: string;
  sequence: number;
  request: StoreSearchRequest;
  after: SearchRankTuple;
}): string {
  const payload: CursorPayload = {
    version: 1,
    rankingVersion: HORIEL_RANKING_VERSION,
    storeId: input.storeId,
    sequence: input.sequence,
    requestHash: searchRequestHash(input.request),
    after: input.after,
  };
  const envelope: CursorEnvelope = {
    payload,
    checksum: hash(stableSerialize(payload)),
  };
  return Buffer.from(stableSerialize(envelope), "utf8").toString("base64url");
}

export function decodeSearchCursor(input: {
  cursor: string;
  storeId: string;
  sequence: number;
  request: StoreSearchRequest;
}): SearchRankTuple {
  if (typeof input.cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.cursor)
    || input.cursor.length > 4096) {
    throw new HorielError("invalid_input", "Horiel search cursor is invalid.");
  }
  let envelope: CursorEnvelope;
  try {
    const bytes = Buffer.from(input.cursor, "base64url");
    if (bytes.toString("base64url") !== input.cursor) {
      throw new Error("non-canonical base64url");
    }
    envelope = JSON.parse(bytes.toString("utf8")) as CursorEnvelope;
  } catch {
    throw new HorielError("invalid_input", "Horiel search cursor is invalid.");
  }
  if (!envelope || typeof envelope !== "object" || !validPayload(envelope.payload)
    || typeof envelope.checksum !== "string"
    || envelope.checksum !== hash(stableSerialize(envelope.payload))) {
    throw new HorielError("invalid_input", "Horiel search cursor is invalid.");
  }
  const payload = envelope.payload;
  if (payload.storeId !== input.storeId || payload.sequence !== input.sequence
    || payload.rankingVersion !== HORIEL_RANKING_VERSION
    || payload.requestHash !== searchRequestHash(input.request)) {
    throw new HorielError("conflict", "Horiel search cursor no longer matches the request revision.");
  }
  return payload.after;
}

export function compareRankTuples(left: SearchRankTuple, right: SearchRankTuple): number {
  if (left[0] !== right[0]) return right[0] - left[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  if (left[2] !== right[2]) return right[2] - left[2];
  if (left[3] !== right[3]) return right[3] - left[3];
  if (left[4] !== right[4]) return right[4].localeCompare(left[4]);
  if (left[5] !== right[5]) return right[5] - left[5];
  return left[6].localeCompare(right[6]);
}

function validPayload(value: unknown): value is CursorPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<CursorPayload>;
  return payload.version === 1
    && payload.rankingVersion === HORIEL_RANKING_VERSION
    && typeof payload.storeId === "string"
    && /^store_[a-f0-9]{32}$/.test(payload.storeId)
    && Number.isSafeInteger(payload.sequence) && (payload.sequence ?? -1) >= 0
    && typeof payload.requestHash === "string" && /^[a-f0-9]{64}$/.test(payload.requestHash)
    && validRankTuple(payload.after);
}

function validRankTuple(value: unknown): value is SearchRankTuple {
  return Array.isArray(value) && value.length === 7
    && Number.isInteger(value[0]) && value[0] >= 1 && value[0] <= 4
    && Number.isSafeInteger(value[1]) && value[1] >= 0
    && (value[2] === 0 || value[2] === 1)
    && Number.isInteger(value[3]) && value[3] >= 1 && value[3] <= 1000
    && typeof value[4] === "string" && Number.isFinite(Date.parse(value[4]))
    && Number.isInteger(value[5]) && value[5] >= 0 && value[5] <= 100
    && typeof value[6] === "string" && /^mem_[a-f0-9]{32}$/.test(value[6]);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HorielError("invalid_input", "Cursor contains an invalid number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`
    )).join(",")}}`;
  }
  throw new HorielError("invalid_input", "Cursor contains an unsupported value.");
}
