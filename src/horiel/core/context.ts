import { HorielError, invalidInput, storeOperation } from "./errors";
import { nextHorielId } from "./ids";
import type {
  IdempotencyBinding,
  MemoryRecord,
  ScopeInspection,
  ScopeSummary,
  SessionCheckpoint,
} from "./model";
import { searchMemory, type HorielCoreDependencies } from "./memories";
import { newestMemoryFirst, serializedBytes, type RankedMemory } from "./query";
import {
  HORIEL_GLOBAL_SCOPE,
  isScopeWithin,
  parseScopePath,
  projectScope,
  scopeAncestors,
} from "./scopes";
import {
  HORIEL_LIMITS,
  assertSafeContent,
  canonicalHash,
  canonicalTimestamp,
  validateBoundedText,
  validateIdempotencyKey,
  validateSessionRef,
} from "./validation";

export interface GetContextInput {
  scope: string;
  rollup?: boolean;
  includeGlobal?: boolean;
  budgetBytes?: number;
  limit?: number;
}

export interface ContextSections {
  exact: MemoryRecord[];
  ancestors: MemoryRecord[];
  descendants: MemoryRecord[];
  global: MemoryRecord[];
}

export interface ContextBudget {
  limitBytes: number;
  usedBytes: number;
  omittedCount: number;
  omittedByReason: {
    budget: number;
    limit: number;
  };
}

export interface MemoryContextResult {
  checkpoint?: SessionCheckpoint;
  sections: ContextSections;
  budget: ContextBudget;
  storeId: string;
  sequence: number;
}

export interface GetBriefInput extends GetContextInput {
  query: string;
  relatedLimit?: number;
}

export interface MemoryBriefResult extends MemoryContextResult {
  related: RankedMemory[];
}

export interface SaveSessionCheckpointInput {
  scope: string;
  sessionRef: string;
  idempotencyKey: string;
  objective: string;
  implemented: readonly string[];
  verified: readonly string[];
  pending: readonly string[];
  decisions: readonly string[];
  blockers: readonly string[];
  validations: readonly string[];
  nextStep: string;
}

export interface SaveSessionCheckpointResult {
  status: "created" | "replayed";
  checkpoint: SessionCheckpoint;
}

export async function getContext(
  dependencies: HorielCoreDependencies,
  input: GetContextInput,
): Promise<MemoryContextResult> {
  if (!input || typeof input !== "object") return invalidInput("Context request is required.");
  const scope = parseScopePath(input.scope);
  const rollup = input.rollup === true;
  const includeGlobal = input.includeGlobal !== false;
  const budgetBytes = validateBudget(input.budgetBytes ?? 16_000);
  const limit = validateLimit(input.limit ?? HORIEL_LIMITS.pageSize);

  return storeOperation(() => dependencies.store.read(async (transaction) => {
    const [info, candidates, checkpoints] = await Promise.all([
      transaction.getStoreInfo(),
      transaction.listContextCandidates({ scope, rollup, includeGlobal }),
      transaction.listCheckpoints(),
    ]);
    const rawSections: ContextSections = { exact: [], ancestors: [], descendants: [], global: [] };
    const seen = new Set<string>();
    for (const memory of candidates) {
      if (!memory || seen.has(memory.id)) continue;
      const section = contextSection(memory.scope, scope, rollup, includeGlobal);
      if (!section) continue;
      seen.add(memory.id);
      rawSections[section].push(memory);
    }
    for (const section of Object.values(rawSections)) section.sort(newestMemoryFirst);

    const checkpoint = applicableCheckpoint(checkpoints, scope, includeGlobal);
    const sections: ContextSections = { exact: [], ancestors: [], descendants: [], global: [] };
    const budget: ContextBudget = {
      limitBytes: budgetBytes,
      usedBytes: 0,
      omittedCount: 0,
      omittedByReason: { budget: 0, limit: 0 },
    };
    const includedCheckpoint = checkpoint && includeWithinBudget(checkpoint, budget) ? checkpoint : undefined;
    if (checkpoint && !includedCheckpoint) recordOmission(budget, "budget");

    let remainingItems = limit;
    for (const name of ["exact", "ancestors", "descendants", "global"] as const) {
      for (const memory of rawSections[name]) {
        if (remainingItems <= 0) {
          recordOmission(budget, "limit");
          continue;
        }
        if (!includeWithinBudget(memory, budget)) {
          recordOmission(budget, "budget");
          continue;
        }
        sections[name].push(memory);
        remainingItems -= 1;
      }
    }
    return {
      ...(includedCheckpoint ? { checkpoint: includedCheckpoint } : {}),
      sections,
      budget,
      storeId: info.storeId,
      sequence: info.sequence,
    };
  }));
}

