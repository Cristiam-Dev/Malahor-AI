import {
  assertSafeContent,
  HORIEL_LIMITS,
  normalizeTags,
  validateBoundedText,
  validateMemoryType,
} from "../core/validation";
import { parseScopePath } from "../core/scopes";
import type {
  MemoryRecord,
  MemoryRelation,
  MemoryRelationType,
  SessionCheckpoint,
} from "../core/model";
import { HORIEL_SQLITE_SCHEMA_VERSION } from "../sqlite/schema";
import { assertSafeSourceFile } from "./boundary";
import { canonicalHash, deterministicId, isCanonicalTimestamp } from "./canonical";
import { migrationFailure } from "./errors";
import { migrationManifestHash, sealMigrationManifest } from "./manifest";
import {
  HORIEL_MIGRATION_FORMAT,
  HORIEL_MIGRATION_MAPPING_VERSION,
  type MigrationInput,
  type MigrationManifestEntry,
  type MigrationMapping,
  type MigrationSourceSnapshot,
  type SourceObservation,
  type SourceSession,
} from "./model";

interface ScopeResolver {
  digest: string;
  aliases: Map<string, string>;
  ambiguous: Set<string>;
}

interface MappedObservation {
  entry: MigrationManifestEntry;
  record?: MemoryRecord;
}

interface MappedSession {
  entry: MigrationManifestEntry;
  record?: SessionCheckpoint;
}

