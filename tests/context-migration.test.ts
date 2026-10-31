import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  applyContextMigration,
  previewContextMigration,
  type ContextMigrationPorts,
} from "../src/cli/core/context-migration";

const LEGACY_MAPPINGS = [
  { from: "mnemo", to: "memory", count: 1 },
  { from: "mnemo+graphify", to: "memory+codegraph", count: 1 },
  { from: "mnemo+graphify+obsidian", to: "memory+codegraph+obsidian", count: 1 },
] as const;

interface Fixture {
  root: string;
  home: string;
  repo: string;
  projectsFile: string;
  backupsDir: string;
  registry: Record<string, unknown>;
  source: Buffer;
}

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-context-migration-"));
  fixtures.push(root);
  const home = path.join(root, "malahor-home");
  const repo = path.join(root, "project");
  const projectsFile = path.join(home, "projects.json");
  const backupsDir = path.join(home, "backups");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });

  const registry: Record<string, unknown> = {
    "legacy-memory": {
      context: "mnemo",
      roots: [repo],
      defaultRoot: repo,
      labels: ["uno", "dos"],
      foreign: { enabled: false, nullable: null, unicode: "áβ" },
    },
    "legacy-codegraph": {
      context: "mnemo+graphify",
      roots: [path.join(root, "secondary")],
      graphify: { provider: "legacy", options: { depth: 4 } },
    },
    "legacy-obsidian": {
      context: "mnemo+graphify+obsidian",
      roots: [],
      obsidian: { vault: "Equipo", folders: ["Diseño", "ADR"] },
    },
    "modern-memory": {
      context: "memory",
      roots: [path.join(root, "modern-memory")],
      untouched: { order: [3, 2, 1] },
    },
    "modern-codegraph": {
      context: "memory+codegraph",
      roots: [path.join(root, "modern-codegraph")],
      codegraph: { managed: true, schema: 7 },
    },
    "modern-obsidian": {
      context: "memory+codegraph+obsidian",
      roots: [path.join(root, "modern-obsidian")],
      note: "already-modern",
    },
    "future-level": {
      context: "memory+semantic-index",
      roots: [path.join(root, "future")],
      opaque: { doNotInterpret: [1, { nested: true }] },
    },
    "entry-without-context": {
      roots: [path.join(root, "unclassified")],
      owner: { team: "platform", flags: [true, false] },
    },
    "registry-metadata": {
      schema: 17,
      generatedBy: "foreign-tool",
      payload: [{ key: "context", value: "mnemo" }, "literal"],
    },
  };
  const source = Buffer.from(`${JSON.stringify(registry, null, 4)}\n`);
  fs.writeFileSync(projectsFile, source, { mode: 0o600 });
  return { root, home, repo, projectsFile, backupsDir, registry, source };
}

function allowingPorts(overrides: Partial<ContextMigrationPorts> = {}): ContextMigrationPorts {
  return {
    assertWriteAllowed: () => undefined,
    checkpoint: () => undefined,
    ...overrides,
  };
}

function readRegistry(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function expectedRegistry(source: Record<string, unknown>): Record<string, unknown> {
  const expected = JSON.parse(JSON.stringify(source)) as Record<string, Record<string, unknown>>;
  expected["legacy-memory"].context = "memory";
  expected["legacy-codegraph"].context = "memory+codegraph";
  expected["legacy-obsidian"].context = "memory+codegraph+obsidian";
  return expected;
}

function expectOnlyMappedContexts(before: Record<string, unknown>, after: Record<string, unknown>): void {
  const expected = expectedRegistry(before);
  expect(after).toEqual(expected);
  expect(Object.keys(after)).toEqual(Object.keys(before));
  for (const key of Object.keys(before)) {
    if (typeof before[key] === "object" && before[key] !== null && !Array.isArray(before[key])) {
      expect(Object.keys(after[key] as Record<string, unknown>)).toEqual(
        Object.keys(before[key] as Record<string, unknown>),
      );
    }
  }
}

function expectInsideFixture(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  expect(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))).toBe(true);
}