export async function getBrief(
  dependencies: HorielCoreDependencies,
  input: GetBriefInput,
): Promise<MemoryBriefResult> {
  const context = await getContext(dependencies, input);
  const relatedLimit = validateLimit(input.relatedLimit ?? 5);
  const scope = parseScopePath(input.scope);
  const searchScope = scope === HORIEL_GLOBAL_SCOPE ? scope : projectScope(scope);
  const search = await searchMemory(dependencies, {
    scope: searchScope,
    query: input.query,
    includeAncestors: false,
    rollup: scope !== HORIEL_GLOBAL_SCOPE,
    includeGlobal: input.includeGlobal !== false,
    limit: Math.min(HORIEL_LIMITS.pageSize, relatedLimit + contextIds(context).size),
  });
  if (search.sequence !== context.sequence) {
    throw new HorielError("conflict", "Context changed while the brief was being assembled.");
  }
  const seen = contextIds(context);
  const related: RankedMemory[] = [];
  const budget = {
    ...context.budget,
    omittedByReason: { ...context.budget.omittedByReason },
  };
  for (const item of search.items) {
    if (seen.has(item.memory.id)) continue;
    if (related.length >= relatedLimit) break;
    if (!includeWithinBudget(item.memory, budget)) {
      recordOmission(budget, "budget");
      continue;
    }
    seen.add(item.memory.id);
    related.push(item);
  }
  return { ...context, related, budget };
}

export async function saveSessionCheckpoint(
  dependencies: HorielCoreDependencies,
  input: SaveSessionCheckpointInput,
): Promise<SaveSessionCheckpointResult> {
  const normalized = validateCheckpointInput(input);
  const requestHash = canonicalHash({
    scope: normalized.scope,
    sessionRef: normalized.sessionRef,
    objective: normalized.objective,
    implemented: normalized.implemented,
    verified: normalized.verified,
    pending: normalized.pending,
    decisions: normalized.decisions,
    blockers: normalized.blockers,
    validations: normalized.validations,
    nextStep: normalized.nextStep,
  });
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    const existing = await transaction.getIdempotencyBinding(normalized.idempotencyKey);
    if (existing) {
      if (existing.operation !== "checkpoint.create" || existing.requestHash !== requestHash) {
        throw new HorielError("conflict", "Idempotency key is already bound to a different request.");
      }
      const checkpoint = await transaction.getCheckpoint(existing.entityId);
      if (!checkpoint) throw new HorielError("integrity_failed", "Idempotent checkpoint result is unavailable.");
      return { status: "replayed", checkpoint };
    }
    const now = canonicalTimestamp(dependencies.clock.now());
    const checkpoint: SessionCheckpoint = {
      id: nextHorielId(dependencies.idFactory, "chk"),
      scope: normalized.scope,
      sessionRef: normalized.sessionRef,
      objective: normalized.objective,
      implemented: [...normalized.implemented],
      verified: [...normalized.verified],
      pending: [...normalized.pending],
      decisions: [...normalized.decisions],
      blockers: [...normalized.blockers],
      validations: [...normalized.validations],
      nextStep: normalized.nextStep,
      createdAt: now,
      version: 1,
    };
    const binding: IdempotencyBinding = {
      key: normalized.idempotencyKey,
      operation: "checkpoint.create",
      requestHash,
      entity: "checkpoint",
      entityId: checkpoint.id,
      entityVersion: 1,
      createdAt: now,
    };
    await transaction.putCheckpoint(checkpoint);
    await transaction.putIdempotencyBinding(binding);
    return { status: "created", checkpoint };
  }));
}

export async function listTree(
  dependencies: HorielCoreDependencies,
  input: { prefix?: string } = {},
): Promise<{ nodes: ScopeSummary[]; storeId: string; sequence: number }> {
  const prefix = input.prefix === undefined ? undefined : parseScopePath(input.prefix);
  return storeOperation(() => dependencies.store.read(async (transaction) => {
    const [info, nodes] = await Promise.all([
      transaction.getStoreInfo(),
      transaction.listScopeSummaries(prefix),
    ]);
    return { nodes, storeId: info.storeId, sequence: info.sequence };
  }));
}

