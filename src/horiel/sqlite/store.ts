import fs from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { HorielError } from "../core/errors";
import { assertHorielId } from "../core/ids";
import {
  type HorielSnapshotDescriptor,
  type IdempotencyBinding,
  type MemoryRecord,
  type MemoryRelation,
  type MemoryRelationType,
  type ScopeInspection,
  type ScopeSummary,
  type SessionCheckpoint,
  type StoredPreview,
} from "../core/model";
import {
  HORIEL_GLOBAL_SCOPE,
  classifyScope,
  isScopeWithin,
  parseScopePath,
  projectScope,
} from "../core/scopes";
import type {
  HorielReadTransaction,
  HorielStore,
  HorielWriteTransaction,
  MaybePromise,
  StoreContextRequest,
  StoreInfo,
  StoreRestoreRequest,
  StoreSearchPage,
  StoreSearchRequest,
} from "../core/store";
import { normalizeTags, validateMemoryType, validateProvenance } from "../core/validation";
import {
  type OpenHorielSqliteInput,
  type OpenedHorielDatabase,
  normalizeSqliteError,
  openHorielDatabase,
  reopenHorielDatabase,
} from "./database";
import {
  rebuildFtsIndex,
  verifyCanonicalIntegrity,
  verifyFtsIntegrity,
} from "./schema";
import { searchSqliteCandidates } from "./search";
import {
  createPhysicalSnapshot,
  inspectPhysicalSnapshot,
  prepareRestoreStaging,
} from "./snapshots";

interface MutationState {
  changed: boolean;
}

type SqlRow = Record<string, unknown>;

export interface HorielSqliteStore extends HorielStore {
  verifyIntegrity(): Promise<void>;
  rebuildSearchIndex(): Promise<void>;
  close(): Promise<void>;
}

export async function openHorielSqliteStore(
  input: OpenHorielSqliteInput,
): Promise<HorielSqliteStore> {
  return new HorielSqliteStoreImpl(openHorielDatabase(input));
}

class HorielSqliteStoreImpl implements HorielSqliteStore {
  private opened: OpenedHorielDatabase;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(opened: OpenedHorielDatabase) {
    this.opened = opened;
  }