describe("migración de niveles legacy en projects.json", () => {
  test("preview informa los tres mapeos y conteos sin escribir", () => {
    const current = fixture();
    const preview = previewContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
    });

    expect(preview).toMatchObject({
      state: "ready",
      projectsFile: current.projectsFile,
      mappings: LEGACY_MAPPINGS,
      counts: {
        entries: 9,
        legacy: 3,
        modern: 3,
        unknown: 1,
        withoutContext: 2,
        migrated: 3,
        unchanged: 6,
      },
      changes: [
        { project: "legacy-memory", from: "mnemo", to: "memory" },
        { project: "legacy-codegraph", from: "mnemo+graphify", to: "memory+codegraph" },
        { project: "legacy-obsidian", from: "mnemo+graphify+obsidian", to: "memory+codegraph+obsidian" },
      ],
    });
    expect(preview.version).toMatch(/^[a-f0-9]{64}$/);
    expectInsideFixture(preview.lockFile, current.root);
    expect(fs.readFileSync(current.projectsFile)).toEqual(current.source);
    expect(fs.existsSync(current.backupsDir)).toBe(false);
    expect(fs.existsSync(preview.lockFile)).toBe(false);
    expect(fs.readdirSync(current.home)).toEqual(["projects.json"]);
  });

  test("apply usa hook, lock, backup privado, staging atómico y verificación por relectura", () => {
    const current = fixture();
    const preview = previewContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
    });
    const events: string[] = [];
    const checkpoints: Array<{
      stage: string;
      lockExists: boolean;
      backupFile: string | null;
      backupExists: boolean;
      temporaryFile: string | null;
      temporaryExists: boolean;
      target: Buffer;
      temporary?: Buffer;
    }> = [];

    const result = applyContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
      expectedVersion: preview.version,
      approval: "approval-fixture",
      ports: allowingPorts({
        assertWriteAllowed(request) {
          events.push("hook");
          expect(request).toMatchObject({
            event: "file.write.before",
            expectedVersion: preview.version,
            approval: "approval-fixture",
          });
          expect(request.targetPaths).toEqual(expect.arrayContaining([
            current.projectsFile,
            current.backupsDir,
          ]));
          expect(fs.existsSync(preview.lockFile)).toBe(false);
          expect(fs.existsSync(current.backupsDir)).toBe(false);
        },
        checkpoint(stage, state) {
          events.push(stage);
          const temporaryFile = state.temporaryFile ?? null;
          const backupFile = state.backupFile ?? null;
          checkpoints.push({
            stage,
            lockExists: fs.existsSync(preview.lockFile),
            backupFile,
            backupExists: Boolean(backupFile && fs.existsSync(backupFile)),
            temporaryFile,
            temporaryExists: Boolean(temporaryFile && fs.existsSync(temporaryFile)),
            target: fs.readFileSync(current.projectsFile),
            ...(temporaryFile && fs.existsSync(temporaryFile)
              ? { temporary: fs.readFileSync(temporaryFile) }
              : {}),
          });
        },
      }),
    });

    expect(events).toEqual(["hook", "locked", "backed-up", "staged", "published", "verified"]);
    expect(result).toMatchObject({
      state: "applied",
      applied: true,
      verified: true,
      counts: { migrated: 3 },
    });
    expect(result.backup).toBeTruthy();
    expectInsideFixture(result.backup!, current.root);
    expect(path.dirname(result.backup!)).toBe(current.backupsDir);
    expect(fs.readFileSync(result.backup!)).toEqual(current.source);
    if (process.platform !== "win32") {
      expect(fs.statSync(result.backup!).mode & 0o777).toBe(0o600);
      expect(fs.statSync(current.projectsFile).mode & 0o777).toBe(0o600);
    }

    const locked = checkpoints.find((item) => item.stage === "locked")!;
    const backedUp = checkpoints.find((item) => item.stage === "backed-up")!;
    const staged = checkpoints.find((item) => item.stage === "staged")!;
    const published = checkpoints.find((item) => item.stage === "published")!;
    const verified = checkpoints.find((item) => item.stage === "verified")!;
    expect(locked.lockExists).toBe(true);
    expect(backedUp.backupExists).toBe(true);
    expect(staged.lockExists).toBe(true);
    expect(staged.temporaryExists).toBe(true);
    expect(staged.target).toEqual(current.source);
    expectOnlyMappedContexts(current.registry, JSON.parse(staged.temporary!.toString("utf8")));
    expect(published.temporaryExists).toBe(false);
    expect(published.target).not.toEqual(current.source);
    expect(verified.target).toEqual(published.target);

    expectOnlyMappedContexts(current.registry, readRegistry(current.projectsFile));
    expect(fs.existsSync(preview.lockFile)).toBe(false);
    expect(fs.readdirSync(current.home).sort()).toEqual(["backups", "projects.json"]);
  });

  test("rechaza versión desactualizada y vuelve a validarla dentro del lock", () => {
    const stale = fixture();
    const stalePreview = previewContextMigration({
      projectsFile: stale.projectsFile,
      backupsDir: stale.backupsDir,
    });
    fs.appendFileSync(stale.projectsFile, " ");
    let staleHookCalls = 0;
    expect(() => applyContextMigration({
      projectsFile: stale.projectsFile,
      backupsDir: stale.backupsDir,
      expectedVersion: stalePreview.version,
      ports: allowingPorts({ assertWriteAllowed: () => { staleHookCalls += 1; } }),
    })).toThrow(/cambi|version/i);
    expect(staleHookCalls).toBe(0);
    expect(fs.existsSync(stale.backupsDir)).toBe(false);

    const racing = fixture();
    const racingPreview = previewContextMigration({
      projectsFile: racing.projectsFile,
      backupsDir: racing.backupsDir,
    });
    expect(() => applyContextMigration({
      projectsFile: racing.projectsFile,
      backupsDir: racing.backupsDir,
      expectedVersion: racingPreview.version,
      ports: allowingPorts({
        assertWriteAllowed: () => fs.appendFileSync(racing.projectsFile, " "),
      }),
    })).toThrow(/cambi|version/i);
    expect(fs.readFileSync(racing.projectsFile)).toEqual(Buffer.concat([racing.source, Buffer.from(" ")]));
    expect(fs.existsSync(racing.backupsDir)).toBe(false);
    expect(fs.existsSync(racingPreview.lockFile)).toBe(false);
  });

  test("un lock ocupado excluye apply sin retirar el lock ajeno", () => {
    const current = fixture();
    const preview = previewContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
    });
    fs.writeFileSync(preview.lockFile, "owner=fixture\n", { flag: "wx", mode: 0o600 });
    let hookCalls = 0;

    expect(() => applyContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
      expectedVersion: preview.version,
      ports: allowingPorts({ assertWriteAllowed: () => { hookCalls += 1; } }),
    })).toThrow(/lock|bloquead|ocupad/i);
    expect(hookCalls).toBe(1);
    expect(fs.readFileSync(preview.lockFile, "utf8")).toBe("owner=fixture\n");
    expect(fs.readFileSync(current.projectsFile)).toEqual(current.source);
    expect(fs.existsSync(current.backupsDir)).toBe(false);
  });

  test("un hook fallido ocurre antes de cualquier escritura", () => {
    const current = fixture();
    const preview = previewContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
    });

    expect(() => applyContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
      expectedVersion: preview.version,
      approval: "denied-evidence",
      ports: allowingPorts({
        assertWriteAllowed: () => { throw new Error("MAL-HOOK-TEST-DENY"); },
      }),
    })).toThrow("MAL-HOOK-TEST-DENY");
    expect(fs.readFileSync(current.projectsFile)).toEqual(current.source);
    expect(fs.existsSync(current.backupsDir)).toBe(false);
    expect(fs.existsSync(preview.lockFile)).toBe(false);
    expect(fs.readdirSync(current.home)).toEqual(["projects.json"]);
  });

  test("una verificación fallida tras publicar restaura exactamente el backup", () => {
    const current = fixture();
    const preview = previewContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
    });
    const stages: string[] = [];

    expect(() => applyContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
      expectedVersion: preview.version,
      ports: allowingPorts({
        checkpoint(stage) {
          stages.push(stage);
          if (stage === "published") {
            fs.writeFileSync(current.projectsFile, '{"tampered":true}\n', { mode: 0o600 });
          }
        },
      }),
    })).toThrow();

    expect(stages).toContain("published");
    expect(stages).toContain("rolled-back");
    expect(fs.readFileSync(current.projectsFile)).toEqual(current.source);
    expect(previewContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
    }).version).toBe(preview.version);
    const backups = fs.readdirSync(current.backupsDir);
    expect(backups).toHaveLength(1);
    const backup = path.join(current.backupsDir, backups[0]);
    expect(fs.readFileSync(backup)).toEqual(current.source);
    if (process.platform !== "win32") expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(preview.lockFile)).toBe(false);
    expect(fs.readdirSync(current.home).sort()).toEqual(["backups", "projects.json"]);
  });

  test("sin entradas legacy apply es no-op idempotente sin hook, lock ni backup nuevo", () => {
    const current = fixture();
    const firstPreview = previewContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
    });
    applyContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
      expectedVersion: firstPreview.version,
      ports: allowingPorts(),
    });
    const migrated = fs.readFileSync(current.projectsFile);
    const backups = fs.readdirSync(current.backupsDir);
    const noOpPreview = previewContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
    });
    expect(noOpPreview).toMatchObject({
      state: "noop",
      counts: { entries: 9, legacy: 0, migrated: 0, unchanged: 9 },
      changes: [],
    });
    let hookCalls = 0;
    let checkpointCalls = 0;

    const result = applyContextMigration({
      projectsFile: current.projectsFile,
      backupsDir: current.backupsDir,
      expectedVersion: noOpPreview.version,
      ports: allowingPorts({
        assertWriteAllowed: () => { hookCalls += 1; },
        checkpoint: () => { checkpointCalls += 1; },
      }),
    });
    expect(result).toMatchObject({ state: "noop", applied: false, verified: true, backup: null });
    expect(hookCalls).toBe(0);
    expect(checkpointCalls).toBe(0);
    expect(fs.readFileSync(current.projectsFile)).toEqual(migrated);
    expect(fs.readdirSync(current.backupsDir)).toEqual(backups);
    expect(fs.existsSync(noOpPreview.lockFile)).toBe(false);
  });

  test("CLI context migrate previsualiza y exige TTY o --yes para aplicar", () => {
    const current = fixture();
    const configFile = path.join(current.home, "config.jsonc");
    const opencodeDir = path.join(current.root, "opencode");
    fs.mkdirSync(opencodeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(configFile, "{}\n", { mode: 0o600 });
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env)
        .filter(([key, value]) => !key.startsWith("MALAHOR_") && typeof value === "string") as Array<[string, string]>,
    );
    Object.assign(env, {
      HOME: path.join(current.root, "user-home"),
      XDG_CONFIG_HOME: path.join(current.root, "xdg"),
      MALAHOR_HOME: current.home,
      MALAHOR_CONFIG: configFile,
      MALAHOR_OPENCODE_DIR: opencodeDir,
      MALAHOR_OPENCODE_DETECT: "0",
      NO_COLOR: "1",
    });
    const entry = path.resolve(import.meta.dir, "..", "src", "cli", "index.ts");
    const invoke = (...args: string[]) => Bun.spawnSync(
      [process.execPath, entry, "context", "migrate", ...args],
      { cwd: current.repo, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );

    const preview = invoke();
    expect(preview.exitCode).toBe(0);
    const previewOutput = preview.stdout.toString();
    expect(previewOutput).toContain("Migration: ready");
    for (const mapping of LEGACY_MAPPINGS) {
      expect(previewOutput).toContain(`${mapping.from} -> ${mapping.to}`);
    }
    expect(previewOutput).toContain("Preview only");
    expect(fs.readFileSync(current.projectsFile)).toEqual(current.source);
    expect(fs.existsSync(current.backupsDir)).toBe(false);

    const unconfirmed = invoke("--apply");
    expect(unconfirmed.exitCode).toBe(1);
    expect(unconfirmed.stderr.toString()).toMatch(/TTY|--yes/i);
    expect(fs.readFileSync(current.projectsFile)).toEqual(current.source);
    expect(fs.existsSync(current.backupsDir)).toBe(false);

    const applied = invoke("--apply", "--yes", "--approval", "fixture-evidence");
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout.toString()).toContain("Result: migrated 3 entries");
    expectOnlyMappedContexts(current.registry, readRegistry(current.projectsFile));
    expect(fs.readdirSync(current.backupsDir)).toHaveLength(1);
  });
});
