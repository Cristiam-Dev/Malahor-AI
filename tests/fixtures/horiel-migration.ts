import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const HORIEL_MIGRATION_REPO_ROOT = path.resolve(
  process.env.HORIEL_MIGRATION_REPO_ROOT ?? sourceRepositoryRoot,
);
export const HORIEL_MIGRATION_SANDBOX_ROOT = path.join(
  "/tmp/opencode",
  `malahor-horiel-p5-${process.pid}`,
);

type ScenarioGroup = "mapping" | "apply" | "recovery" | "boundary";
type MigrationFaultPoint =
  | "after-backup"
  | "after-staging-created"
  | "after-transformed"
  | "after-validated";

interface MigrationInput {
  sandboxRoot: string;
  installationId: string;
  source: { backend: "json" | "sqlite"; filePath: string };
  aliases?: Record<string, string[]>;
  targetDirectory: string;
}

interface ManifestEntry {
  kind: string;
  status: "mapped" | "derived" | "blocked";
  sourceKey: string;
  sourceDigest: string;
  targetId?: string;
  targetDigest?: string;
  targetScope?: string;
  transformations: string[];
  block?: { code: string; findingHash?: string };
}

interface MigrationManifest {
  migrationId: string;
  approvalHash: string;
  revisionHash: string;
  state: string;
  entries: ManifestEntry[];
  counts: {
    source: { observations: number; sessions: number; pins: number; relations: number };
    target: { memories: number; checkpoints: number; pins: number; relations: number };
    mapped: number;
    derived: number;
    blocked: number;
  };
  backup?: { verified: boolean; hash: string; size: number };
  target?: { storeId: string; sequence: number; fingerprint: string };
}

interface MigrationPreview {
  migrationId: string;
  sourceFingerprint: string;
  manifestHash: string;
  canApply: boolean;
  resumable: boolean;
  manifest: MigrationManifest;
  paths: {
    transactionDirectory: string;
    manifestPath: string;
    backupPath: string;
    stagingDatabasePath: string;
  };
  input: MigrationInput;
}

interface MigrationResult {
  migrationId: string;
  state: "validated";
  resumed: boolean;
  sourceFingerprint: string;
  targetFingerprint: string;
  manifestHash: string;
  paths: MigrationPreview["paths"];
  manifest: MigrationManifest;
}

interface ManifestSnapshot {
  manifest: MigrationManifest;
  revisionHash: string;
  manifestPath: string;
}

interface MigrationAdapter {
  previewHorielMigration(input: MigrationInput): Promise<MigrationPreview>;
  applyHorielMigration(input: {
    preview: MigrationPreview;
    expectedManifestHash: string;
    faultAt?: MigrationFaultPoint;
  }): Promise<MigrationResult>;
  readHorielMigrationManifest(input: {
    sandboxRoot: string;
    migrationId: string;
  }): ManifestSnapshot | null;
  verifyHorielMigration(input: {
    preview: MigrationPreview;
    expectedManifestHash: string;
  }): Promise<MigrationResult>;
}

interface ScenarioResult {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  error?: string;
}

export interface MigrationScenarioReport {
  group: ScenarioGroup;
  nodeVersion: string;
  results: ScenarioResult[];
  stdout?: string;
  stderr?: string;
}

export const MIGRATION_SCENARIO_NAMES: Record<ScenarioGroup, readonly string[]> = {
  mapping: [
    "maps JSON deterministically with a total manifest",
    "changes the migration revision when the source changes",
    "blocks incompatible entities without disclosing sensitive values",
    "reads SQLite v1 with pins and relations without mutating it",
  ],
  apply: [
    "backs up before creating a canonical Horiel staging store",
    "preserves SQLite pins, relations and source bytes",
    "repeats the same apply without duplicating entities",
    "detects target divergence even when counts still match",
  ],
  recovery: [
    "resumes every durable pre-validation fault point",
    "rejects a truncated or forged manifest",
    "rejects recovery after the source fingerprint changes",
  ],
  boundary: [
    "rejects source and target paths outside the sandbox",
    "rejects symlinks, hardlinks and reserved transaction paths",
    "rejects an unrelated existing target without overwriting it",
    "keeps the migrator disconnected from runtime and provider markers",
  ],
};