  read<T>(callback: (transaction: HorielReadTransaction) => MaybePromise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.assertOpen();
      return await callback(this.readTransaction(this.opened.database));
    });
  }

  write<T>(callback: (transaction: HorielWriteTransaction) => MaybePromise<T>): Promise<T> {
    if (this.opened.access === "read") {
      return Promise.reject(new HorielError("unavailable", "Horiel SQLite store is read-only."));
    }
    return this.enqueue(() => this.performWrite(callback));
  }

  createSnapshot(input: { id: string; createdAt: string }): Promise<HorielSnapshotDescriptor> {
    if (this.opened.access === "read") {
      return Promise.reject(new HorielError("unavailable", "Horiel SQLite store is read-only."));
    }
    return this.enqueue(async () => {
      this.assertOpen();
      return await createPhysicalSnapshot({
        database: this.opened.database,
        snapshotDirectory: this.opened.snapshotDirectory,
        id: input.id,
        createdAt: input.createdAt,
      });
    });
  }

  inspectSnapshot(snapshotId: string): Promise<HorielSnapshotDescriptor | undefined> {
    return this.enqueue(async () => {
      this.assertOpen();
      return inspectPhysicalSnapshot(this.opened.snapshotDirectory, snapshotId);
    });
  }

  restoreSnapshot(input: StoreRestoreRequest): Promise<HorielSnapshotDescriptor> {
    if (this.opened.access === "read") {
      return Promise.reject(new HorielError("unavailable", "Horiel SQLite store is read-only."));
    }
    return this.enqueue(() => this.performRestore(input));
  }

  verifyIntegrity(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      try {
        verifyCanonicalIntegrity(this.opened.database);
        if (this.opened.access !== "read") verifyFtsIntegrity(this.opened.database);
      } catch (error) {
        throw normalizeSqliteError(error, "integrity_failed");
      }
    });
  }

  rebuildSearchIndex(): Promise<void> {
    if (this.opened.access === "read") {
      return Promise.reject(new HorielError("unavailable", "Horiel SQLite store is read-only."));
    }
    return this.enqueue(async () => {
      this.assertOpen();
      try {
        this.opened.database.exec("BEGIN IMMEDIATE");
        rebuildFtsIndex(this.opened.database);
        this.opened.database.exec("COMMIT");
      } catch (error) {
        try {
          if (this.opened.database.isTransaction) this.opened.database.exec("ROLLBACK");
        } catch {
          // The rebuild failure remains authoritative.
        }
        throw normalizeSqliteError(error, "integrity_failed");
      }
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.enqueue(async () => {
      if (this.closed) return;
      this.opened.database.close();
      this.closed = true;
    });
  }

  private async performWrite<T>(
    callback: (transaction: HorielWriteTransaction) => MaybePromise<T>,
  ): Promise<T> {
    this.assertOpen();
    const database = this.opened.database;
    try {
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw normalizeSqliteError(error);
    }
    const mutation: MutationState = { changed: false };
    let result: T;
    try {
      result = await callback(this.writeTransaction(database, mutation));
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
    try {
      if (mutation.changed) {
        database.prepare(`
          UPDATE horiel_store
             SET sequence = sequence + 1, updated_at = ?
           WHERE singleton = 1
        `).run(new Date().toISOString());
      }
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackQuietly(database);
      throw normalizeSqliteError(error);
    }
  }

  private async performRestore(input: StoreRestoreRequest): Promise<HorielSnapshotDescriptor> {
    this.assertOpen();
    const database = this.opened.database;
    const preview = this.getPreview(database, assertHorielId(input.previewId, "prv"));
    const info = this.getStoreInfo(database);
    if (!preview || preview.kind !== "restore" || preview.consumedAt
      || preview.snapshotId !== input.snapshotId
      || preview.confirmation !== input.confirmation
      || preview.storeId !== input.expectedStoreId
      || preview.sequence !== input.expectedSequence
      || info.storeId !== input.expectedStoreId
      || info.sequence !== input.expectedSequence) {
      throw new HorielError("confirmation_mismatch", "Horiel restore preview is absent, stale or consumed.");
    }

    const prepared = prepareRestoreStaging({
      databasePath: this.opened.databasePath,
      snapshotDirectory: this.opened.snapshotDirectory,
      snapshotId: input.snapshotId,
      expectedStoreId: input.expectedStoreId,
      nextSequence: input.expectedSequence + 1,
      busyTimeoutMs: this.opened.busyTimeoutMs,
    });
    if (prepared.descriptor.fingerprint !== preview.snapshotFingerprint) {
      fs.rmSync(prepared.stagingPath, { force: true });
      throw new HorielError("integrity_failed", "Horiel snapshot fingerprint changed after preview.");
    }

    const rollbackPath = `${this.opened.databasePath}.restore-rollback`;
    if (fs.existsSync(rollbackPath)) {
      fs.rmSync(prepared.stagingPath, { force: true });
      throw new HorielError("integrity_failed", "Horiel restore rollback artifact already exists.");
    }

    const original = { ...this.opened };
    let originalRenamed = false;
    try {
      database.close();
      fs.renameSync(original.databasePath, rollbackPath);
      originalRenamed = true;
      fs.renameSync(prepared.stagingPath, original.databasePath);
      if (process.platform !== "win32") fs.chmodSync(original.databasePath, 0o600);
      this.opened = reopenHorielDatabase({
        databasePath: original.databasePath,
        snapshotDirectory: original.snapshotDirectory,
        access: "write",
        busyTimeoutMs: original.busyTimeoutMs,
      });
      verifyCanonicalIntegrity(this.opened.database);
      verifyFtsIntegrity(this.opened.database);
      fs.rmSync(rollbackPath, { force: true });
      return prepared.descriptor;
    } catch (error) {
      try {
        if (this.opened.database !== database && this.opened.database.isOpen) {
          this.opened.database.close();
        }
      } catch {
        // Recovery below remains best-effort.
      }
      try {
        if (originalRenamed && fs.existsSync(rollbackPath)) {
          if (fs.existsSync(original.databasePath)) fs.rmSync(original.databasePath, { force: true });
          fs.renameSync(rollbackPath, original.databasePath);
        }
        this.opened = reopenHorielDatabase({
          databasePath: original.databasePath,
          snapshotDirectory: original.snapshotDirectory,
          access: "write",
          busyTimeoutMs: original.busyTimeoutMs,
        });
      } catch {
        this.closed = true;
      }
      fs.rmSync(prepared.stagingPath, { force: true });
      throw normalizeSqliteError(error, "integrity_failed");
    }
  }

  private readTransaction(database: DatabaseSync): HorielReadTransaction {
    return {
      getStoreInfo: () => this.getStoreInfo(database),
      getMemory: (id, version) => this.getMemory(database, id, version),
      getIdempotencyBinding: (key) => this.getIdempotencyBinding(database, key),
      getCheckpoint: (id) => this.getCheckpoint(database, id),
      listCheckpoints: () => this.all(database, `
        SELECT * FROM session_checkpoints ORDER BY created_at DESC, id ASC
      `).map(rowToCheckpoint),
      isPinned: (memoryId) => Boolean(this.get(database, "SELECT 1 AS found FROM pins WHERE memory_id = ?", memoryId)),
      listPins: () => this.all(database, "SELECT memory_id FROM pins ORDER BY memory_id")
        .map((row) => String(row.memory_id)),
      getRelation: (type, sourceId, targetId) => this.getRelation(database, type, sourceId, targetId),
      listRelations: (memoryIds) => this.listRelations(database, memoryIds),
      getPreview: (id) => this.getPreview(database, id),
      searchCandidates: (request) => this.searchCandidates(database, request),
      listContextCandidates: (request) => this.listContextCandidates(database, request),
      listScopeSummaries: (prefix) => this.listScopeSummaries(database, prefix),
      inspectScope: (scope) => this.inspectScope(database, scope),
    };
  }

  private writeTransaction(database: DatabaseSync, mutation: MutationState): HorielWriteTransaction {
    return {
      ...this.readTransaction(database),
      insertMemory: (record) => this.insertMemory(database, mutation, record),
      replaceMemory: (record, expectedVersion) => (
        this.replaceMemory(database, mutation, record, expectedVersion)
      ),
      moveMemory: (record, expectedVersion) => (
        this.replaceMemory(database, mutation, record, expectedVersion)
      ),
      putIdempotencyBinding: (binding) => this.putIdempotencyBinding(database, mutation, binding),
      putCheckpoint: (checkpoint) => this.putCheckpoint(database, mutation, checkpoint),
      putPin: (memoryId) => this.putPin(database, mutation, memoryId),
      deletePin: (memoryId) => this.deletePin(database, mutation, memoryId),
      putRelation: (relation) => this.putRelation(database, mutation, relation),
      deleteRelation: (type, sourceId, targetId) => (
        this.deleteRelation(database, mutation, type, sourceId, targetId)
      ),
      putPreview: (preview) => this.putPreview(database, preview),
      consumePreview: (previewId, consumedAt) => this.consumePreview(database, previewId, consumedAt),
      deleteExactScope: (scope) => this.deleteExactScope(database, mutation, scope),
    };
  }

  private getStoreInfo(database: DatabaseSync): StoreInfo {
    const row = this.get(database, `
      SELECT store_id, sequence FROM horiel_store WHERE singleton = 1
    `);
    if (!row || typeof row.store_id !== "string" || !Number.isSafeInteger(Number(row.sequence))) {
      throw new HorielError("integrity_failed", "Horiel store metadata is invalid.");
    }
    return { storeId: row.store_id, sequence: Number(row.sequence) };
  }

  private getMemory(database: DatabaseSync, id: string, version?: number): MemoryRecord | undefined {
    assertHorielId(id, "mem");
    if (version === undefined) {
      const row = this.get(database, "SELECT * FROM memories WHERE id = ?", id);
      return row ? rowToMemory(row) : undefined;
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new HorielError("invalid_input", "Horiel memory version is invalid.");
    }
    const row = this.get(database, `
      SELECT memory_id AS id, scope, type, title, content, tags_json,
             provenance_json, created_at, updated_at, version
        FROM memory_versions
       WHERE memory_id = ? AND version = ?
    `, id, version);
    return row ? rowToMemory(row) : undefined;
  }

  private getIdempotencyBinding(database: DatabaseSync, key: string): IdempotencyBinding | undefined {
    const row = this.get(database, "SELECT * FROM idempotency_bindings WHERE key = ?", key);
    return row ? rowToIdempotencyBinding(row) : undefined;
  }

  private getCheckpoint(database: DatabaseSync, id: string): SessionCheckpoint | undefined {
    assertHorielId(id, "chk");
    const row = this.get(database, "SELECT * FROM session_checkpoints WHERE id = ?", id);
    return row ? rowToCheckpoint(row) : undefined;
  }

  private getRelation(
    database: DatabaseSync,
    type: MemoryRelationType,
    sourceId: string,
    targetId: string,
  ): MemoryRelation | undefined {
    const row = this.get(database, `
      SELECT * FROM relations WHERE type = ? AND source_id = ? AND target_id = ?
    `, type, sourceId, targetId);
    return row ? rowToRelation(row) : undefined;
  }

  private listRelations(database: DatabaseSync, memoryIds?: string[]): MemoryRelation[] {
    if (!memoryIds) {
      return this.all(database, "SELECT * FROM relations ORDER BY id").map(rowToRelation);
    }
    if (memoryIds.length === 0) return [];
    const unique = [...new Set(memoryIds.map((id) => assertHorielId(id, "mem")))];
    const placeholders = unique.map(() => "?").join(", ");
    return this.all(database, `
      SELECT * FROM relations
       WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
       ORDER BY id
    `, ...unique, ...unique).map(rowToRelation);
  }

  private getPreview(database: DatabaseSync, id: string): StoredPreview | undefined {
    const row = this.get(database, "SELECT * FROM previews WHERE id = ?", id);
    if (!row) return undefined;
    const preview = parseJsonObject(row.payload_json, "preview") as unknown as StoredPreview;
    if (preview.id !== row.id || preview.kind !== row.kind || preview.storeId !== row.store_id
      || preview.sequence !== Number(row.sequence) || preview.confirmation !== row.confirmation
      || preview.createdAt !== row.created_at) {
      throw new HorielError("integrity_failed", "Horiel preview payload is inconsistent.");
    }
    return row.consumed_at === null ? preview : { ...preview, consumedAt: String(row.consumed_at) };
  }

  private searchCandidates(database: DatabaseSync, request: StoreSearchRequest): StoreSearchPage {
    return searchSqliteCandidates({
      database,
      request,
      info: this.getStoreInfo(database),
      mapMemory: rowToMemory,
    });
  }

  private listContextCandidates(
    database: DatabaseSync,
    request: StoreContextRequest,
  ): MemoryRecord[] {
    const target = parseScopePath(request.scope);
    return this.all(database, "SELECT * FROM memories ORDER BY updated_at DESC, id ASC")
      .map(rowToMemory)
      .filter((memory) => classifyScope(memory.scope, target, {
        includeAncestors: true,
        rollup: request.rollup,
        includeGlobal: request.includeGlobal,
      }) !== undefined);
  }

  private listScopeSummaries(database: DatabaseSync, prefix?: string): ScopeSummary[] {
    const canonicalPrefix = prefix === undefined ? undefined : parseScopePath(prefix);
    const rows = this.all(database, `
      SELECT scope,
             sum(memory_count) AS memory_count,
             sum(checkpoint_count) AS checkpoint_count
        FROM (
          SELECT scope, count(*) AS memory_count, 0 AS checkpoint_count
            FROM memories GROUP BY scope
          UNION ALL
          SELECT scope, 0 AS memory_count, count(*) AS checkpoint_count
            FROM session_checkpoints GROUP BY scope
        )
       GROUP BY scope
       ORDER BY scope
    `);
    return rows.flatMap((row) => {
      const scope = parseScopePath(row.scope);
      if (canonicalPrefix && !isScopeWithin(scope, canonicalPrefix)) return [];
      return [{
        scope,
        memoryCount: Number(row.memory_count),
        checkpointCount: Number(row.checkpoint_count),
      }];
    });
  }

  private inspectScope(database: DatabaseSync, scopeInput: string): ScopeInspection {
    const scope = parseScopePath(scopeInput);
    const memoryIds = this.all(database, "SELECT id FROM memories WHERE scope = ? ORDER BY id", scope)
      .map((row) => String(row.id));
    const info = this.getStoreInfo(database);
    const checkpointCount = Number(this.get(database, `
      SELECT count(*) AS count FROM session_checkpoints WHERE scope = ?
    `, scope)?.count ?? 0);
    if (memoryIds.length === 0) {
      return {
        scope,
        memoryIds,
        memoryCount: 0,
        checkpointCount,
        pinCount: 0,
        relationCount: 0,
        storeId: info.storeId,
        sequence: info.sequence,
      };
    }
    const placeholders = memoryIds.map(() => "?").join(", ");
    const pinCount = Number(this.get(database, `
      SELECT count(*) AS count FROM pins WHERE memory_id IN (${placeholders})
    `, ...memoryIds)?.count ?? 0);
    const relationCount = Number(this.get(database, `
      SELECT count(*) AS count FROM relations
       WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
    `, ...memoryIds, ...memoryIds)?.count ?? 0);
    return {
      scope,
      memoryIds,
      memoryCount: memoryIds.length,
      checkpointCount,
      pinCount,
      relationCount,
      storeId: info.storeId,
      sequence: info.sequence,
    };
  }

  private insertMemory(database: DatabaseSync, mutation: MutationState, record: MemoryRecord): void {
    const normalized = normalizeMemory(record);
    if (this.get(database, "SELECT 1 AS found FROM memories WHERE id = ?", normalized.id)) {
      throw new HorielError("conflict", "Horiel memory identity already exists.");
    }
    this.run(database, `
      INSERT INTO memories(
        id, scope, project, type, title, content, tags_json, tags_search,
        provenance_json, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, ...memorySqlValues(normalized));
    this.insertMemoryVersion(database, normalized);
    mutation.changed = true;
  }

  private replaceMemory(
    database: DatabaseSync,
    mutation: MutationState,
    record: MemoryRecord,
    expectedVersion: number,
  ): void {
    const normalized = normalizeMemory(record);
    const current = this.getMemory(database, normalized.id);
    if (!current) throw new HorielError("not_found", "Horiel memory was not found.");
    if (current.version !== expectedVersion || normalized.version !== expectedVersion + 1) {
      throw new HorielError("conflict", "Horiel memory version does not match.");
    }
    this.run(database, `
      UPDATE memories
         SET scope = ?, project = ?, type = ?, title = ?, content = ?,
             tags_json = ?, tags_search = ?, provenance_json = ?,
             created_at = ?, updated_at = ?, version = ?
       WHERE id = ? AND version = ?
    `,
    normalized.scope,
    memoryProject(normalized.scope),
    normalized.type,
    normalized.title,
    normalized.content,
    JSON.stringify(normalized.tags),
    normalized.tags.join(" "),
    JSON.stringify(normalized.provenance),
    normalized.createdAt,
    normalized.updatedAt,
    normalized.version,
    normalized.id,
    expectedVersion);
    this.insertMemoryVersion(database, normalized);
    mutation.changed = true;
  }

  private insertMemoryVersion(database: DatabaseSync, memory: MemoryRecord): void {
    this.run(database, `
      INSERT INTO memory_versions(
        memory_id, version, scope, type, title, content, tags_json,
        provenance_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    memory.id,
    memory.version,
    memory.scope,
    memory.type,
    memory.title,
    memory.content,
    JSON.stringify(memory.tags),
    JSON.stringify(memory.provenance),
    memory.createdAt,
    memory.updatedAt);
  }

  private putIdempotencyBinding(
    database: DatabaseSync,
    mutation: MutationState,
    binding: IdempotencyBinding,
  ): void {
    if (!/^[a-f0-9]{64}$/.test(binding.requestHash)
      || !Number.isSafeInteger(binding.entityVersion) || binding.entityVersion < 1
      || (binding.operation === "memory.create") !== (binding.entity === "memory")
      || (binding.entity === "memory" && !/^mem_[a-f0-9]{32}$/.test(binding.entityId))
      || (binding.entity === "checkpoint" && !/^chk_[a-f0-9]{32}$/.test(binding.entityId))) {
      throw new HorielError("invalid_input", "Horiel idempotency binding is invalid.");
    }
    const existing = this.getIdempotencyBinding(database, binding.key);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(binding)) {
        throw new HorielError("conflict", "Horiel idempotency key is already bound.");
      }
      return;
    }
    this.run(database, `
      INSERT INTO idempotency_bindings(
        key, operation, request_hash, entity, entity_id, entity_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    binding.key,
    binding.operation,
    binding.requestHash,
    binding.entity,
    binding.entityId,
    binding.entityVersion,
    binding.createdAt);
    mutation.changed = true;
  }

  private putCheckpoint(
    database: DatabaseSync,
    mutation: MutationState,
    checkpoint: SessionCheckpoint,
  ): void {
    const existing = this.getCheckpoint(database, checkpoint.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(checkpoint)) {
        throw new HorielError("conflict", "Horiel checkpoint identity already exists.");
      }
      return;
    }
    const normalized = normalizeCheckpoint(checkpoint);
    this.run(database, `
      INSERT INTO session_checkpoints(
        id, scope, project, session_ref, objective, implemented_json,
        verified_json, pending_json, decisions_json, blockers_json,
        validations_json, next_step, created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    normalized.id,
    normalized.scope,
    memoryProject(normalized.scope),
    normalized.sessionRef,
    normalized.objective,
    JSON.stringify(normalized.implemented),
    JSON.stringify(normalized.verified),
    JSON.stringify(normalized.pending),
    JSON.stringify(normalized.decisions),
    JSON.stringify(normalized.blockers),
    JSON.stringify(normalized.validations),
    normalized.nextStep,
    normalized.createdAt,
    normalized.version);
    mutation.changed = true;
  }

  private putPin(database: DatabaseSync, mutation: MutationState, memoryId: string): void {
    const id = assertHorielId(memoryId, "mem");
    if (!this.getMemory(database, id)) throw new HorielError("not_found", "Horiel memory was not found.");
    const result = this.run(database, `
      INSERT OR IGNORE INTO pins(memory_id, created_at) VALUES (?, ?)
    `, id, new Date().toISOString());
    if (result > 0) mutation.changed = true;
  }

  private deletePin(database: DatabaseSync, mutation: MutationState, memoryId: string): void {
    const result = this.run(database, "DELETE FROM pins WHERE memory_id = ?", assertHorielId(memoryId, "mem"));
    if (result > 0) mutation.changed = true;
  }

  private putRelation(database: DatabaseSync, mutation: MutationState, relation: MemoryRelation): void {
    const normalized = normalizeRelation(relation);
    if (!this.getMemory(database, normalized.sourceId) || !this.getMemory(database, normalized.targetId)) {
      throw new HorielError("not_found", "Horiel relation endpoint was not found.");
    }
    const existing = this.getRelation(
      database,
      normalized.type,
      normalized.sourceId,
      normalized.targetId,
    );
    if (existing) return;
    this.run(database, `
      INSERT INTO relations(id, type, source_id, target_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, normalized.id, normalized.type, normalized.sourceId, normalized.targetId, normalized.createdAt);
    mutation.changed = true;
  }

  private deleteRelation(
    database: DatabaseSync,
    mutation: MutationState,
    type: MemoryRelationType,
    sourceId: string,
    targetId: string,
  ): void {
    const result = this.run(database, `
      DELETE FROM relations WHERE type = ? AND source_id = ? AND target_id = ?
    `, type, sourceId, targetId);
    if (result > 0) mutation.changed = true;
  }

  private putPreview(database: DatabaseSync, preview: StoredPreview): void {
    const id = assertHorielId(preview.id, "prv");
    const info = this.getStoreInfo(database);
    if (preview.storeId !== info.storeId || preview.sequence !== info.sequence
      || !preview.confirmation || !isCanonicalTimestamp(preview.createdAt)) {
      throw new HorielError("conflict", "Horiel preview does not match the current store revision.");
    }
    if (this.getPreview(database, id)) {
      throw new HorielError("conflict", "Horiel preview identity already exists.");
    }
    this.run(database, `
      INSERT INTO previews(
        id, kind, payload_json, store_id, sequence, confirmation, created_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `,
    id,
    preview.kind,
    JSON.stringify(preview),
    preview.storeId,
    preview.sequence,
    preview.confirmation,
    preview.createdAt);
  }

  private consumePreview(database: DatabaseSync, previewId: string, consumedAt: string): void {
    if (!isCanonicalTimestamp(consumedAt)) {
      throw new HorielError("invalid_input", "Horiel preview consumption timestamp is invalid.");
    }
    const result = this.run(database, `
      UPDATE previews SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL
    `, consumedAt, assertHorielId(previewId, "prv"));
    if (result !== 1) {
      throw new HorielError("confirmation_mismatch", "Horiel preview is absent or already consumed.");
    }
  }

  private deleteExactScope(database: DatabaseSync, mutation: MutationState, scopeInput: string): string[] {
    const scope = parseScopePath(scopeInput);
    const memoryIds = this.all(database, "SELECT id FROM memories WHERE scope = ? ORDER BY id", scope)
      .map((row) => String(row.id));
    const checkpointIds = this.all(database, `
      SELECT id FROM session_checkpoints WHERE scope = ? ORDER BY id
    `, scope).map((row) => String(row.id));
    const entityIds = [...memoryIds, ...checkpointIds];
    if (entityIds.length > 0) {
      const placeholders = entityIds.map(() => "?").join(", ");
      this.run(database, `DELETE FROM idempotency_bindings WHERE entity_id IN (${placeholders})`, ...entityIds);
    }
    if (memoryIds.length > 0) {
      const placeholders = memoryIds.map(() => "?").join(", ");
      this.run(database, `
        DELETE FROM previews
         WHERE kind IN ('move', 'promote')
           AND json_extract(payload_json, '$.memoryId') IN (${placeholders})
      `, ...memoryIds);
    }
    this.run(database, `
      DELETE FROM previews
       WHERE kind = 'delete_scope'
         AND json_extract(payload_json, '$.scope') = ?
    `, scope);
    this.run(database, "DELETE FROM session_checkpoints WHERE scope = ?", scope);
    this.run(database, "DELETE FROM memories WHERE scope = ?", scope);
    if (memoryIds.length > 0 || checkpointIds.length > 0) mutation.changed = true;
    return memoryIds;
  }

  private run(database: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): number {
    try {
      return Number(database.prepare(sql).run(...parameters).changes);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  private get(database: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): SqlRow | undefined {
    try {
      return database.prepare(sql).get(...parameters) as SqlRow | undefined;
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  private all(database: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): SqlRow[] {
    try {
      return database.prepare(sql).all(...parameters) as SqlRow[];
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  private assertOpen(): void {
    if (this.closed || !this.opened.database.isOpen) {
      throw new HorielError("unavailable", "Horiel SQLite store is closed.");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    if (database.isTransaction) database.exec("ROLLBACK");
  } catch {
    // The original transaction failure remains authoritative.
  }
}

function memorySqlValues(memory: MemoryRecord): SQLInputValue[] {
  return [
    memory.id,
    memory.scope,
    memoryProject(memory.scope),
    memory.type,
    memory.title,
    memory.content,
    JSON.stringify(memory.tags),
    memory.tags.join(" "),
    JSON.stringify(memory.provenance),
    memory.createdAt,
    memory.updatedAt,
    memory.version,
  ];
}

function rowToMemory(row: SqlRow): MemoryRecord {
  const memory: MemoryRecord = {
    id: assertHorielId(row.id, "mem"),
    scope: parseScopePath(row.scope),
    type: validateMemoryType(row.type),
    title: requireString(row.title, "memory title"),
    content: requireString(row.content, "memory content"),
    tags: parseStringArray(row.tags_json, "memory tags"),
    createdAt: requireTimestamp(row.created_at, "memory created timestamp"),
    updatedAt: requireTimestamp(row.updated_at, "memory updated timestamp"),
    version: requirePositiveInteger(row.version, "memory version"),
    provenance: validateProvenance(parseJsonObject(row.provenance_json, "memory provenance")),
  };
  if (canonicalJson(memory.tags) !== canonicalJson(normalizeTags(memory.tags))) {
    throw new HorielError("integrity_failed", "Horiel memory tags are not canonical.");
  }
  return memory;
}

function normalizeMemory(record: MemoryRecord): MemoryRecord {
  const normalized: MemoryRecord = {
    id: assertHorielId(record.id, "mem"),
    scope: parseScopePath(record.scope),
    type: validateMemoryType(record.type),
    title: requireString(record.title, "memory title"),
    content: requireString(record.content, "memory content"),
    tags: normalizeTags(record.tags),
    createdAt: requireTimestamp(record.createdAt, "memory created timestamp"),
    updatedAt: requireTimestamp(record.updatedAt, "memory updated timestamp"),
    version: requirePositiveInteger(record.version, "memory version"),
    provenance: validateProvenance(record.provenance),
  };
  if (canonicalJson(normalized.tags) !== canonicalJson(record.tags)) {
    throw new HorielError("invalid_input", "Horiel memory tags are not canonical.");
  }
  return normalized;
}

function rowToIdempotencyBinding(row: SqlRow): IdempotencyBinding {
  const operation = requireString(row.operation, "idempotency operation");
  const entity = requireString(row.entity, "idempotency entity");
  if (operation !== "memory.create" && operation !== "checkpoint.create") {
    throw new HorielError("integrity_failed", "Horiel idempotency operation is invalid.");
  }
  if (entity !== "memory" && entity !== "checkpoint") {
    throw new HorielError("integrity_failed", "Horiel idempotency entity is invalid.");
  }
  return {
    key: requireString(row.key, "idempotency key"),
    operation,
    requestHash: requireString(row.request_hash, "idempotency hash"),
    entity,
    entityId: requireString(row.entity_id, "idempotency entity identity"),
    entityVersion: requirePositiveInteger(row.entity_version, "idempotency entity version"),
    createdAt: requireTimestamp(row.created_at, "idempotency timestamp"),
  };
}

function rowToCheckpoint(row: SqlRow): SessionCheckpoint {
  return normalizeCheckpoint({
    id: requireString(row.id, "checkpoint identity"),
    scope: requireString(row.scope, "checkpoint scope"),
    sessionRef: requireString(row.session_ref, "checkpoint session reference"),
    objective: requireString(row.objective, "checkpoint objective"),
    implemented: parseStringArray(row.implemented_json, "checkpoint implemented"),
    verified: parseStringArray(row.verified_json, "checkpoint verified"),
    pending: parseStringArray(row.pending_json, "checkpoint pending"),
    decisions: parseStringArray(row.decisions_json, "checkpoint decisions"),
    blockers: parseStringArray(row.blockers_json, "checkpoint blockers"),
    validations: parseStringArray(row.validations_json, "checkpoint validations"),
    nextStep: requireString(row.next_step, "checkpoint next step"),
    createdAt: requireString(row.created_at, "checkpoint timestamp"),
    version: Number(row.version) as 1,
  });
}

function normalizeCheckpoint(checkpoint: SessionCheckpoint): SessionCheckpoint {
  if (checkpoint.version !== 1) {
    throw new HorielError("invalid_input", "Horiel checkpoint version is invalid.");
  }
  return {
    id: assertHorielId(checkpoint.id, "chk"),
    scope: parseScopePath(checkpoint.scope),
    sessionRef: requireString(checkpoint.sessionRef, "checkpoint session reference"),
    objective: requireString(checkpoint.objective, "checkpoint objective"),
    implemented: requireStringArray(checkpoint.implemented, "checkpoint implemented"),
    verified: requireStringArray(checkpoint.verified, "checkpoint verified"),
    pending: requireStringArray(checkpoint.pending, "checkpoint pending"),
    decisions: requireStringArray(checkpoint.decisions, "checkpoint decisions"),
    blockers: requireStringArray(checkpoint.blockers, "checkpoint blockers"),
    validations: requireStringArray(checkpoint.validations, "checkpoint validations"),
    nextStep: requireString(checkpoint.nextStep, "checkpoint next step"),
    createdAt: requireTimestamp(checkpoint.createdAt, "checkpoint timestamp"),
    version: 1,
  };
}

function rowToRelation(row: SqlRow): MemoryRelation {
  const type = requireString(row.type, "relation type") as MemoryRelationType;
  if (!(["related", "conflicts_with", "supersedes"] as const).includes(type)) {
    throw new HorielError("integrity_failed", "Horiel relation type is invalid.");
  }
  return normalizeRelation({
    id: requireString(row.id, "relation identity"),
    type,
    sourceId: requireString(row.source_id, "relation source"),
    targetId: requireString(row.target_id, "relation target"),
    createdAt: requireString(row.created_at, "relation timestamp"),
  });
}

function normalizeRelation(relation: MemoryRelation): MemoryRelation {
  const type = relation.type;
  if (!(["related", "conflicts_with", "supersedes"] as const).includes(type)) {
    throw new HorielError("invalid_input", "Horiel relation type is invalid.");
  }
  const sourceId = assertHorielId(relation.sourceId, "mem");
  const targetId = assertHorielId(relation.targetId, "mem");
  if (sourceId === targetId) {
    throw new HorielError("invalid_input", "Horiel relation endpoints must differ.");
  }
  return {
    id: assertHorielId(relation.id, "rel"),
    type,
    sourceId,
    targetId,
    createdAt: requireTimestamp(relation.createdAt, "relation timestamp"),
  };
}

function memoryProject(scope: string): string {
  return scope === HORIEL_GLOBAL_SCOPE ? HORIEL_GLOBAL_SCOPE : projectScope(scope);
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw new HorielError("integrity_failed", `Horiel ${label} is invalid.`);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HorielError("integrity_failed", `Horiel ${label} is invalid.`);
  }
}

function parseStringArray(value: unknown, label: string): string[] {
  if (typeof value !== "string") throw new HorielError("integrity_failed", `Horiel ${label} is invalid.`);
  try {
    return requireStringArray(JSON.parse(value), label);
  } catch (error) {
    if (error instanceof HorielError) throw error;
    throw new HorielError("integrity_failed", `Horiel ${label} is invalid.`);
  }
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HorielError("integrity_failed", `Horiel ${label} is invalid.`);
  }
  return [...value] as string[];
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new HorielError("integrity_failed", `Horiel ${label} is invalid.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (!isCanonicalTimestamp(timestamp)) {
    throw new HorielError("integrity_failed", `Horiel ${label} is invalid.`);
  }
  return timestamp;
}

function isCanonicalTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new HorielError("integrity_failed", `Horiel ${label} is invalid.`);
  }
  return number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}
