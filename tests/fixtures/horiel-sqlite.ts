import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HorielError,
  createHorielCore,
} from "../../src/horiel/core";
import type {
  HorielCore,
  HorielErrorCode,
  HorielStore,
  MemoryRecord,
  SaveMemoryInput,
  StoredPreview,
} from "../../src/horiel/core";

const sourceRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const HORIEL_REPO_ROOT = path.resolve(
  process.env.HORIEL_SQLITE_REPO_ROOT ?? sourceRepositoryRoot,
);
export const HORIEL_SQLITE_SANDBOX_ROOT = path.join(
  HORIEL_REPO_ROOT,
  ".sandbox",
  "horiel-p3",
);

export const NODE_SCENARIO_NAMES = {
  store: [
    "creates private STRICT v1 schema and rejects overwrite",
    "rejects unsafe or incompatible database paths",
    "persists the P2 Core contract across reopen",
    "increments sequence once and excludes preview bookkeeping",
    "rolls back callback and commit failures",
  ],
  search: [
    "separates exact ancestor rollup and global scopes by segments",
    "quotes literal FTS terms and returns bounded ranking metadata",
    "rebuilds damaged FTS without changing canonical data or using LIKE",
    "binds opaque keyset cursors to query filters store sequence and ranking",
  ],
  administration: [
    "creates a private consistent physical backup",
    "restores complete canonical state only from a fresh bound preview",
    "detects snapshot corruption before swap and preserves the live store",
  ],
  recovery: [
    "returns busy to a contending second writer",
    "recovers an abrupt uncommitted transaction without persistent sidecars",
  ],
  boundary: [
    "loads the approved SQLite barrel and constants under Node",
  ],
} as const;

export type NodeScenarioGroup = keyof typeof NODE_SCENARIO_NAMES;

export interface NodeScenarioResult {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  error?: string;
}

export interface NodeScenarioReport {
  group: NodeScenarioGroup;
  nodeVersion: string;
  results: NodeScenarioResult[];
  stdout?: string;
  stderr?: string;
}

interface HorielSqliteStore extends HorielStore {
  verifyIntegrity(): Promise<unknown> | unknown;
  rebuildSearchIndex(): Promise<unknown> | unknown;
  close(): Promise<unknown> | unknown;
}

interface HorielSqliteAdapterModule {
  HORIEL_SQLITE_APPLICATION_ID: number;
  HORIEL_SQLITE_SCHEMA_VERSION: number;
  HORIEL_SQLITE_JOURNAL_MODE: string;
  openHorielSqliteStore(input: {
    databasePath: string;
    snapshotDirectory: string;
    access: "create" | "read" | "write";
    busyTimeoutMs?: number;
  }): HorielSqliteStore | Promise<HorielSqliteStore>;
  inspectHorielSqliteFile?: (databasePath: string) => unknown;
}

interface NativeStatement {
  all(...parameters: unknown[]): Record<string, unknown>[];
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  run(...parameters: unknown[]): unknown;
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

type NativeDatabaseConstructor = new (
  databasePath: string,
  options?: { readOnly?: boolean; enableForeignKeyConstraints?: boolean },
) => NativeDatabase;

let NativeDatabaseSync: NativeDatabaseConstructor | undefined;
const openStores = new Set<HorielSqliteStore>();
const openDatabases = new Set<NativeDatabase>();

async function loadSqliteCapabilities(): Promise<void> {
  const sqlite = await import("node:sqlite") as unknown as {
    DatabaseSync: NativeDatabaseConstructor;
  };
  NativeDatabaseSync = sqlite.DatabaseSync;
}

async function loadAdapter(): Promise<HorielSqliteAdapterModule> {
  return await import("../../src/horiel/sqlite/index") as unknown as HorielSqliteAdapterModule;
}

function safeSegment(value: string): string {
  const normalized = value.normalize("NFC").replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("A non-empty synthetic sandbox name is required.");
  }
  return normalized;
}