export function createMigrationMapping(
  input: MigrationInput,
  source: MigrationSourceSnapshot,
  existingTarget: boolean,
): MigrationMapping {
  const sourceFingerprint = canonicalHash(source);
  const sourceStats = assertSafeSourceFile(input.source.filePath);
  const sourceIdentityHash = canonicalHash({
    pathHash: canonicalHash(input.source.filePath),
    device: sourceStats.dev,
    inode: sourceStats.ino,
    size: sourceStats.size,
    modifiedMs: sourceStats.mtimeMs,
    changedMs: sourceStats.ctimeMs,
  });
  const resolver = createScopeResolver(input.aliases ?? {});
  const migrationId = canonicalHash({
    sourceFingerprint,
    mappingVersion: HORIEL_MIGRATION_MAPPING_VERSION,
    resolverDigest: resolver.digest,
    targetSchemaVersion: HORIEL_SQLITE_SCHEMA_VERSION,
  });
  const targetStoreId = deterministicId("store", migrationId, "store", "staging");
  const memories: MemoryRecord[] = [];
  const checkpoints: SessionCheckpoint[] = [];
  const pins: MigrationMapping["pins"] = [];
  const relations: MemoryRelation[] = [];
  const entries: MigrationManifestEntry[] = [];
  const memoryByObservationId = new Map<number, string>();

  for (const observation of source.observations) {
    const mapped = mapObservation(observation, migrationId, resolver);
    entries.push(mapped.entry);
    if (mapped.record) {
      memories.push(mapped.record);
      memoryByObservationId.set(observation.id, mapped.record.id);
    }
  }
  for (const session of source.sessions) {
    const mapped = mapSession(session, migrationId, resolver);
    entries.push(mapped.entry);
    if (mapped.record) checkpoints.push(mapped.record);
  }
  for (const pin of source.pins) {
    const sourceDigest = canonicalHash(pin);
    const sourceKey = opaqueSourceKey("pin", pin.stableKey);
    const memoryId = memoryByObservationId.get(pin.observationId);
    if (!memoryId) {
      entries.push(blockedEntry("pin", sourceKey, sourceDigest, "reference-invalid"));
      continue;
    }
    if (!isCanonicalTimestamp(pin.createdAt)) {
      entries.push(blockedEntry("pin", sourceKey, sourceDigest, "timestamp-invalid"));
      continue;
    }
    const target = { memoryId, createdAt: pin.createdAt };
    pins.push(target);
    entries.push(mappedEntry("pin", sourceKey, sourceDigest, memoryId, canonicalHash(target)));
  }
  for (const relation of source.relations) {
    const sourceDigest = canonicalHash(relation);
    const sourceKey = opaqueSourceKey("relation", relation.stableKey);
    const sourceId = memoryByObservationId.get(relation.sourceObservationId);
    const targetId = memoryByObservationId.get(relation.targetObservationId);
    if (!sourceId || !targetId || sourceId === targetId
      || !["supersedes", "conflicts"].includes(relation.kind)) {
      entries.push(blockedEntry("relation", sourceKey, sourceDigest, "reference-invalid"));
      continue;
    }
    if (!isCanonicalTimestamp(relation.createdAt)) {
      entries.push(blockedEntry("relation", sourceKey, sourceDigest, "timestamp-invalid"));
      continue;
    }
    const type: MemoryRelationType = relation.kind === "conflicts" ? "conflicts_with" : "supersedes";
    const id = deterministicId("rel", migrationId, "relation", relation.stableKey);
    const target: MemoryRelation = { id, sourceId, targetId, type, createdAt: relation.createdAt };
    relations.push(target);
    entries.push(mappedEntry(
      "relation",
      sourceKey,
      sourceDigest,
      id,
      canonicalHash(target),
      undefined,
      [relation.kind === "conflicts" ? "conflicts-to-conflicts-with-v1" : "relation-preserved-v1"],
    ));
  }

  for (const scope of source.scopes) {
    let targetScope: string | undefined;
    try {
      targetScope = resolveScope(scope.path, resolver);
    } catch {
      // Entity-level mapping already records invalid scopes. Derived scope state
      // remains known without manufacturing a target scope.
    }
    entries.push({
      kind: "scope",
      status: "derived",
      sourceKey: opaqueSourceKey("scope", scope.path),
      sourceDigest: canonicalHash(scope),
      ...(targetScope === undefined ? {} : { targetScope }),
      transformations: ["scope-tree-derived-v1"],
    });
  }
  entries.push({
    kind: "fts",
    status: "derived",
    sourceKey: "derived:fts",
    sourceDigest: canonicalHash({ backend: source.backend, kind: "fts" }),
    transformations: ["fts-rebuild-v1"],
  });
  entries.push({
    kind: "counter",
    status: "derived",
    sourceKey: "derived:counter",
    sourceDigest: canonicalHash(source.state),
    transformations: ["source-counters-to-horiel-sequence-v1"],
  });
  if (existingTarget) {
    entries.push(blockedEntry(
      "target",
      "target:intent",
      canonicalHash({ exists: true }),
      "target-exists",
    ));
  }

  assertUniqueTargets(memories, checkpoints, relations);
  const counts = {
    source: {
      observations: source.observations.length,
      sessions: source.sessions.length,
      pins: source.pins.length,
      relations: source.relations.length,
    },
    target: {
      memories: memories.length,
      checkpoints: checkpoints.length,
      pins: pins.length,
      relations: relations.length,
    },
    mapped: entries.filter(({ status }) => status === "mapped").length,
    derived: entries.filter(({ status }) => status === "derived").length,
    blocked: entries.filter(({ status }) => status === "blocked").length,
  };
  const installationHash = canonicalHash(input.installationId);
  const approvalHash = canonicalHash({
    migrationId,
    installationHash,
    sourceFingerprint,
    sourceIdentityHash,
    resolverDigest: resolver.digest,
    targetIntent: canonicalHash(input.targetDirectory),
    entries,
    counts,
  });
  const manifest = sealMigrationManifest({
    format: HORIEL_MIGRATION_FORMAT,
    mappingVersion: HORIEL_MIGRATION_MAPPING_VERSION,
    migrationId,
    installationHash,
    backend: source.backend,
    sourceFingerprint,
    sourceIdentityHash,
    resolverDigest: resolver.digest,
    targetSchemaVersion: HORIEL_SQLITE_SCHEMA_VERSION,
    approvalHash,
    revisionHash: "",
    state: "previewed",
    entries,
    counts,
  });
  const timestamps = [
    ...memories.map(({ createdAt }) => createdAt),
    ...checkpoints.map(({ createdAt }) => createdAt),
  ].sort();
  return {
    source,
    sourceFingerprint,
    manifest,
    manifestHash: migrationManifestHash(manifest),
    targetStoreId,
    storeCreatedAt: timestamps[0] ?? "1970-01-01T00:00:00.000Z",
    memories,
    checkpoints,
    pins,
    relations,
  };
}