interface JsonObservation {
  id: number;
  project: string;
  type: "decision" | "bug" | "pattern" | "architecture" | "learning" | "general";
  title: string;
  content: string;
  tags: string;
  created_at: string;
}

interface JsonSession {
  project: string;
  summary: string;
  created_at: string;
}

interface JsonFixture {
  observations: JsonObservation[];
  sessions: JsonSession[];
  nextId: number;
}

const FIXED_TIMES = [
  "2026-10-01T10:00:00.000Z",
  "2026-10-02T10:00:00.000Z",
  "2026-10-03T10:00:00.000Z",
  "2026-10-04T10:00:00.000Z",
  "2026-10-05T10:00:00.000Z",
  "2026-10-06T10:00:00.000Z",
] as const;

function jsonFixture(): JsonFixture {
  const types = ["decision", "bug", "pattern", "architecture", "learning", "general"] as const;
  return {
    observations: types.map((type, index) => ({
      id: index + 1,
      project: index === 0 ? "global" : index < 3 ? "Legacy Acme/App" : "acme/app/feature",
      type,
      title: `Synthetic ${type}`,
      content: `Neutral migration payload ${index + 1}`,
      tags: index === 0 ? "" : index === 1 ? " Alpha " : `tag-${index + 1}`,
      created_at: FIXED_TIMES[index]!,
    })),
    sessions: [
      {
        project: "Legacy Acme/App",
        summary: "Synthetic checkpoint summary one.",
        created_at: FIXED_TIMES[1],
      },
      {
        project: "global",
        summary: "Synthetic global checkpoint summary.",
        created_at: FIXED_TIMES[2],
      },
    ],
    nextId: 20,
  };
}

function migrationInput(root: string, backend: "json" | "sqlite", source: string, suffix = "target"): MigrationInput {
  return {
    sandboxRoot: root,
    installationId: `synthetic-${backend}-${suffix}`,
    source: { backend, filePath: source },
    aliases: { acme: ["Legacy Acme"] },
    targetDirectory: path.join(root, suffix),
  };
}

function scenarioRoot(group: ScenarioGroup, scenario: string): string {
  const root = path.join(HORIEL_MIGRATION_SANDBOX_ROOT, group, safeSegment(scenario));
  assertInside(HORIEL_MIGRATION_SANDBOX_ROOT, root);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(root, 0o700);
  return root;
}

function writeJsonSource(root: string, fixture = jsonFixture(), name = "mnemo.json"): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return file;
}