export async function inspectScope(
  dependencies: HorielCoreDependencies,
  input: { scope: string },
): Promise<ScopeInspection> {
  const scope = parseScopePath(input?.scope);
  return storeOperation(() => dependencies.store.read((transaction) => transaction.inspectScope(scope)));
}

function validateCheckpointInput(input: SaveSessionCheckpointInput): SaveSessionCheckpointInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalidInput("Checkpoint input is required.");
  const allowed = new Set<string>([
    "scope", "sessionRef", "idempotencyKey", "objective", "implemented", "verified", "pending",
    "decisions", "blockers", "validations", "nextStep",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return invalidInput("Checkpoint contains unknown fields.");
  const result: SaveSessionCheckpointInput = {
    scope: parseScopePath(input.scope),
    sessionRef: validateSessionRef(input.sessionRef),
    idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
    objective: validateBoundedText(input.objective, "Checkpoint objective", 1, HORIEL_LIMITS.checkpointItemBytes),
    implemented: validateCheckpointList(input.implemented, "implemented"),
    verified: validateCheckpointList(input.verified, "verified"),
    pending: validateCheckpointList(input.pending, "pending"),
    decisions: validateCheckpointList(input.decisions, "decisions"),
    blockers: validateCheckpointList(input.blockers, "blockers"),
    validations: validateCheckpointList(input.validations, "validations"),
    nextStep: validateBoundedText(input.nextStep, "Checkpoint next step", 1, HORIEL_LIMITS.checkpointItemBytes),
  };
  assertSafeContent(JSON.stringify(result));
  return result;
}

function validateCheckpointList(value: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || value.length > HORIEL_LIMITS.checkpointItems) {
    return invalidInput(`Checkpoint ${label} list is invalid.`);
  }
  return value.map((item) => validateBoundedText(item, `Checkpoint ${label} item`, 1, HORIEL_LIMITS.checkpointItemBytes));
}

function validateBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > HORIEL_LIMITS.budgetBytes) {
    return invalidInput("Context budget is invalid.");
  }
  return value;
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > HORIEL_LIMITS.pageSize) {
    return invalidInput("Result limit is invalid.");
  }
  return value;
}

function contextSection(
  candidate: string,
  requested: string,
  rollup: boolean,
  includeGlobal: boolean,
): keyof ContextSections | undefined {
  if (candidate === HORIEL_GLOBAL_SCOPE) return includeGlobal ? "global" : undefined;
  if (requested === HORIEL_GLOBAL_SCOPE) return candidate === requested ? "exact" : undefined;
  if (projectScope(candidate) !== projectScope(requested)) return undefined;
  if (candidate === requested) return "exact";
  if (isScopeWithin(requested, candidate)) return "ancestors";
  if (rollup && isScopeWithin(candidate, requested)) return "descendants";
  return undefined;
}

function applicableCheckpoint(
  checkpoints: readonly SessionCheckpoint[],
  requested: string,
  includeGlobal: boolean,
): SessionCheckpoint | undefined {
  const ancestors = new Map([requested, ...scopeAncestors(requested)].map((scope, index) => [scope, index]));
  return checkpoints
    .filter((checkpoint) => ancestors.has(checkpoint.scope)
      || (includeGlobal && requested !== HORIEL_GLOBAL_SCOPE && checkpoint.scope === HORIEL_GLOBAL_SCOPE))
    .sort((left, right) => {
      const leftDistance = ancestors.get(left.scope) ?? Number.MAX_SAFE_INTEGER;
      const rightDistance = ancestors.get(right.scope) ?? Number.MAX_SAFE_INTEGER;
      return leftDistance - rightDistance
        || Date.parse(right.createdAt) - Date.parse(left.createdAt)
        || left.id.localeCompare(right.id);
    })[0];
}

function includeWithinBudget(value: unknown, budget: ContextBudget): boolean {
  const bytes = serializedBytes(value);
  if (budget.usedBytes + bytes > budget.limitBytes) return false;
  budget.usedBytes += bytes;
  return true;
}

function recordOmission(budget: ContextBudget, reason: keyof ContextBudget["omittedByReason"]): void {
  budget.omittedCount += 1;
  budget.omittedByReason[reason] += 1;
}

function contextIds(context: MemoryContextResult): Set<string> {
  return new Set([
    ...context.sections.exact,
    ...context.sections.ancestors,
    ...context.sections.descendants,
    ...context.sections.global,
  ].map((memory) => memory.id));
}