function mapObservation(
  observation: SourceObservation,
  migrationId: string,
  resolver: ScopeResolver,
): MappedObservation {
  const sourceDigest = canonicalHash(observation);
  const sourceKey = opaqueSourceKey("observation", observation.stableKey);
  let scope: string;
  try {
    scope = resolveScope(observation.scope, resolver);
  } catch {
    return { entry: blockedEntry("observation", sourceKey, sourceDigest, "scope-invalid") };
  }
  if (!isCanonicalTimestamp(observation.createdAt)) {
    return { entry: blockedEntry("observation", sourceKey, sourceDigest, "timestamp-invalid") };
  }
  try {
    validateMemoryType(observation.type);
  } catch {
    return { entry: blockedEntry("observation", sourceKey, sourceDigest, "type-invalid") };
  }
  try {
    validateBoundedText(
      observation.title,
      "Memory title",
      1,
      HORIEL_LIMITS.titleBytes,
      HORIEL_LIMITS.titleCharacters,
    );
  } catch {
    return { entry: blockedEntry("observation", sourceKey, sourceDigest, "title-invalid") };
  }
  try {
    validateBoundedText(observation.content, "Memory content", 1, HORIEL_LIMITS.contentBytes);
  } catch {
    return { entry: blockedEntry("observation", sourceKey, sourceDigest, "content-invalid") };
  }
  try {
    assertSafeContent(`${observation.title}\n${observation.content}`);
  } catch {
    return {
      entry: blockedEntry(
        "observation",
        sourceKey,
        sourceDigest,
        "sensitive-content",
        canonicalHash({ sourceDigest, finding: "known-credential-shape" }),
      ),
    };
  }
  let tags: string[];
  try {
    tags = observation.tags === "" ? [] : normalizeTags([observation.tags]);
  } catch {
    return { entry: blockedEntry("observation", sourceKey, sourceDigest, "tag-invalid") };
  }
  const id = deterministicId("mem", migrationId, "observation", observation.stableKey);
  const record: MemoryRecord = {
    id,
    scope,
    type: observation.type,
    title: observation.title,
    content: observation.content,
    tags,
    createdAt: observation.createdAt,
    updatedAt: observation.createdAt,
    version: 1,
    provenance: {
      source: "mnemo-migration-v1",
      externalRef: sourceKey,
    },
  };
  return {
    record,
    entry: mappedEntry(
      "observation",
      sourceKey,
      sourceDigest,
      id,
      canonicalHash(record),
      scope,
      observation.tags === ""
        ? ["empty-tag-to-array-v1"]
        : ["opaque-tag-normalization-v1"],
    ),
  };
}

function mapSession(
  session: SourceSession,
  migrationId: string,
  resolver: ScopeResolver,
): MappedSession {
  const sourceDigest = canonicalHash(session);
  const sourceKey = opaqueSourceKey("session", session.stableKey);
  let scope: string;
  try {
    scope = resolveScope(session.scope, resolver);
  } catch {
    return { entry: blockedEntry("session", sourceKey, sourceDigest, "scope-invalid") };
  }
  if (!isCanonicalTimestamp(session.createdAt)) {
    return { entry: blockedEntry("session", sourceKey, sourceDigest, "timestamp-invalid") };
  }
  try {
    validateBoundedText(
      session.summary,
      "Checkpoint objective",
      1,
      HORIEL_LIMITS.checkpointItemBytes,
    );
  } catch {
    return { entry: blockedEntry("session", sourceKey, sourceDigest, "summary-invalid") };
  }
  try {
    assertSafeContent(session.summary);
  } catch {
    return {
      entry: blockedEntry(
        "session",
        sourceKey,
        sourceDigest,
        "sensitive-content",
        canonicalHash({ sourceDigest, finding: "known-credential-shape" }),
      ),
    };
  }
  const id = deterministicId("chk", migrationId, "session", session.stableKey);
  const record: SessionCheckpoint = {
    id,
    scope,
    sessionRef: `mnemo:${canonicalHash(session.stableKey).slice(0, 32)}`,
    objective: session.summary,
    implemented: [],
    verified: [],
    pending: [],
    decisions: [],
    blockers: [],
    validations: [],
    nextStep: "Review imported Mnemo session summary.",
    createdAt: session.createdAt,
    version: 1,
  };
  return {
    record,
    entry: mappedEntry(
      "session",
      sourceKey,
      sourceDigest,
      id,
      canonicalHash(record),
      scope,
      ["mnemo-summary-to-checkpoint-v1"],
    ),
  };
}