async function writeSqliteSource(root: string): Promise<string> {
  const [{ DatabaseSync }, schema] = await Promise.all([
    import("node:sqlite"),
    import("../../src/mnemo/engine/schema"),
  ]);
  const file = path.join(root, "mnemo.sqlite");
  const database = new DatabaseSync(file, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    database.exec(schema.MEMORY_SCHEMA);
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO scopes(path, parent_path, depth) VALUES (?, ?, ?)").run("acme", null, 0);
    database.prepare("INSERT INTO scopes(path, parent_path, depth) VALUES (?, ?, ?)").run("acme/app", "acme", 1);
    database.prepare(`
      INSERT INTO observations(id, scope_path, type, title, content, tags, created_at, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(7, "acme/app", "decision", "SQLite decision", "First SQLite payload", "ALPHA", FIXED_TIMES[0], 0);
    database.prepare(`
      INSERT INTO observations(id, scope_path, type, title, content, tags, created_at, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(11, "global", "bug", "SQLite bug", "Second SQLite payload", "", FIXED_TIMES[1], 1);
    database.prepare(`
      INSERT INTO sessions(id, scope_path, summary, created_at, position)
      VALUES (?, ?, ?, ?, ?)
    `).run("session-fixture-1", "acme/app", "SQLite session summary.", FIXED_TIMES[2], 0);
    database.prepare("INSERT INTO pins(observation_id, created_at) VALUES (?, ?)").run(7, FIXED_TIMES[3]);
    database.prepare(`
      INSERT INTO relations(source_id, target_id, kind, created_at) VALUES (?, ?, ?, ?)
    `).run(7, 11, "supersedes", FIXED_TIMES[4]);
    database.prepare(`
      INSERT INTO relations(source_id, target_id, kind, created_at) VALUES (?, ?, ?, ?)
    `).run(11, 7, "conflicts", FIXED_TIMES[5]);
    database.exec(`
      UPDATE memory_state
         SET next_observation_id = 20,
             next_observation_position = 2,
             next_session_position = 1
       WHERE singleton = 1;
      COMMIT;
    `);
  } finally {
    database.close();
  }
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return file;
}

async function loadAdapter(): Promise<MigrationAdapter> {
  return await import("../../src/horiel/migration/index") as unknown as MigrationAdapter;
}

async function scenarioJsonDeterminism(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("mapping", "json-determinism");
  try {
    const source = writeJsonSource(root);
    const input = migrationInput(root, "json", source);
    const first = await adapter.previewHorielMigration(input);
    const second = await adapter.previewHorielMigration(input);

    assert.equal(first.canApply, true);
    assert.equal(first.resumable, false);
    assert.equal(fs.existsSync(input.targetDirectory), false);
    assert.equal(second.migrationId, first.migrationId);
    assert.equal(second.sourceFingerprint, first.sourceFingerprint);
    assert.equal(second.manifestHash, first.manifestHash);
    assert.deepEqual(second.manifest.entries, first.manifest.entries);
    assert.equal(first.manifest.counts.source.observations, 6);
    assert.equal(first.manifest.counts.source.sessions, 2);
    assert.equal(first.manifest.counts.blocked, 0);
    assert.equal(first.manifest.entries.some(({ status }) => (status as string) === "ignored"), false);

    const observationEntries = first.manifest.entries.filter(({ kind }) => kind === "observation");
    const sessionEntries = first.manifest.entries.filter(({ kind }) => kind === "session");
    assert.equal(observationEntries.length, 6);
    assert.equal(sessionEntries.length, 2);
    assert.equal(new Set(observationEntries.map(({ targetId }) => targetId)).size, 6);
    assert.ok(observationEntries.every(({ targetId }) => /^mem_[a-f0-9]{32}$/.test(targetId ?? "")));
    assert.ok(sessionEntries.every(({ targetId }) => /^chk_[a-f0-9]{32}$/.test(targetId ?? "")));
    assert.ok(first.manifest.entries.some(({ kind, status }) => kind === "fts" && status === "derived"));
    assert.ok(first.manifest.entries.some(({ kind, status }) => kind === "counter" && status === "derived"));
    assert.ok(first.manifest.entries.some(({ targetScope }) => targetScope === "@global"));
    assert.ok(observationEntries.some(({ transformations }) => transformations.includes("opaque-tag-normalization-v1")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioChangedSource(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("mapping", "changed-source");
  try {
    const source = writeJsonSource(root);
    const input = migrationInput(root, "json", source);
    const first = await adapter.previewHorielMigration(input);
    const changed = jsonFixture();
    changed.observations[0] = { ...changed.observations[0]!, content: "Changed neutral payload" };
    writeJsonSource(root, changed);
    const second = await adapter.previewHorielMigration(input);
    assert.notEqual(second.sourceFingerprint, first.sourceFingerprint);
    assert.notEqual(second.migrationId, first.migrationId);
    assert.notEqual(second.manifestHash, first.manifestHash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioBlockedEntities(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("mapping", "blocked-entities");
  try {
    const sensitive = ["api", "_key", "=", "synthetic-value-1234567890"].join("");
    const fixture = jsonFixture();
    fixture.observations[0] = { ...fixture.observations[0]!, project: "a/b/c/d/e" };
    fixture.observations[1] = { ...fixture.observations[1]!, created_at: "2026-10-02 10:00:00Z" };
    fixture.observations[2] = { ...fixture.observations[2]!, content: sensitive };
    fixture.observations[3] = { ...fixture.observations[3]!, tags: "x".repeat(65) };
    const source = writeJsonSource(root, fixture);
    const preview = await adapter.previewHorielMigration(migrationInput(root, "json", source));

    assert.equal(preview.canApply, false);
    assert.ok(preview.manifest.counts.blocked >= 4);
    const codes = preview.manifest.entries.flatMap(({ block }) => block ? [block.code] : []);
    assert.ok(codes.includes("scope-invalid"));
    assert.ok(codes.includes("timestamp-invalid"));
    assert.ok(codes.includes("sensitive-content"));
    assert.ok(codes.includes("tag-invalid"));
    const serialized = JSON.stringify(preview);
    assert.equal(serialized.includes(sensitive), false);
    assert.ok(preview.manifest.entries
      .filter(({ status }) => status === "blocked")
      .every(({ targetId, block }) => targetId === undefined && /^[a-z-]+$/.test(block?.code ?? "")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioSqlitePreview(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("mapping", "sqlite-preview");
  try {
    const source = await writeSqliteSource(root);
    const before = hashFile(source);
    const preview = await adapter.previewHorielMigration(migrationInput(root, "sqlite", source));
    assert.equal(preview.canApply, true);
    assert.equal(hashFile(source), before);
    assert.equal(preview.manifest.counts.source.observations, 2);
    assert.equal(preview.manifest.counts.source.sessions, 1);
    assert.equal(preview.manifest.counts.source.pins, 1);
    assert.equal(preview.manifest.counts.source.relations, 2);
    assert.equal(preview.manifest.entries.filter(({ kind }) => kind === "pin").length, 1);
    assert.equal(preview.manifest.entries.filter(({ kind }) => kind === "relation").length, 2);
    assert.ok(preview.manifest.entries
      .filter(({ kind }) => kind === "relation")
      .every(({ targetId }) => /^rel_[a-f0-9]{32}$/.test(targetId ?? "")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioApplyJson(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("apply", "apply-json");
  try {
    const source = writeJsonSource(root);
    const before = hashFile(source);
    const preview = await adapter.previewHorielMigration(migrationInput(root, "json", source));
    const result = await adapter.applyHorielMigration({
      preview,
      expectedManifestHash: preview.manifestHash,
    });
    assert.equal(result.state, "validated");
    assert.equal(result.manifest.state, "validated");
    assert.equal(result.manifest.backup?.verified, true);
    assert.equal(hashFile(source), before);
    assert.ok(fs.existsSync(result.paths.backupPath));
    assert.ok(fs.existsSync(result.paths.stagingDatabasePath));
    assert.ok(result.manifest.target?.storeId.startsWith("store_"));
    assert.ok(/^[a-f0-9]{64}$/.test(result.targetFingerprint));

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(result.paths.stagingDatabasePath, { readOnly: true, allowExtension: false });
    try {
      assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "delete");
      assert.equal((database.prepare("SELECT count(*) AS total FROM memories").get() as { total: number }).total, 6);
      assert.equal((database.prepare("SELECT count(*) AS total FROM memory_versions").get() as { total: number }).total, 6);
      assert.equal((database.prepare("SELECT count(*) AS total FROM session_checkpoints").get() as { total: number }).total, 2);
      assert.equal((database.prepare("SELECT count(*) AS total FROM memory_fts").get() as { total: number }).total, 6);
      assert.equal((database.prepare("SELECT count(*) AS total FROM memories WHERE scope = '@global'").get() as { total: number }).total, 1);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioApplySqlite(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("apply", "apply-sqlite");
  try {
    const source = await writeSqliteSource(root);
    const before = hashFile(source);
    const preview = await adapter.previewHorielMigration(migrationInput(root, "sqlite", source));
    const result = await adapter.applyHorielMigration({ preview, expectedManifestHash: preview.manifestHash });
    assert.equal(hashFile(source), before);

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(result.paths.stagingDatabasePath, { readOnly: true, allowExtension: false });
    try {
      const pin = database.prepare("SELECT memory_id, created_at FROM pins").get() as {
        memory_id: string;
        created_at: string;
      };
      assert.match(pin.memory_id, /^mem_[a-f0-9]{32}$/);
      assert.equal(pin.created_at, FIXED_TIMES[3]);
      const relations = (database.prepare("SELECT type, created_at FROM relations ORDER BY type").all() as Array<{
        type: string;
        created_at: string;
      }>).map(({ type, created_at }) => ({ type, created_at }));
      assert.deepEqual(relations, [
        { type: "conflicts_with", created_at: FIXED_TIMES[5] },
        { type: "supersedes", created_at: FIXED_TIMES[4] },
      ]);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioIdempotentApply(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("apply", "idempotent");
  try {
    const source = writeJsonSource(root);
    const preview = await adapter.previewHorielMigration(migrationInput(root, "json", source));
    const first = await adapter.applyHorielMigration({ preview, expectedManifestHash: preview.manifestHash });
    const second = await adapter.applyHorielMigration({ preview, expectedManifestHash: preview.manifestHash });
    assert.equal(second.resumed, true);
    assert.equal(second.targetFingerprint, first.targetFingerprint);
    assert.equal(second.manifest.target?.storeId, first.manifest.target?.storeId);
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(second.paths.stagingDatabasePath, { readOnly: true, allowExtension: false });
    try {
      assert.equal((database.prepare("SELECT count(*) AS total FROM memories").get() as { total: number }).total, 6);
      assert.equal((database.prepare("SELECT count(*) AS total FROM session_checkpoints").get() as { total: number }).total, 2);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioDifferential(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("apply", "differential");
  try {
    const source = writeJsonSource(root);
    const preview = await adapter.previewHorielMigration(migrationInput(root, "json", source));
    const result = await adapter.applyHorielMigration({ preview, expectedManifestHash: preview.manifestHash });
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(result.paths.stagingDatabasePath, { allowExtension: false });
    try {
      database.prepare("UPDATE memories SET content = ? WHERE id = (SELECT id FROM memories ORDER BY id LIMIT 1)")
        .run("Tampered neutral payload");
      database.prepare(`
        UPDATE memory_versions SET content = ?
         WHERE memory_id = (SELECT id FROM memories ORDER BY id LIMIT 1) AND version = 1
      `).run("Tampered neutral payload");
    } finally {
      database.close();
    }
    await assert.rejects(
      adapter.verifyHorielMigration({ preview, expectedManifestHash: preview.manifestHash }),
      (error: unknown) => errorCode(error) === "verification_failed",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioRecoveryFaults(adapter: MigrationAdapter): Promise<void> {
  const faults: Array<[MigrationFaultPoint, string]> = [
    ["after-backup", "backup-verified"],
    ["after-staging-created", "staging-created"],
    ["after-transformed", "transformed"],
    ["after-validated", "validated"],
  ];
  for (const [faultAt, expectedState] of faults) {
    const root = scenarioRoot("recovery", faultAt);
    try {
      const source = writeJsonSource(root);
      const preview = await adapter.previewHorielMigration(migrationInput(root, "json", source));
      await assert.rejects(
        adapter.applyHorielMigration({ preview, expectedManifestHash: preview.manifestHash, faultAt }),
        (error: unknown) => errorCode(error) === "fault_injected",
      );
      const interrupted = adapter.readHorielMigrationManifest({
        sandboxRoot: root,
        migrationId: preview.migrationId,
      });
      assert.equal(interrupted?.manifest.state, expectedState);
      assert.equal(fs.existsSync(preview.paths.backupPath), true);
      if (faultAt === "after-backup") {
        assert.equal(fs.existsSync(preview.paths.stagingDatabasePath), false);
        fs.writeFileSync(
          path.join(preview.paths.transactionDirectory, "migration.lock"),
          `${JSON.stringify({ migrationId: preview.migrationId, pid: 2_147_483_647, token: "stale" })}\n`,
          { mode: 0o600 },
        );
      }
      const resumed = await adapter.applyHorielMigration({ preview, expectedManifestHash: preview.manifestHash });
      assert.equal(resumed.state, "validated");
      assert.equal(resumed.resumed, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

async function scenarioForgedManifest(adapter: MigrationAdapter): Promise<void> {
  const variants = ["truncated", "forged"] as const;
  for (const variant of variants) {
    const root = scenarioRoot("recovery", `manifest-${variant}`);
    try {
      const source = writeJsonSource(root);
      const preview = await adapter.previewHorielMigration(migrationInput(root, "json", source));
      await assert.rejects(adapter.applyHorielMigration({
        preview,
        expectedManifestHash: preview.manifestHash,
        faultAt: "after-backup",
      }));
      if (variant === "truncated") {
        fs.writeFileSync(preview.paths.manifestPath, "{", { mode: 0o600 });
      } else {
        const parsed = JSON.parse(fs.readFileSync(preview.paths.manifestPath, "utf8")) as Record<string, unknown>;
        parsed.state = "validated";
        fs.writeFileSync(preview.paths.manifestPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
      }
      await assert.rejects(
        adapter.applyHorielMigration({ preview, expectedManifestHash: preview.manifestHash }),
        (error: unknown) => errorCode(error) === "manifest_invalid",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

async function scenarioChangedDuringRecovery(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("recovery", "changed-during-recovery");
  try {
    const source = writeJsonSource(root);
    const preview = await adapter.previewHorielMigration(migrationInput(root, "json", source));
    await assert.rejects(adapter.applyHorielMigration({
      preview,
      expectedManifestHash: preview.manifestHash,
      faultAt: "after-backup",
    }));
    const changed = jsonFixture();
    changed.sessions[0] = { ...changed.sessions[0]!, summary: "Changed after preview." };
    writeJsonSource(root, changed);
    await assert.rejects(
      adapter.applyHorielMigration({ preview, expectedManifestHash: preview.manifestHash }),
      (error: unknown) => errorCode(error) === "preview_mismatch",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioOutsideSandbox(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("boundary", "outside-sandbox");
  const outside = path.join("/tmp/opencode", `horiel-p5-outside-${process.pid}-${Date.now()}.json`);
  try {
    await assert.rejects(
      adapter.previewHorielMigration({
        sandboxRoot: HORIEL_MIGRATION_REPO_ROOT,
        installationId: "forbidden-repository-root",
        source: { backend: "json", filePath: path.join(HORIEL_MIGRATION_REPO_ROOT, "package.json") },
        targetDirectory: path.join(HORIEL_MIGRATION_REPO_ROOT, ".horiel-p5-target"),
      }),
      (error: unknown) => errorCode(error) === "boundary",
    );
    fs.writeFileSync(outside, `${JSON.stringify(jsonFixture())}\n`, { mode: 0o600 });
    await assert.rejects(
      adapter.previewHorielMigration(migrationInput(root, "json", outside)),
      (error: unknown) => errorCode(error) === "boundary",
    );
    const source = writeJsonSource(root);
    const targetOutside = path.join("/tmp/opencode", `horiel-p5-target-${process.pid}-${Date.now()}`);
    await assert.rejects(
      adapter.previewHorielMigration({
        ...migrationInput(root, "json", source),
        targetDirectory: targetOutside,
      }),
      (error: unknown) => errorCode(error) === "boundary",
    );
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioExistingTarget(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("boundary", "existing-target");
  try {
    const source = writeJsonSource(root);
    const input = migrationInput(root, "json", source);
    fs.mkdirSync(input.targetDirectory, { mode: 0o700 });
    const victim = path.join(input.targetDirectory, "preserve.txt");
    fs.writeFileSync(victim, "preserve", { mode: 0o600 });
    const preview = await adapter.previewHorielMigration(input);
    assert.equal(preview.canApply, false);
    assert.ok(preview.manifest.entries.some(({ kind, status, block }) => (
      kind === "target" && status === "blocked" && block?.code === "target-exists"
    )));
    await assert.rejects(
      adapter.applyHorielMigration({ preview, expectedManifestHash: preview.manifestHash }),
      (error: unknown) => errorCode(error) === "blocked",
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "preserve");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioUnsafeEntries(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("boundary", "unsafe-entries");
  try {
    const source = writeJsonSource(root);
    const symbolic = path.join(root, "mnemo-link.json");
    fs.symlinkSync(source, symbolic);
    await assert.rejects(
      adapter.previewHorielMigration(migrationInput(root, "json", symbolic, "symlink-target")),
      (error: unknown) => errorCode(error) === "boundary",
    );

    const hardlink = path.join(root, "mnemo-hardlink.json");
    fs.linkSync(source, hardlink);
    await assert.rejects(
      adapter.previewHorielMigration(migrationInput(root, "json", hardlink, "hardlink-target")),
      (error: unknown) => errorCode(error) === "boundary",
    );

    fs.rmSync(hardlink, { force: true });
    await assert.rejects(
      adapter.previewHorielMigration({
        ...migrationInput(root, "json", source),
        targetDirectory: path.join(root, ".horiel-migrations", "forbidden-target"),
      }),
      (error: unknown) => errorCode(error) === "boundary",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioDisconnected(adapter: MigrationAdapter): Promise<void> {
  const root = scenarioRoot("boundary", "disconnected");
  try {
    const migrationDirectory = path.join(HORIEL_MIGRATION_REPO_ROOT, "src", "horiel", "migration");
    const files = listTypeScriptFiles(migrationDirectory);
    assert.ok(files.length >= 8);
    const forbidden = [
      /from\s+["'][^"']*(?:\/mcp|\/integration|\/plugin|\/cli)(?:\/|["'])/,
      /from\s+["']node:(?:http|https|net|tls|dgram|dns)/,
      /\bfetch\s*\(/,
    ];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        assert.equal(pattern.test(content), false, `${path.basename(file)} crosses the P5 boundary`);
      }
    }

    const runtimeDirectories = ["core", "sqlite", "mcp", "integration", "cli"];
    for (const directory of runtimeDirectories) {
      const target = path.join(HORIEL_MIGRATION_REPO_ROOT, "src", "horiel", directory);
      if (!fs.existsSync(target)) continue;
      for (const file of listTypeScriptFiles(target)) {
        assert.equal(fs.readFileSync(file, "utf8").includes("/migration"), false);
      }
    }

    const source = writeJsonSource(root);
    const preview = await adapter.previewHorielMigration(migrationInput(root, "json", source));
    const result = await adapter.applyHorielMigration({ preview, expectedManifestHash: preview.manifestHash });
    const names = listFilesRecursively(result.paths.transactionDirectory).map((file) => path.basename(file));
    assert.equal(names.some((name) => /^(?:active|provider|marker)(?:\.|$)/i.test(name)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

interface Scenario {
  name: string;
  run(adapter: MigrationAdapter): Promise<void>;
}

const SCENARIOS: Record<ScenarioGroup, Scenario[]> = {
  mapping: [
    { name: MIGRATION_SCENARIO_NAMES.mapping[0], run: scenarioJsonDeterminism },
    { name: MIGRATION_SCENARIO_NAMES.mapping[1], run: scenarioChangedSource },
    { name: MIGRATION_SCENARIO_NAMES.mapping[2], run: scenarioBlockedEntities },
    { name: MIGRATION_SCENARIO_NAMES.mapping[3], run: scenarioSqlitePreview },
  ],
  apply: [
    { name: MIGRATION_SCENARIO_NAMES.apply[0], run: scenarioApplyJson },
    { name: MIGRATION_SCENARIO_NAMES.apply[1], run: scenarioApplySqlite },
    { name: MIGRATION_SCENARIO_NAMES.apply[2], run: scenarioIdempotentApply },
    { name: MIGRATION_SCENARIO_NAMES.apply[3], run: scenarioDifferential },
  ],
  recovery: [
    { name: MIGRATION_SCENARIO_NAMES.recovery[0], run: scenarioRecoveryFaults },
    { name: MIGRATION_SCENARIO_NAMES.recovery[1], run: scenarioForgedManifest },
    { name: MIGRATION_SCENARIO_NAMES.recovery[2], run: scenarioChangedDuringRecovery },
  ],
  boundary: [
    { name: MIGRATION_SCENARIO_NAMES.boundary[0], run: scenarioOutsideSandbox },
    { name: MIGRATION_SCENARIO_NAMES.boundary[1], run: scenarioUnsafeEntries },
    { name: MIGRATION_SCENARIO_NAMES.boundary[2], run: scenarioExistingTarget },
    { name: MIGRATION_SCENARIO_NAMES.boundary[3], run: scenarioDisconnected },
  ],
};

async function executeNodeScenarioGroup(group: ScenarioGroup): Promise<MigrationScenarioReport> {
  const results: ScenarioResult[] = [];
  let adapter: MigrationAdapter;
  try {
    adapter = await loadAdapter();
  } catch (error) {
    return buildFailureReport(group, errorText(error));
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
    }
  }
  return { group, nodeVersion: process.versions.node, results };
}

function buildFailureReport(group: ScenarioGroup, error: string): MigrationScenarioReport {
  return {
    group,
    nodeVersion: process.versions.node ?? "not-started",
    results: MIGRATION_SCENARIO_NAMES[group].map((name) => ({
      name,
      status: "failed",
      durationMs: 0,
      error,
    })),
  };
}

export async function runMigrationScenarioGroup(group: ScenarioGroup): Promise<MigrationScenarioReport> {
  const bun = (globalThis as unknown as { Bun?: any }).Bun;
  if (!bun?.build || !bun?.spawn) return buildFailureReport(group, "The Bun test orchestrator is unavailable.");
  const runnerDirectory = path.join(HORIEL_MIGRATION_SANDBOX_ROOT, "runner", safeSegment(group));
  assertInside(HORIEL_MIGRATION_SANDBOX_ROOT, runnerDirectory);
  fs.rmSync(runnerDirectory, { recursive: true, force: true });
  fs.mkdirSync(runnerDirectory, { recursive: true, mode: 0o700 });
  const reportPath = path.join(runnerDirectory, "report.json");
  let stdout = "";
  let stderr = "";
  try {
    const build = await bun.build({
      entrypoints: [fileURLToPath(import.meta.url)],
      outdir: runnerDirectory,
      target: "node",
      format: "esm",
      naming: "horiel-migration-runner.mjs",
      sourcemap: "inline",
      external: ["node:sqlite"],
      write: true,
    });
    if (!build.success) {
      const diagnostics = build.logs.map((log: { message?: string }) => log.message ?? String(log)).join("\n");
      return buildFailureReport(group, `Node runner build failed:\n${diagnostics}`);
    }
    const bundlePath = build.outputs[0]?.path ?? path.join(runnerDirectory, "horiel-migration-runner.mjs");
    const child = bun.spawn(["node", bundlePath], {
      cwd: runnerDirectory,
      env: {
        ...process.env,
        HORIEL_MIGRATION_NODE_RUNNER: "1",
        HORIEL_MIGRATION_NODE_GROUP: group,
        HORIEL_MIGRATION_REPORT_PATH: reportPath,
        HORIEL_MIGRATION_REPO_ROOT: HORIEL_MIGRATION_REPO_ROOT,
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
      return buildFailureReport(group, `Node runner exited ${exitCode} without a report.\n${stderr || stdout}`);
    }
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as MigrationScenarioReport;
    return { ...report, stdout, stderr };
  } catch (error) {
    return buildFailureReport(group, errorText(error));
  } finally {
    fs.rmSync(runnerDirectory, { recursive: true, force: true });
  }
}

export function assertMigrationScenario(report: MigrationScenarioReport, scenarioName: string): void {
  const result = report.results.find(({ name }) => name === scenarioName);
  if (!result) throw new Error(`Node runner omitted scenario: ${scenarioName}`);
  if (result.status !== "passed") {
    throw new Error(`[Node ${report.nodeVersion}] ${scenarioName}\n${result.error ?? "Unknown scenario failure"}`);
  }
}

function hashFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "scenario";
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  return String(error);
}

function listTypeScriptFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return listTypeScriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  });
}

function listFilesRecursively(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [target];
    return entry.isDirectory() ? listFilesRecursively(target) : [target];
  });
}

if (process.env.HORIEL_MIGRATION_NODE_RUNNER === "1") {
  const group = process.env.HORIEL_MIGRATION_NODE_GROUP as ScenarioGroup;
  const reportPath = process.env.HORIEL_MIGRATION_REPORT_PATH ?? "";
  let report: MigrationScenarioReport;
  if (!(group in SCENARIOS)) report = buildFailureReport(group, `Unknown scenario group: ${String(group)}`);
  else report = await executeNodeScenarioGroup(group);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (report.results.some(({ status }) => status === "failed")) process.exitCode = 1;
}