export function assertHorielSandboxPath(target: string): string {
  const resolved = path.resolve(target);
  const relative = path.relative(HORIEL_SQLITE_SANDBOX_ROOT, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Synthetic Horiel path escaped its sandbox: ${target}`);
  }
  return resolved;
}

interface HorielSqliteSandbox {
  root: string;
  databasePath: string;
  snapshotDirectory: string;
}

function createHorielSqliteSandbox(suite: string, testCase: string): HorielSqliteSandbox {
  const root = assertHorielSandboxPath(path.join(
    HORIEL_SQLITE_SANDBOX_ROOT,
    safeSegment(suite),
    safeSegment(testCase),
  ));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    root,
    databasePath: assertHorielSandboxPath(path.join(root, "store", "horiel.sqlite")),
    snapshotDirectory: assertHorielSandboxPath(path.join(root, "snapshots")),
  };
}

function cleanupHorielSqliteSandbox(suite: string): void {
  const suiteRoot = assertHorielSandboxPath(path.join(
    HORIEL_SQLITE_SANDBOX_ROOT,
    safeSegment(suite),
  ));
  fs.rmSync(suiteRoot, { recursive: true, force: true });
}

function createPrivateParent(target: string): void {
  const checked = assertHorielSandboxPath(target);
  fs.mkdirSync(path.dirname(checked), { recursive: true, mode: 0o700 });
}

function deterministicClock(initial = "2026-11-02T12:00:00.000Z"): {
  now(): Date;
  advance(milliseconds: number): void;
} {
  let timestamp = Date.parse(initial);
  return {
    now: () => new Date(timestamp),
    advance: (milliseconds) => {
      timestamp += milliseconds;
    },
  };
}

function deterministicIdFactory(): { create(prefix: string): string } {
  let sequence = 0;
  return {
    create(prefix: string): string {
      sequence += 1;
      return `${prefix}_${sequence.toString(16).padStart(32, "0")}`;
    },
  };
}

function createSqliteCoreHarness(store: HorielStore): {
  core: HorielCore;
  clock: ReturnType<typeof deterministicClock>;
} {
  const clock = deterministicClock();
  return {
    core: createHorielCore({
      store,
      clock,
      idFactory: deterministicIdFactory(),
    }),
    clock,
  };
}

async function saveSyntheticMemory(
  core: HorielCore,
  key: string,
  overrides: Partial<SaveMemoryInput> = {},
): Promise<MemoryRecord> {
  const normalizedKey = safeSegment(key).padEnd(8, "0");
  return (await core.saveMemory({
    scope: "synthetic/task",
    type: "decision",
    title: `Synthetic memory ${key}`,
    content: `Synthetic SQLite content for ${key}.`,
    tags: ["sqlite", "synthetic"],
    idempotencyKey: `sqlite-${normalizedKey}`,
    provenance: { source: "horiel-p3-test" },
    ...overrides,
  })).memory;
}

function syntheticMemory(seed: number, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const createdAt = new Date(Date.parse("2026-11-02T12:00:00.000Z") + seed * 1_000).toISOString();
  return {
    id: `mem_${seed.toString(16).padStart(32, "0")}`,
    scope: "synthetic/task",
    type: "general",
    title: `Direct memory ${seed}`,
    content: `Direct SQLite fixture ${seed}.`,
    tags: ["direct", "sqlite"],
    createdAt,
    updatedAt: createdAt,
    version: 1,
    provenance: { source: "horiel-p3-test" },
    ...overrides,
  };
}

function syntheticMovePreview(input: {
  seed: number;
  storeId: string;
  sequence: number;
  memory: MemoryRecord;
}): StoredPreview {
  const destinationScope = "synthetic/other";
  return {
    id: `prv_${input.seed.toString(16).padStart(32, "0")}`,
    kind: "move",
    storeId: input.storeId,
    sequence: input.sequence,
    confirmation: `MOVE ${input.memory.id} TO ${destinationScope}`,
    createdAt: new Date(Date.parse("2026-11-02T12:00:00.000Z") + input.seed * 1_000).toISOString(),
    memoryId: input.memory.id,
    sourceScope: input.memory.scope,
    destinationScope,
    expectedVersion: input.memory.version,
    conflictIds: [],
  };
}

async function expectHorielErrorCode(
  operation: Promise<unknown> | (() => unknown),
  expected: HorielErrorCode | readonly HorielErrorCode[],
): Promise<HorielError> {
  try {
    if (typeof operation === "function") await Promise.resolve().then(operation);
    else await operation;
  } catch (error) {
    assert.ok(error instanceof HorielError, `Expected HorielError, received ${String(error)}`);
    const accepted = Array.isArray(expected) ? expected : [expected];
    assert.ok(accepted.includes(error.code), `Expected ${accepted.join("|")}, received ${error.code}`);
    return error;
  }
  throw new Error(`Expected HorielError(${Array.isArray(expected) ? expected.join("|") : expected})`);
}

async function openStore(
  adapter: HorielSqliteAdapterModule,
  input: Parameters<HorielSqliteAdapterModule["openHorielSqliteStore"]>[0],
): Promise<HorielSqliteStore> {
  const store = await adapter.openHorielSqliteStore(input);
  openStores.add(store);
  return store;
}

async function closeStore(store: HorielSqliteStore | undefined): Promise<void> {
  if (!store) return;
  openStores.delete(store);
  await store.close();
}

function openRawDatabase(
  databasePath: string,
  options: { readOnly?: boolean } = {},
): NativeDatabase {
  if (!NativeDatabaseSync) throw new Error("node:sqlite capability was not initialized.");
  const database = new NativeDatabaseSync(assertHorielSandboxPath(databasePath), {
    readOnly: options.readOnly === true,
    enableForeignKeyConstraints: true,
  });
  openDatabases.add(database);
  return database;
}

function closeRawDatabase(database: NativeDatabase): void {
  openDatabases.delete(database);
  database.close();
}

async function closeLeakedResources(): Promise<void> {
  for (const store of [...openStores]) {
    try {
      await store.close();
    } catch {
      // A failed scenario must not prevent the remaining synthetic cases.
    }
    openStores.delete(store);
  }
  for (const database of [...openDatabases]) {
    try {
      database.close();
    } catch {
      // Already-closed native handles are harmless during fixture cleanup.
    }
    openDatabases.delete(database);
  }
}

function sqliteValue(database: NativeDatabase, sql: string): unknown {
  const row = database.prepare(sql).get();
  return row ? Object.values(row)[0] : undefined;
}

function sqliteRows<T extends Record<string, unknown>>(database: NativeDatabase, sql: string): T[] {
  return database.prepare(sql).all() as T[];
}

function fileMode(target: string): number {
  return fs.statSync(assertHorielSandboxPath(target)).mode & 0o777;
}

function findSnapshotDatabase(snapshotDirectory: string, snapshotId: string): string {
  const directory = assertHorielSandboxPath(snapshotDirectory);
  const candidates = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.includes(snapshotId))
    .map((entry) => assertHorielSandboxPath(path.join(directory, entry.name)))
    .filter((target) => {
      const descriptor = fs.openSync(target, "r");
      try {
        const header = Buffer.alloc(16);
        return fs.readSync(descriptor, header, 0, 16, 0) === 16
          && header.toString("utf8") === "SQLite format 3\u0000";
      } finally {
        fs.closeSync(descriptor);
      }
    });
  assert.equal(candidates.length, 1, `Expected one physical snapshot for ${snapshotId}`);
  return candidates[0]!;
}

function sha256File(target: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(assertHorielSandboxPath(target)))
    .digest("hex");
}

function tamperOpaqueCursor(cursor: string): string {
  assert.ok(cursor, "A cursor is required for tampering.");
  const final = cursor.at(-1)!;
  return `${cursor.slice(0, -1)}${final === "A" ? "B" : "A"}`;
}

function contextIds(result: {
  sections: {
    exact: MemoryRecord[];
    ancestors: MemoryRecord[];
    descendants: MemoryRecord[];
    global: MemoryRecord[];
  };
}): string[] {
  return [
    ...result.sections.exact,
    ...result.sections.ancestors,
    ...result.sections.descendants,
    ...result.sections.global,
  ].map((memory) => memory.id);
}

async function scenarioCreateSchema(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("store", "create-schema");
  const store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const initialInfo = await store.read((transaction) => transaction.getStoreInfo());
  assert.match(initialInfo.storeId, /^store_[a-f0-9]{32}$/);
  assert.equal(initialInfo.sequence, 0);
  await closeStore(store);

  assert.ok(fs.statSync(sandbox.databasePath).isFile());
  assert.ok(fs.statSync(sandbox.snapshotDirectory).isDirectory());
  if (process.platform !== "win32") {
    assert.equal(fileMode(sandbox.databasePath), 0o600);
    assert.equal(fileMode(path.dirname(sandbox.databasePath)), 0o700);
    assert.equal(fileMode(sandbox.snapshotDirectory), 0o700);
  }

  const database = openRawDatabase(sandbox.databasePath, { readOnly: true });
  assert.equal(sqliteValue(database, "PRAGMA application_id"), adapter.HORIEL_SQLITE_APPLICATION_ID);
  assert.equal(sqliteValue(database, "PRAGMA user_version"), adapter.HORIEL_SQLITE_SCHEMA_VERSION);
  assert.equal(
    String(sqliteValue(database, "PRAGMA journal_mode")).toLowerCase(),
    adapter.HORIEL_SQLITE_JOURNAL_MODE.toLowerCase(),
  );
  assert.equal(Number(sqliteValue(database, "PRAGMA synchronous")), 2);

  const requiredTables = [
    "horiel_store",
    "idempotency_bindings",
    "memories",
    "memory_versions",
    "pins",
    "previews",
    "relations",
    "session_checkpoints",
  ];
  const tableList = sqliteRows<{ name: string; strict: number }>(database, "PRAGMA table_list");
  for (const table of requiredTables) {
    assert.equal(tableList.find((entry) => entry.name === table)?.strict, 1, `STRICT table ${table}`);
  }
  assert.ok(tableList.some((entry) => entry.name === "memory_fts"));

  const indexes = sqliteRows<{ name: string; tbl_name: string }>(
    database,
    "SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' ORDER BY name",
  );
  const indexedColumns = new Set<string>();
  for (const index of indexes) {
    const escaped = index.name.replaceAll('"', '""');
    for (const column of sqliteRows<{ name: string }>(database, `PRAGMA index_info("${escaped}")`)) {
      indexedColumns.add(`${index.tbl_name}.${column.name}`);
    }
  }
  for (const column of [
    "memories.id",
    "memories.project",
    "memories.scope",
    "memories.type",
    "memories.updated_at",
    "memory_versions.memory_id",
    "memory_versions.version",
  ]) assert.ok(indexedColumns.has(column), `Missing indexed column ${column}`);

  const triggerSql = sqliteRows<{ sql: string }>(
    database,
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'memories' ORDER BY name",
  ).map(({ sql }) => sql).join("\n");
  assert.match(triggerSql, /memory_fts/);
  assert.match(triggerSql, /AFTER\s+INSERT/i);
  assert.match(triggerSql, /AFTER\s+UPDATE/i);
  assert.match(triggerSql, /AFTER\s+DELETE/i);
  closeRawDatabase(database);

  await expectHorielErrorCode(() => adapter.openHorielSqliteStore({
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  }), "conflict");

  const readStore = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "read",
  });
  assert.deepEqual(await readStore.read((transaction) => transaction.getStoreInfo()), initialInfo);
  await expectHorielErrorCode(() => readStore.write((transaction) => (
    transaction.insertMemory(syntheticMemory(1))
  )), "unavailable");
  assert.equal((await readStore.read((transaction) => transaction.getStoreInfo())).sequence, 0);
  await closeStore(readStore);
}

async function scenarioUnsafePaths(adapter: HorielSqliteAdapterModule): Promise<void> {
  const missing = createHorielSqliteSandbox("store", "missing");
  for (const access of ["read", "write"] as const) {
    await expectHorielErrorCode(() => adapter.openHorielSqliteStore({
      databasePath: missing.databasePath,
      snapshotDirectory: missing.snapshotDirectory,
      access,
    }), "not_found");
    assert.equal(fs.existsSync(missing.databasePath), false);
  }

  const empty = createHorielSqliteSandbox("store", "empty");
  createPrivateParent(empty.databasePath);
  fs.writeFileSync(empty.databasePath, "", { mode: 0o600 });
  await expectHorielErrorCode(() => adapter.openHorielSqliteStore({
    databasePath: empty.databasePath,
    snapshotDirectory: empty.snapshotDirectory,
    access: "write",
  }), "integrity_failed");
  assert.equal(fs.statSync(empty.databasePath).size, 0);

  const foreign = createHorielSqliteSandbox("store", "foreign");
  createPrivateParent(foreign.databasePath);
  const foreignDatabase = openRawDatabase(foreign.databasePath);
  foreignDatabase.exec("CREATE TABLE unrelated(value TEXT)");
  closeRawDatabase(foreignDatabase);
  await expectHorielErrorCode(() => adapter.openHorielSqliteStore({
    databasePath: foreign.databasePath,
    snapshotDirectory: foreign.snapshotDirectory,
    access: "write",
  }), "integrity_failed");
  const foreignCheck = openRawDatabase(foreign.databasePath, { readOnly: true });
  assert.equal(sqliteValue(foreignCheck, "SELECT count(*) FROM sqlite_schema WHERE name = 'unrelated'"), 1);
  closeRawDatabase(foreignCheck);

  const future = createHorielSqliteSandbox("store", "future");
  const futureStore = await openStore(adapter, {
    databasePath: future.databasePath,
    snapshotDirectory: future.snapshotDirectory,
    access: "create",
  });
  await closeStore(futureStore);
  const futureDatabase = openRawDatabase(future.databasePath);
  futureDatabase.exec(`PRAGMA user_version = ${adapter.HORIEL_SQLITE_SCHEMA_VERSION + 1}`);
  closeRawDatabase(futureDatabase);
  await expectHorielErrorCode(() => adapter.openHorielSqliteStore({
    databasePath: future.databasePath,
    snapshotDirectory: future.snapshotDirectory,
    access: "write",
  }), "future_schema");

  const aliases = createHorielSqliteSandbox("store", "aliases");
  const canonical = await openStore(adapter, {
    databasePath: aliases.databasePath,
    snapshotDirectory: aliases.snapshotDirectory,
    access: "create",
  });
  await closeStore(canonical);
  const symlinkPath = path.join(path.dirname(aliases.databasePath), "symlink.sqlite");
  fs.symlinkSync(aliases.databasePath, symlinkPath);
  await expectHorielErrorCode(() => adapter.openHorielSqliteStore({
    databasePath: symlinkPath,
    snapshotDirectory: aliases.snapshotDirectory,
    access: "read",
  }), "unsafe_path");
  const hardlinkPath = path.join(path.dirname(aliases.databasePath), "hardlink.sqlite");
  fs.linkSync(aliases.databasePath, hardlinkPath);
  await expectHorielErrorCode(() => adapter.openHorielSqliteStore({
    databasePath: hardlinkPath,
    snapshotDirectory: aliases.snapshotDirectory,
    access: "write",
  }), "unsafe_path");
  assert.ok(fs.statSync(aliases.databasePath).nlink > 1);
}

async function scenarioCoreContract(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("store", "core-contract");
  let store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const { core, clock } = createSqliteCoreHarness(store);
  const input = {
    scope: "synthetic/task/HU-3",
    type: "decision" as const,
    title: "Persist the SQLite contract",
    content: "The canonical row must survive reopening.",
    tags: ["P3", "sqlite"],
    idempotencyKey: "sqlite-core-create-0001",
    provenance: { source: "horiel-p3-test" },
  };
  const created = await core.saveMemory(input);
  const createSequence = (await store.read((transaction) => transaction.getStoreInfo())).sequence;
  assert.deepEqual(await core.saveMemory({ ...input, tags: [...input.tags] }), {
    status: "replayed",
    memory: created.memory,
  });
  assert.equal((await store.read((transaction) => transaction.getStoreInfo())).sequence, createSequence);
  clock.advance(1_000);
  const updated = await core.updateMemory({
    id: created.memory.id,
    expectedVersion: 1,
    content: "The canonical row and its history survive reopening.",
  });
  await expectHorielErrorCode(core.updateMemory({
    id: created.memory.id,
    expectedVersion: 1,
    title: "Stale overwrite",
  }), "conflict");

  const other = await saveSyntheticMemory(core, "relation-peer", {
    scope: "synthetic/task",
    title: "Relation peer",
  });
  assert.deepEqual(await core.pinMemory({ id: updated.memory.id }), { changed: true, pinned: true });
  assert.deepEqual(await core.pinMemory({ id: updated.memory.id }), { changed: false, pinned: true });
  const linked = await core.linkMemory({
    sourceId: updated.memory.id,
    targetId: other.id,
    type: "related",
  });
  assert.equal((await core.linkMemory({
    sourceId: other.id,
    targetId: updated.memory.id,
    type: "related",
  })).changed, false);

  const checkpointInput = {
    scope: "synthetic/task/HU-3",
    sessionRef: "session-sqlite-core-0001",
    idempotencyKey: "sqlite-checkpoint-0001",
    objective: "Persist a synthetic checkpoint",
    implemented: ["adapter contract"],
    verified: ["focused suite"],
    pending: ["production code"],
    decisions: ["use DELETE journal"],
    blockers: [],
    validations: ["bun test"],
    nextStep: "Reopen the store",
  };
  const checkpoint = await core.saveSessionCheckpoint(checkpointInput);
  assert.equal((await core.saveSessionCheckpoint({ ...checkpointInput })).status, "replayed");
  const beforePreview = await store.read((transaction) => transaction.getStoreInfo());
  const preview = await core.previewMove({ id: updated.memory.id, destinationScope: "synthetic/task/HU-4" });
  assert.deepEqual(await store.read((transaction) => transaction.getStoreInfo()), beforePreview);
  const moved = await core.moveMemory({ previewId: preview.id, confirmation: preview.confirmation });
  assert.equal(moved.memory.id, created.memory.id);
  assert.equal(moved.memory.scope, "synthetic/task/HU-4");
  assert.equal(moved.memory.version, 3);

  const tree = await core.listTree({ prefix: "synthetic/task" });
  assert.deepEqual(tree.nodes.map((node) => node.scope), [
    "synthetic/task",
    "synthetic/task/HU-3",
    "synthetic/task/HU-4",
  ]);
  const inspection = await core.inspectScope({ scope: "synthetic/task/HU-4" });
  assert.deepEqual(inspection.memoryIds, [created.memory.id]);
  assert.equal(inspection.pinCount, 1);
  assert.equal(inspection.relationCount, 1);

  await closeStore(store);
  store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "write",
  });
  const reopened = createSqliteCoreHarness(store).core;
  assert.deepEqual(await reopened.getMemory({ id: created.memory.id, version: 1 }), created.memory);
  assert.deepEqual(await reopened.getMemory({ id: created.memory.id }), moved.memory);
  const persisted = await store.read(async (transaction) => ({
    checkpoint: await transaction.getCheckpoint(checkpoint.checkpoint.id),
    pinned: await transaction.isPinned(created.memory.id),
    relation: await transaction.getRelation("related", linked.relation.sourceId, linked.relation.targetId),
    preview: await transaction.getPreview(preview.id),
  }));
  assert.deepEqual(persisted.checkpoint, checkpoint.checkpoint);
  assert.equal(persisted.pinned, true);
  assert.deepEqual(persisted.relation, linked.relation);
  assert.ok(persisted.preview?.consumedAt);
  await closeStore(store);
}

async function scenarioSequence(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("store", "sequence");
  const store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const first = syntheticMemory(10);
  const second = syntheticMemory(11);
  const relation = {
    id: `rel_${"c".repeat(32)}`,
    type: "related" as const,
    sourceId: first.id,
    targetId: second.id,
    createdAt: "2026-11-02T12:01:00.000Z",
  };
  await store.write(async (transaction) => {
    await transaction.insertMemory(first);
    await transaction.insertMemory(second);
    await transaction.putPin(first.id);
    await transaction.putRelation(relation);
  });
  const afterBatch = await store.read((transaction) => transaction.getStoreInfo());
  assert.equal(afterBatch.sequence, 1);
  await store.write(async (transaction) => {
    await transaction.putPin(first.id);
    await transaction.putRelation(relation);
  });
  assert.equal((await store.read((transaction) => transaction.getStoreInfo())).sequence, 1);

  const preview = syntheticMovePreview({ seed: 12, storeId: afterBatch.storeId, sequence: 1, memory: first });
  await store.write((transaction) => transaction.putPreview(preview));
  await store.write((transaction) => transaction.consumePreview(preview.id, "2026-11-02T12:02:00.000Z"));
  assert.equal((await store.read((transaction) => transaction.getStoreInfo())).sequence, 1);
  const replacement = {
    ...first,
    title: "Direct memory version two",
    updatedAt: "2026-11-02T12:03:00.000Z",
    version: 2,
  };
  await store.write((transaction) => transaction.replaceMemory(replacement, 1));
  assert.equal((await store.read((transaction) => transaction.getStoreInfo())).sequence, 2);
  await expectHorielErrorCode(store.write((transaction) => transaction.replaceMemory({
    ...replacement,
    version: 3,
  }, 1)), "conflict");
  const moved = {
    ...replacement,
    scope: "synthetic/other",
    updatedAt: "2026-11-02T12:04:00.000Z",
    version: 3,
  };
  await store.write((transaction) => transaction.moveMemory(moved, 2));
  const versions = await store.read(async (transaction) => ({
    first: await transaction.getMemory(first.id, 1),
    second: await transaction.getMemory(first.id, 2),
    current: await transaction.getMemory(first.id),
    pins: await transaction.listPins(),
    relations: await transaction.listRelations([first.id]),
  }));
  assert.deepEqual(versions, { first, second: replacement, current: moved, pins: [first.id], relations: [relation] });
  assert.equal((await store.read((transaction) => transaction.getStoreInfo())).sequence, 3);
  await closeStore(store);
}

async function scenarioRollback(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("store", "rollback");
  const store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
    busyTimeoutMs: 20,
  });
  const callbackRecord = syntheticMemory(20);
  await assert.rejects(store.write(async (transaction) => {
    await transaction.insertMemory(callbackRecord);
    throw new Error("synthetic callback failure");
  }), /synthetic callback failure/);
  assert.equal(await store.read((transaction) => transaction.getMemory(callbackRecord.id)), undefined);
  assert.equal((await store.read((transaction) => transaction.getStoreInfo())).sequence, 0);

  const reader = openRawDatabase(sandbox.databasePath, { readOnly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT singleton FROM horiel_store").all();
  const commitRecord = syntheticMemory(21);
  try {
    await expectHorielErrorCode(store.write((transaction) => transaction.insertMemory(commitRecord)), "busy");
  } finally {
    reader.exec("ROLLBACK");
    closeRawDatabase(reader);
  }
  assert.equal(await store.read((transaction) => transaction.getMemory(commitRecord.id)), undefined);
  assert.equal((await store.read((transaction) => transaction.getStoreInfo())).sequence, 0);
  await store.write((transaction) => transaction.insertMemory(commitRecord));
  assert.deepEqual(await store.read((transaction) => transaction.getMemory(commitRecord.id)), commitRecord);
  await closeStore(store);
}

async function saveSearchMemory(
  core: HorielCore,
  key: string,
  overrides: Partial<SaveMemoryInput> = {},
): Promise<MemoryRecord> {
  return saveSyntheticMemory(core, `search-${key}`, overrides);
}

async function scenarioContextScopes(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("search", "context-segments");
  const store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const { core } = createSqliteCoreHarness(store);
  const root = await saveSearchMemory(core, "root", { scope: "synthetic", title: "Root context" });
  const ancestor = await saveSearchMemory(core, "ancestor", { scope: "synthetic/task", title: "Task context" });
  const exact = await saveSearchMemory(core, "exact", { scope: "synthetic/task/HU-1", title: "Exact context" });
  const child = await saveSearchMemory(core, "child", {
    scope: "synthetic/task/HU-1/backend",
    title: "Child context",
  });
  const neighbour = await saveSearchMemory(core, "neighbour", {
    scope: "synthetic/task/HU-10",
    title: "Textual prefix neighbour",
  });
  const global = await saveSearchMemory(core, "global", { scope: "@global", title: "Global context" });
  const foreign = await saveSearchMemory(core, "foreign", { scope: "other/task", title: "Foreign project" });

  const normal = await core.getContext({ scope: "synthetic/task/HU-1", rollup: false, budgetBytes: 262_144 });
  assert.deepEqual(normal.sections.exact.map((entry) => entry.id), [exact.id]);
  assert.deepEqual(new Set(normal.sections.ancestors.map((entry) => entry.id)), new Set([root.id, ancestor.id]));
  assert.deepEqual(normal.sections.descendants, []);
  assert.deepEqual(normal.sections.global.map((entry) => entry.id), [global.id]);
  assert.ok(!contextIds(normal).includes(neighbour.id));
  assert.ok(!contextIds(normal).includes(foreign.id));
  const rolledUp = await core.getContext({
    scope: "synthetic/task/HU-1",
    rollup: true,
    includeGlobal: false,
    budgetBytes: 262_144,
  });
  assert.deepEqual(rolledUp.sections.descendants.map((entry) => entry.id), [child.id]);
  assert.deepEqual(rolledUp.sections.global, []);
  assert.ok(!contextIds(rolledUp).includes(neighbour.id));
  assert.equal(new Set(contextIds(rolledUp)).size, contextIds(rolledUp).length);
  await closeStore(store);
}

async function scenarioLiteralSearch(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("search", "literal-ranking");
  const store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const { core } = createSqliteCoreHarness(store);
  const literal = await saveSearchMemory(core, "literal", {
    scope: "synthetic/task/HU-2",
    type: "decision",
    title: "Alpha OR title",
    content: "The words alpha, or, and title are ordinary searchable data.",
    tags: ["literal", "fts"],
  });
  await saveSearchMemory(core, "missing-term", {
    scope: "synthetic/task/HU-2",
    type: "decision",
    title: "Alpha title",
    content: "This row intentionally lacks the middle literal term.",
    tags: ["literal", "fts"],
  });
  await saveSearchMemory(core, "wrong-type", {
    scope: "synthetic/task/HU-2",
    type: "bug",
    title: "Alpha OR title",
    content: "alpha or title",
    tags: ["literal", "fts"],
  });
  await saveSearchMemory(core, "wrong-tag", {
    scope: "synthetic/task/HU-2",
    type: "decision",
    title: "Alpha OR title",
    content: "alpha or title",
    tags: ["other"],
  });
  await saveSearchMemory(core, "neighbour", {
    scope: "synthetic/task/HU-20",
    title: "Alpha OR title",
    content: "alpha or title",
    tags: ["literal", "fts"],
  });
  await saveSearchMemory(core, "foreign", {
    scope: "other/task",
    title: "Alpha OR title",
    content: "alpha or title",
    tags: ["literal", "fts"],
  });
  const peer = await saveSearchMemory(core, "peer", {
    scope: "synthetic/task/HU-2",
    title: "Unrelated relation endpoint",
    content: "No matching phrase is stored here.",
  });
  await core.pinMemory({ id: literal.id });
  await core.linkMemory({ sourceId: literal.id, targetId: peer.id, type: "related" });
  const result = await core.searchMemory({
    scope: "synthetic/task/HU-2",
    query: "Alpha OR title:*",
    includeGlobal: false,
    types: ["decision"],
    tags: ["LITERAL", "fts"],
    limit: 20,
  });
  assert.deepEqual(result.items.map((item) => item.memory.id), [literal.id]);
  const rank = result.items[0]!.rank;
  assert.equal(rank.scopeClass, "exact");
  assert.equal(rank.pinned, true);
  assert.equal(rank.relationCount, 1);
  assert.ok(Number.isInteger(rank.textScore) && rank.textScore >= 1 && rank.textScore <= 1000);
  await closeStore(store);
}

async function scenarioFtsRebuild(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("search", "fts-rebuild");
  let store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const firstCore = createSqliteCoreHarness(store).core;
  const memory = await saveSearchMemory(firstCore, "rebuildable", {
    title: "Rebuildable comet",
    content: "A rebuildable comet is present only in canonical memory data.",
    tags: ["rebuildable"],
  });
  const before = await store.read((transaction) => transaction.getStoreInfo());
  await closeStore(store);
  const database = openRawDatabase(sandbox.databasePath);
  database.exec("INSERT INTO memory_fts(memory_fts) VALUES('delete-all')");
  closeRawDatabase(database);

  store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "write",
  });
  const core = createSqliteCoreHarness(store).core;
  await expectHorielErrorCode(Promise.resolve(store.verifyIntegrity()), "integrity_failed");
  assert.deepEqual(await core.getMemory({ id: memory.id }), memory);
  try {
    const closed = await core.searchMemory({
      scope: "synthetic/task",
      query: "rebuildable comet",
      includeGlobal: false,
      limit: 10,
    });
    assert.deepEqual(closed.items, []);
  } catch (error) {
    assert.equal((error as { code?: string }).code, "integrity_failed");
  }
  await store.rebuildSearchIndex();
  await store.verifyIntegrity();
  assert.deepEqual(await store.read((transaction) => transaction.getStoreInfo()), before);
  assert.deepEqual(await core.getMemory({ id: memory.id }), memory);
  const rebuilt = await core.searchMemory({
    scope: "synthetic/task",
    query: "rebuildable comet",
    includeGlobal: false,
    limit: 10,
  });
  assert.deepEqual(rebuilt.items.map((item) => item.memory.id), [memory.id]);
  await closeStore(store);
}

async function scenarioCursors(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("search", "cursor-primary");
  const store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const { core } = createSqliteCoreHarness(store);
  const expectedIds: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    expectedIds.push((await saveSearchMemory(core, `cursor-${index}`, {
      title: `Cursor alpha ${index}`,
      content: "cursoralpha stable pagination",
      tags: ["cursor"],
    })).id);
  }
  const request = {
    scope: "synthetic/task",
    query: "cursoralpha",
    includeAncestors: false,
    rollup: false,
    includeGlobal: false,
    limit: 2,
  } as const;
  const first = await core.searchMemory(request);
  assert.deepEqual(await core.searchMemory(request), first);
  assert.equal(first.items.length, 2);
  assert.match(first.nextCursor!, /^[A-Za-z0-9_-]+$/);
  assert.ok(!first.nextCursor!.includes("cursoralpha"));
  const firstCursor = first.nextCursor!;
  const collected = first.items.map((item) => item.memory.id);
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor) {
    const page = await core.searchMemory({ ...request, cursor });
    assert.equal(page.sequence, first.sequence);
    collected.push(...page.items.map((item) => item.memory.id));
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages <= 3);
  }
  assert.equal(collected.length, 5);
  assert.equal(new Set(collected).size, 5);
  assert.deepEqual(new Set(collected), new Set(expectedIds));
  await expectHorielErrorCode(core.searchMemory({ ...request, query: "cursoralpha changed", cursor: firstCursor }), "conflict");
  await expectHorielErrorCode(core.searchMemory({ ...request, types: ["decision"], cursor: firstCursor }), "conflict");
  await expectHorielErrorCode(core.searchMemory({ ...request, cursor: tamperOpaqueCursor(firstCursor) }), [
    "invalid_input",
    "conflict",
  ]);

  const otherSandbox = createHorielSqliteSandbox("search", "cursor-other-store");
  const otherStore = await openStore(adapter, {
    databasePath: otherSandbox.databasePath,
    snapshotDirectory: otherSandbox.snapshotDirectory,
    access: "create",
  });
  const otherCore = createSqliteCoreHarness(otherStore).core;
  await expectHorielErrorCode(otherCore.searchMemory({ ...request, cursor: firstCursor }), "conflict");
  await closeStore(otherStore);
  await saveSearchMemory(core, "cursor-sequence-change", {
    title: "Cursor sequence mutation",
    content: "This changes the store sequence.",
  });
  await expectHorielErrorCode(core.searchMemory({ ...request, cursor: firstCursor }), "conflict");
  await closeStore(store);
}

async function scenarioBackup(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("administration", "backup");
  const store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const { core } = createSqliteCoreHarness(store);
  const first = await saveSyntheticMemory(core, "backup-first", { title: "First backup row" });
  const second = await saveSyntheticMemory(core, "backup-second", { title: "Second backup row" });
  await core.pinMemory({ id: first.id });
  await core.linkMemory({ sourceId: first.id, targetId: second.id, type: "related" });
  await core.saveSessionCheckpoint({
    scope: "synthetic/task",
    sessionRef: "session-backup-0001",
    idempotencyKey: "sqlite-backup-checkpoint-0001",
    objective: "Create a consistent physical snapshot",
    implemented: ["synthetic records"],
    verified: ["snapshot inspection"],
    pending: [],
    decisions: ["keep snapshot private"],
    blockers: [],
    validations: ["integrity check"],
    nextStep: "Inspect the snapshot",
  });
  const info = await store.read((transaction) => transaction.getStoreInfo());
  const snapshot = await core.createBackup();
  assert.equal(snapshot.storeId, info.storeId);
  assert.equal(snapshot.schemaVersion, adapter.HORIEL_SQLITE_SCHEMA_VERSION);
  assert.equal(snapshot.sequence, info.sequence);
  assert.deepEqual(snapshot.counts, { memories: 2, checkpoints: 1, pins: 1, relations: 1 });
  assert.equal(snapshot.verified, true);
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(await store.inspectSnapshot(snapshot.id), snapshot);

  const snapshotPath = findSnapshotDatabase(sandbox.snapshotDirectory, snapshot.id);
  assert.ok(fs.realpathSync(snapshotPath).startsWith(fs.realpathSync(sandbox.snapshotDirectory)));
  if (process.platform !== "win32") {
    assert.equal(fileMode(snapshotPath), 0o600);
    assert.equal(fileMode(sandbox.snapshotDirectory), 0o700);
  }
  assert.equal(sha256File(snapshotPath), snapshot.fingerprint);
  const physical = openRawDatabase(snapshotPath, { readOnly: true });
  assert.equal(sqliteValue(physical, "PRAGMA application_id"), adapter.HORIEL_SQLITE_APPLICATION_ID);
  assert.equal(sqliteValue(physical, "SELECT count(*) FROM memories"), 2);
  assert.equal(sqliteValue(physical, "SELECT count(*) FROM session_checkpoints"), 1);
  assert.equal(sqliteValue(physical, "SELECT count(*) FROM pins"), 1);
  assert.equal(sqliteValue(physical, "SELECT count(*) FROM relations"), 1);
  closeRawDatabase(physical);
  await store.verifyIntegrity();
  await closeStore(store);
}

async function scenarioRestore(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("administration", "restore");
  const store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const { core, clock } = createSqliteCoreHarness(store);
  const first = await saveSyntheticMemory(core, "restore-first", {
    title: "Original first",
    content: "Original first content.",
  });
  const second = await saveSyntheticMemory(core, "restore-second", { title: "Original second" });
  await core.pinMemory({ id: first.id });
  const relation = await core.linkMemory({ sourceId: first.id, targetId: second.id, type: "conflicts_with" });
  const checkpoint = await core.saveSessionCheckpoint({
    scope: "synthetic/task",
    sessionRef: "session-restore-0001",
    idempotencyKey: "sqlite-restore-checkpoint-0001",
    objective: "Restore all canonical entities",
    implemented: ["snapshot baseline"],
    verified: [],
    pending: ["restore"],
    decisions: [],
    blockers: [],
    validations: [],
    nextStep: "Mutate then restore",
  });
  const snapshot = await core.createBackup();
  clock.advance(1_000);
  await core.updateMemory({ id: first.id, expectedVersion: 1, content: "Changed after the snapshot." });
  await core.unpinMemory({ id: first.id });
  await core.unlinkMemory({ sourceId: first.id, targetId: second.id, type: "conflicts_with" });
  const extra = await saveSyntheticMemory(core, "restore-extra", { title: "Must disappear after restore" });
  const stale = await core.previewRestore({ snapshotId: snapshot.id });
  const afterPreview = await saveSyntheticMemory(core, "restore-stale-mutation", {
    title: "Makes the restore preview stale",
  });
  await expectHorielErrorCode(core.restore({ previewId: stale.id, confirmation: stale.confirmation }), "confirmation_mismatch");
  assert.equal((await core.getMemory({ id: afterPreview.id })).id, afterPreview.id);
  const preview = await core.previewRestore({ snapshotId: snapshot.id });
  await expectHorielErrorCode(core.restore({
    previewId: preview.id,
    confirmation: `${preview.confirmation}-wrong`,
  }), "confirmation_mismatch");
  const beforeRestore = await store.read((transaction) => transaction.getStoreInfo());
  const restored = await core.restore({ previewId: preview.id, confirmation: preview.confirmation });
  assert.deepEqual(restored.snapshot, snapshot);
  assert.equal(restored.backup.verified, true);
  assert.deepEqual(await core.getMemory({ id: first.id }), first);
  assert.deepEqual(await core.getMemory({ id: second.id }), second);
  await expectHorielErrorCode(core.getMemory({ id: extra.id }), "not_found");
  await expectHorielErrorCode(core.getMemory({ id: afterPreview.id }), "not_found");
  const canonical = await store.read(async (transaction) => ({
    checkpoint: await transaction.getCheckpoint(checkpoint.checkpoint.id),
    pinned: await transaction.isPinned(first.id),
    relation: await transaction.getRelation("conflicts_with", relation.relation.sourceId, relation.relation.targetId),
    info: await transaction.getStoreInfo(),
  }));
  assert.deepEqual(canonical.checkpoint, checkpoint.checkpoint);
  assert.equal(canonical.pinned, true);
  assert.deepEqual(canonical.relation, relation.relation);
  assert.equal(canonical.info.storeId, beforeRestore.storeId);
  assert.equal(canonical.info.sequence, beforeRestore.sequence + 1);
  await expectHorielErrorCode(core.restore({ previewId: preview.id, confirmation: preview.confirmation }), "confirmation_mismatch");
  await store.verifyIntegrity();
  await closeStore(store);
}

async function scenarioPreSwapFailure(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("administration", "pre-swap-failure");
  const store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const { core, clock } = createSqliteCoreHarness(store);
  const original = await saveSyntheticMemory(core, "pre-swap", {
    title: "Snapshot value",
    content: "This value exists in the snapshot.",
  });
  const snapshot = await core.createBackup();
  clock.advance(1_000);
  const live = await core.updateMemory({
    id: original.id,
    expectedVersion: 1,
    title: "Live value",
    content: "This live value must survive a pre-swap failure.",
  });
  const preview = await core.previewRestore({ snapshotId: snapshot.id });
  const liveInfo = await store.read((transaction) => transaction.getStoreInfo());
  const snapshotPath = findSnapshotDatabase(sandbox.snapshotDirectory, snapshot.id);
  const damaged = openRawDatabase(snapshotPath);
  damaged.prepare("DELETE FROM memory_versions WHERE memory_id = ? AND version = 1").run(original.id);
  closeRawDatabase(damaged);
  await expectHorielErrorCode(store.inspectSnapshot(snapshot.id), "integrity_failed");
  await expectHorielErrorCode(core.restore({ previewId: preview.id, confirmation: preview.confirmation }), "integrity_failed");
  assert.deepEqual(await core.getMemory({ id: original.id }), live.memory);
  assert.deepEqual(await store.read((transaction) => transaction.getStoreInfo()), liveInfo);
  await store.verifyIntegrity();
  await closeStore(store);
}

async function scenarioBusyWriter(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("recovery", "busy-writer");
  const firstStore = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
    busyTimeoutMs: 25,
  });
  const secondStore = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "write",
    busyTimeoutMs: 25,
  });
  const firstRecord = syntheticMemory(100);
  const blockedRecord = syntheticMemory(101);
  let releaseWriter!: () => void;
  let markEntered!: () => void;
  const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const firstWrite = firstStore.write(async (transaction) => {
    await transaction.insertMemory(firstRecord);
    markEntered();
    await release;
  });
  await entered;
  try {
    await expectHorielErrorCode(secondStore.write((transaction) => transaction.insertMemory(blockedRecord)), "busy");
  } finally {
    releaseWriter();
    await firstWrite;
  }
  assert.deepEqual(await secondStore.read((transaction) => transaction.getMemory(firstRecord.id)), firstRecord);
  assert.equal(await secondStore.read((transaction) => transaction.getMemory(blockedRecord.id)), undefined);
  assert.equal((await secondStore.read((transaction) => transaction.getStoreInfo())).sequence, 1);
  await closeStore(secondStore);
  await closeStore(firstStore);
}

function runCrashProcess(databasePath: string, cwd: string): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const fixture = path.join(HORIEL_REPO_ROOT, "tests", "fixtures", "horiel-sqlite-crash.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn("node", [fixture, databasePath], {
      cwd: assertHorielSandboxPath(cwd),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function scenarioCrashRecovery(adapter: HorielSqliteAdapterModule): Promise<void> {
  const sandbox = createHorielSqliteSandbox("recovery", "crash");
  let store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "create",
  });
  const { core } = createSqliteCoreHarness(store);
  const original = await saveSyntheticMemory(core, "crash-original", {
    title: "Committed value",
    content: "Only this committed content may survive recovery.",
  });
  const before = await store.read((transaction) => transaction.getStoreInfo());
  await closeStore(store);
  const crashed = await runCrashProcess(sandbox.databasePath, sandbox.root);
  assert.match(crashed.stdout, /horiel-crash-transaction-started/);
  assert.equal(crashed.code, null);
  assert.equal(crashed.signal, "SIGKILL");
  store = await openStore(adapter, {
    databasePath: sandbox.databasePath,
    snapshotDirectory: sandbox.snapshotDirectory,
    access: "write",
  });
  const reopened = createSqliteCoreHarness(store).core;
  assert.deepEqual(await reopened.getMemory({ id: original.id }), original);
  assert.deepEqual(await store.read((transaction) => transaction.getStoreInfo()), before);
  await store.verifyIntegrity();
  await closeStore(store);
  const database = openRawDatabase(sandbox.databasePath, { readOnly: true });
  assert.equal(
    String(sqliteValue(database, "PRAGMA journal_mode")).toLowerCase(),
    adapter.HORIEL_SQLITE_JOURNAL_MODE.toLowerCase(),
  );
  closeRawDatabase(database);
  const sidecars = fs.readdirSync(path.dirname(sandbox.databasePath))
    .filter((entry) => /-(?:wal|shm|journal)$/i.test(entry));
  assert.deepEqual(sidecars, []);
}

async function scenarioBoundaryApi(adapter: HorielSqliteAdapterModule): Promise<void> {
  assert.equal(typeof adapter.openHorielSqliteStore, "function");
  assert.equal(adapter.HORIEL_SQLITE_SCHEMA_VERSION, 1);
  assert.equal(adapter.HORIEL_SQLITE_JOURNAL_MODE.toLowerCase(), "delete");
  assert.ok(Number.isSafeInteger(adapter.HORIEL_SQLITE_APPLICATION_ID));
  assert.notEqual(adapter.HORIEL_SQLITE_APPLICATION_ID, 0);
  if (adapter.inspectHorielSqliteFile !== undefined) {
    assert.equal(typeof adapter.inspectHorielSqliteFile, "function");
  }
}

const SCENARIOS: Record<NodeScenarioGroup, Array<{
  name: string;
  run(adapter: HorielSqliteAdapterModule): Promise<void>;
}>> = {
  store: [
    { name: NODE_SCENARIO_NAMES.store[0], run: scenarioCreateSchema },
    { name: NODE_SCENARIO_NAMES.store[1], run: scenarioUnsafePaths },
    { name: NODE_SCENARIO_NAMES.store[2], run: scenarioCoreContract },
    { name: NODE_SCENARIO_NAMES.store[3], run: scenarioSequence },
    { name: NODE_SCENARIO_NAMES.store[4], run: scenarioRollback },
  ],
  search: [
    { name: NODE_SCENARIO_NAMES.search[0], run: scenarioContextScopes },
    { name: NODE_SCENARIO_NAMES.search[1], run: scenarioLiteralSearch },
    { name: NODE_SCENARIO_NAMES.search[2], run: scenarioFtsRebuild },
    { name: NODE_SCENARIO_NAMES.search[3], run: scenarioCursors },
  ],
  administration: [
    { name: NODE_SCENARIO_NAMES.administration[0], run: scenarioBackup },
    { name: NODE_SCENARIO_NAMES.administration[1], run: scenarioRestore },
    { name: NODE_SCENARIO_NAMES.administration[2], run: scenarioPreSwapFailure },
  ],
  recovery: [
    { name: NODE_SCENARIO_NAMES.recovery[0], run: scenarioBusyWriter },
    { name: NODE_SCENARIO_NAMES.recovery[1], run: scenarioCrashRecovery },
  ],
  boundary: [
    { name: NODE_SCENARIO_NAMES.boundary[0], run: scenarioBoundaryApi },
  ],
};

function errorText(error: unknown): string {
  if (error instanceof AggregateError) {
    const nested = [...error.errors].map(errorText).filter(Boolean).join("\n");
    const own = error.stack ?? `${error.name}: ${error.message}`;
    return nested ? `${own}\n${nested}` : own;
  }
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  if (error && typeof error === "object") {
    const value = error as {
      message?: unknown;
      position?: { file?: unknown; line?: unknown; column?: unknown };
      notes?: unknown[];
      errors?: unknown[];
    };
    const location = value.position?.file
      ? `${String(value.position.file)}:${String(value.position.line ?? "?")}:${String(value.position.column ?? "?")}`
      : "";
    const message = value.message === undefined ? "" : String(value.message);
    const nested = [
      ...(value.errors ?? []),
      ...(value.notes ?? []),
    ].map(errorText).filter(Boolean).join("\n");
    const own = [location, message].filter(Boolean).join(" ");
    if (own || nested) return [own, nested].filter(Boolean).join("\n");
  }
  return String(error);
}

async function executeNodeScenarioGroup(group: NodeScenarioGroup): Promise<NodeScenarioReport> {
  const results: NodeScenarioResult[] = [];
  if (process.versions.node !== "22.18.0") {
    const error = `Expected Node 22.18.0, received ${process.versions.node}`;
    return {
      group,
      nodeVersion: process.versions.node,
      results: SCENARIOS[group].map(({ name }) => ({ name, status: "failed", durationMs: 0, error })),
    };
  }

  let adapter: HorielSqliteAdapterModule;
  try {
    await loadSqliteCapabilities();
    adapter = await loadAdapter();
  } catch (error) {
    return {
      group,
      nodeVersion: process.versions.node,
      results: SCENARIOS[group].map(({ name }) => ({
        name,
        status: "failed",
        durationMs: 0,
        error: errorText(error),
      })),
    };
  }

  for (const scenario of SCENARIOS[group]) {
    const started = performance.now();
    try {
      await scenario.run(adapter);
      results.push({ name: scenario.name, status: "passed", durationMs: performance.now() - started });
    } catch (error) {
      results.push({
        name: scenario.name,
        status: "failed",
        durationMs: performance.now() - started,
        error: errorText(error),
      });
    } finally {
      await closeLeakedResources();
      cleanupHorielSqliteSandbox(group === "boundary" ? "boundary" : group);
    }
  }
  return { group, nodeVersion: process.versions.node, results };
}

function buildFailureReport(group: NodeScenarioGroup, error: string): NodeScenarioReport {
  return {
    group,
    nodeVersion: "not-started",
    results: NODE_SCENARIO_NAMES[group].map((name) => ({
      name,
      status: "failed",
      durationMs: 0,
      error,
    })),
  };
}

export async function runNodeScenarioGroup(group: NodeScenarioGroup): Promise<NodeScenarioReport> {
  const bun = (globalThis as unknown as { Bun?: any }).Bun;
  if (!bun?.build || !bun?.spawn) {
    return buildFailureReport(group, "The Bun test orchestrator is unavailable.");
  }
  const runnerDirectory = assertHorielSandboxPath(path.join(
    HORIEL_SQLITE_SANDBOX_ROOT,
    "runner",
    safeSegment(group),
  ));
  fs.rmSync(runnerDirectory, { recursive: true, force: true });
  fs.mkdirSync(runnerDirectory, { recursive: true, mode: 0o700 });
  const reportPath = assertHorielSandboxPath(path.join(runnerDirectory, "report.json"));
  let stdout = "";
  let stderr = "";
  try {
    let build: any;
    try {
      build = await bun.build({
        entrypoints: [fileURLToPath(import.meta.url)],
        outdir: runnerDirectory,
        target: "node",
        format: "esm",
        naming: "horiel-sqlite-runner.mjs",
        sourcemap: "inline",
        external: ["node:sqlite"],
        write: true,
      });
    } catch (error) {
      return buildFailureReport(group, `Node runner build failed: ${errorText(error)}`);
    }
    if (!build.success) {
      const diagnostics = build.logs
        .map((log: { message?: string }) => log.message ?? String(log))
        .join("\n");
      return buildFailureReport(group, `Node runner build failed:\n${diagnostics}`);
    }
    const bundlePath = build.outputs[0]?.path
      ?? path.join(runnerDirectory, "horiel-sqlite-runner.mjs");
    const child = bun.spawn(["node", bundlePath], {
      cwd: runnerDirectory,
      env: {
        ...process.env,
        HORIEL_SQLITE_NODE_RUNNER: "1",
        HORIEL_SQLITE_NODE_GROUP: group,
        HORIEL_SQLITE_REPORT_PATH: reportPath,
        HORIEL_SQLITE_REPO_ROOT: HORIEL_REPO_ROOT,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, childStdout, childStderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    stdout = childStdout;
    stderr = childStderr;
    if (!fs.existsSync(reportPath)) {
      return buildFailureReport(
        group,
        `Node runner exited ${exitCode} without a report.\n${stderr || stdout}`,
      );
    }
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as NodeScenarioReport;
    return { ...report, stdout, stderr };
  } finally {
    fs.rmSync(runnerDirectory, { recursive: true, force: true });
    const runnerRoot = path.dirname(runnerDirectory);
    try {
      if (fs.readdirSync(runnerRoot).length === 0) fs.rmdirSync(runnerRoot);
    } catch {
      // Parallel groups can still be using the shared runner parent.
    }
  }
}

export function assertNodeScenario(report: NodeScenarioReport, scenarioName: string): void {
  const result = report.results.find(({ name }) => name === scenarioName);
  if (!result) throw new Error(`Node runner omitted scenario: ${scenarioName}`);
  if (result.status !== "passed") {
    throw new Error(
      `[Node ${report.nodeVersion}] ${scenarioName}\n${result.error ?? "Unknown Node scenario failure"}`,
    );
  }
}

if (process.env.HORIEL_SQLITE_NODE_RUNNER === "1") {
  const group = process.env.HORIEL_SQLITE_NODE_GROUP as NodeScenarioGroup;
  const reportPath = assertHorielSandboxPath(process.env.HORIEL_SQLITE_REPORT_PATH ?? "");
  let report: NodeScenarioReport;
  if (!(group in SCENARIOS)) {
    report = buildFailureReport(group, `Unknown Node scenario group: ${String(group)}`);
  } else {
    report = await executeNodeScenarioGroup(group);
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (report.results.some(({ status }) => status === "failed")) process.exitCode = 1;
}