function createScopeResolver(aliases: Record<string, string[]>): ScopeResolver {
  const aliasMap = new Map<string, string>();
  const ambiguous = new Set<string>();
  const normalized: Record<string, string[]> = {};
  for (const [project, values] of Object.entries(aliases).sort(([left], [right]) => left.localeCompare(right))) {
    const canonicalProject = normalizeSegment(project);
    const candidates = [project, ...values];
    normalized[canonicalProject] = candidates.map(aliasKey).sort();
    for (const candidate of candidates) {
      const key = aliasKey(candidate);
      const existing = aliasMap.get(key);
      if (existing && existing !== canonicalProject) ambiguous.add(key);
      else aliasMap.set(key, canonicalProject);
    }
  }
  return { digest: canonicalHash(normalized), aliases: aliasMap, ambiguous };
}

function resolveScope(value: string, resolver: ScopeResolver): string {
  if (value === "global") return "@global";
  if (typeof value !== "string" || value !== value.normalize("NFC") || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)) {
    return migrationFailure("invalid_input", "Source scope is invalid.");
  }
  const rawSegments = value.split("/");
  if (rawSegments.some((segment) => !segment || segment.trim() !== segment)) {
    return migrationFailure("invalid_input", "Source scope is invalid.");
  }
  const firstKey = aliasKey(rawSegments[0]!);
  if (resolver.ambiguous.has(firstKey)) {
    return migrationFailure("invalid_input", "Source scope aliases are ambiguous.");
  }
  const first = resolver.aliases.get(firstKey) ?? normalizeSegment(rawSegments[0]!);
  return parseScopePath([first, ...rawSegments.slice(1).map(normalizeSegment)].join("/"));
}

function normalizeSegment(value: string): string {
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, "-");
  if (!normalized || normalized === "." || normalized === ".." || normalized.includes("/")
    || normalized.includes("\\") || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return migrationFailure("invalid_input", "Source scope segment is invalid.");
  }
  return normalized;
}

function aliasKey(value: string): string {
  if (typeof value !== "string") return migrationFailure("invalid_input", "Source scope alias is invalid.");
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function opaqueSourceKey(kind: string, stableKey: string): string {
  return `${kind}:${canonicalHash(stableKey).slice(0, 24)}`;
}

function mappedEntry(
  kind: string,
  sourceKey: string,
  sourceDigest: string,
  targetId: string,
  targetDigest: string,
  targetScope?: string,
  transformations: string[] = [],
): MigrationManifestEntry {
  return {
    kind,
    status: "mapped",
    sourceKey,
    sourceDigest,
    targetId,
    targetDigest,
    ...(targetScope === undefined ? {} : { targetScope }),
    transformations,
  };
}

function blockedEntry(
  kind: string,
  sourceKey: string,
  sourceDigest: string,
  code: string,
  findingHash?: string,
): MigrationManifestEntry {
  return {
    kind,
    status: "blocked",
    sourceKey,
    sourceDigest,
    transformations: [],
    block: { code, ...(findingHash === undefined ? {} : { findingHash }) },
  };
}

function assertUniqueTargets(
  memories: MemoryRecord[],
  checkpoints: SessionCheckpoint[],
  relations: MemoryRelation[],
): void {
  const values = [
    ...memories.map(({ id }) => id),
    ...checkpoints.map(({ id }) => id),
    ...relations.map(({ id }) => id),
  ];
  if (new Set(values).size !== values.length) {
    return migrationFailure("integrity_failed", "Horiel migration identity collision was detected.");
  }
}
