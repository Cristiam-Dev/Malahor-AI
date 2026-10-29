import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ProjectAliases } from "../src/cli/core/project";
import { runMemory } from "../src/cli/commands/memory";
import { dbPath, getObservation, saveDb, saveObservation, type MnemoDb } from "../src/mnemo/db";
import { MemoryEngine } from "../src/mnemo/engine";
import { readMigrationManifest } from "../src/mnemo/migration/manifest";
import { applyMemoryMigration, previewMemoryMigration } from "../src/mnemo/migration";
import { memoryV2Paths } from "../src/mnemo/storage";
import { memorySandbox } from "./memory-engine-fixture";

const aliases: ProjectAliases = { acme: ["Acme Legacy"] };
const variables = ["MALAHOR_HOME", "MALAHOR_CONFIG", "MALAHOR_OPENCODE_DIR", "MALAHOR_OPENCODE_DETECT"];
let root: string;
let source: string;
let previous: Record<string, string | undefined>;

beforeEach(() => {
  ({ root } = memorySandbox());
  previous = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  process.env.MALAHOR_HOME = root;
  process.env.MALAHOR_CONFIG = path.join(root, "config.jsonc");
  process.env.MALAHOR_OPENCODE_DIR = path.join(root, "opencode");
  process.env.MALAHOR_OPENCODE_DETECT = "0";
  fs.writeFileSync(process.env.MALAHOR_CONFIG, `${JSON.stringify({ projects: { aliases } })}\n`, { mode: 0o600 });
  source = dbPath();
  saveDb(legacyFixture());
});

afterEach(() => {
  process.exitCode = undefined;
  for (const key of variables) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("migrador de memoria JSON a SQLite", () => {
  test("preview estricto no escribe y reporta aliases, colisiones y conteos", () => {
    const original = fs.readFileSync(source);
    const preview = previewMemoryMigration({ source, aliases });

    expect(preview.state).toBe("ready");
    expect(preview.confirmation).toMatch(/^MIGRATE_MEMORY:[a-f0-9]{64}$/);
    expect(preview).toMatchObject({ observations: 3, sessions: 3, nextId: 40, maxObservationId: 15 });
    expect(preview.mappings).toContainEqual({
      source: "Acme Legacy/Store", target: "acme/store", observations: 1, sessions: 2, changed: true,
    });
    expect(preview.aliasCollisions).toEqual([{
      target: "acme/store", sources: ["Acme Legacy/Store", "acme/store"],
    }]);
    expect(preview.counts).toContainEqual({ scope: "acme/store", observations: 2, sessions: 3 });
    expect(preview.typeCounts).toEqual([{ type: "general", count: 3 }]);
    expect(fs.readFileSync(source)).toEqual(original);
    expect(fs.existsSync(path.join(root, "memory"))).toBe(false);
    expect(fs.existsSync(path.join(root, "backups"))).toBe(false);
  });

  test("apply preserva todos los campos, orden, IDs, sesiones y nextId", () => {
    const original = fs.readFileSync(source);
    const preview = previewMemoryMigration({ source, aliases });
    const result = applyMemoryMigration(preview.confirmation!, { source, aliases });
    const paths = memoryV2Paths(source);

    expect(result).toMatchObject({ state: "active", applied: true, resumed: false, active: true });
    expect(fs.readFileSync(source)).toEqual(original);
    expect(JSON.parse(fs.readFileSync(paths.marker, "utf8"))).toEqual({ version: 1, backend: "sqlite", schemaVersion: 1 });
    expect(fs.statSync(paths.marker).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.directory).mode & 0o777).toBe(0o700);

    const engine = MemoryEngine.open(paths.database);
    try {
      expect(engine.snapshot()).toEqual(canonicalFixture());
      expect(engine.legacyImportState()).toMatchObject({
        sessionIds: preview.sessions === 3
          ? [0, 1, 2].map((position) => `legacy:${preview.sourceHash}:${position}`) : [],
        nextObservationPosition: 3,
        nextSessionPosition: 3,
        pins: 0,
        relations: 0,
      });
    } finally { engine.close(); }

    const manifest = readMigrationManifest(paths.manifest)!.manifest;
    expect(manifest.state).toBe("verified");
    expect(fs.readFileSync(manifest.backupPath)).toEqual(original);
    expect(getObservation(9)?.project).toBe("acme/store");
    const saved = saveObservation({ project: "acme/store", type: "general", title: "Posterior", content: "v2", tags: "" });
    expect(saved.id).toBe(40);
    expect(fs.readFileSync(source)).toEqual(original);

    const active = previewMemoryMigration({ source, aliases });
    expect(active).toMatchObject({ state: "active", postMigrationChanges: true, rollbackAutomatic: false });
    const backupsBefore = fs.readdirSync(path.join(root, "backups"));
    expect(applyMemoryMigration("ignored", { source, aliases })).toMatchObject({ applied: false, active: true });
    expect(fs.readdirSync(path.join(root, "backups"))).toEqual(backupsBefore);
    expect(getObservation(40)?.title).toBe("Posterior");
  });

  test("una base vacia valida migra sin fabricar registros", () => {
    saveDb({ observations: [], sessions: [], nextId: 1 });
    const preview = previewMemoryMigration({ source, aliases });
    const result = applyMemoryMigration(preview.confirmation!, { source, aliases });
    expect(result.applied).toBe(true);
    const engine = MemoryEngine.open(memoryV2Paths(source).database);
    try {
      expect(engine.snapshot()).toEqual({ observations: [], sessions: [], nextId: 1 });
      expect(engine.tree()).toEqual([{ path: "global", parent: null, depth: 0, observations: 0, sessions: 0 }]);
    } finally { engine.close(); }
  });

  test("rechaza origen ausente, corrupto o semanticamente invalido sin escribir", () => {
    const invalid: Array<[string, string | null]> = [
      ["ausente", null],
      ["vacio", ""],
      ["json", "{"],
      ["schema", JSON.stringify({})],
      ["duplicado", JSON.stringify({ observations: [observation(2, "acme"), observation(2, "acme")], sessions: [], nextId: 3 })],
      ["nextId", JSON.stringify({ observations: [observation(2, "acme")], sessions: [], nextId: 2 })],
      ["extra", JSON.stringify({ ...legacyFixture(), extra: true })],
    ];
    for (const [, content] of invalid) {
      fs.rmSync(source, { force: true });
      if (content !== null) fs.writeFileSync(source, content, { mode: 0o600 });
      const preview = previewMemoryMigration({ source, aliases });
      expect(preview.state).toBe("blocked");
      expect(preview.confirmation).toBeNull();
      expect(fs.existsSync(path.join(root, "memory"))).toBe(false);
    }
  });

  test("rechaza permisos amplios y enlaces simbolicos", () => {
    fs.chmodSync(source, 0o644);
    expect(previewMemoryMigration({ source, aliases }).state).toBe("blocked");
    fs.chmodSync(source, 0o600);
    const target = path.join(root, "source.json");
    fs.renameSync(source, target);
    fs.symlinkSync(target, source);
    expect(previewMemoryMigration({ source, aliases }).state).toBe("blocked");
  });

  test("un destino ajeno bloquea sin sobrescribir", () => {
    const paths = memoryV2Paths(source);
    fs.mkdirSync(paths.directory, { mode: 0o700 });
    fs.writeFileSync(paths.database, "foreign", { mode: 0o600 });
    const before = fs.readFileSync(paths.database);
    const preview = previewMemoryMigration({ source, aliases });
    expect(preview).toMatchObject({ state: "blocked", confirmation: null });
    expect(fs.readFileSync(paths.database)).toEqual(before);
    expect(fs.existsSync(paths.marker)).toBe(false);
  });

  test("bloquea escritores legados mientras importa", () => {
    const originalImport = MemoryEngine.prototype.importLegacySnapshot;
    let writerBlocked = false;
    const interceptor = spyOn(MemoryEngine.prototype, "importLegacySnapshot").mockImplementation(function (
      this: MemoryEngine, snapshot, sessionIds,
    ) {
      expect(() => saveObservation({ project: "acme", type: "general", title: "Race", content: "", tags: "" }))
        .toThrow();
      writerBlocked = true;
      return originalImport.call(this, snapshot, sessionIds);
    });
    try {
      const preview = previewMemoryMigration({ source, aliases });
      applyMemoryMigration(preview.confirmation!, { source, aliases });
      expect(writerBlocked).toBe(true);
      expect(getObservation(40)).toBeNull();
    } finally { interceptor.mockRestore(); }
  });

  test("una importacion fallida queda diagnosticada y reintenta sin duplicar", () => {
    const failure = spyOn(MemoryEngine.prototype, "integrity").mockImplementationOnce(() => {
      throw new Error("fallo inyectado");
    });
    const first = previewMemoryMigration({ source, aliases });
    expect(() => applyMemoryMigration(first.confirmation!, { source, aliases })).toThrow("fallo inyectado");
    failure.mockRestore();

    const paths = memoryV2Paths(source);
    expect(fs.existsSync(paths.marker)).toBe(false);
    expect(fs.existsSync(paths.database)).toBe(false);
    expect(readMigrationManifest(paths.manifest)?.manifest.state).toBe("failed");
    fs.writeFileSync(paths.database, "interrupted", { mode: 0o600 });
    const retry = previewMemoryMigration({ source, aliases });
    expect(retry.state).toBe("retryable");
    const result = applyMemoryMigration(retry.confirmation!, { source, aliases });
    expect(result).toMatchObject({ applied: true, active: true });
    const engine = MemoryEngine.open(paths.database);
    try { expect(engine.snapshot()).toEqual(canonicalFixture()); } finally { engine.close(); }
  });

  test("si el origen cambia durante apply no activa ni descarta artefactos", () => {
    const originalImport = MemoryEngine.prototype.importLegacySnapshot;
    const interceptor = spyOn(MemoryEngine.prototype, "importLegacySnapshot").mockImplementation(function (
      this: MemoryEngine, snapshot, sessionIds,
    ) {
      fs.appendFileSync(source, " ");
      return originalImport.call(this, snapshot, sessionIds);
    });
    try {
      const preview = previewMemoryMigration({ source, aliases });
      expect(() => applyMemoryMigration(preview.confirmation!, { source, aliases })).toThrow("cambio durante la migracion");
    } finally { interceptor.mockRestore(); }
    const paths = memoryV2Paths(source);
    expect(fs.existsSync(paths.marker)).toBe(false);
    expect(fs.existsSync(paths.database)).toBe(false);
    const manifest = readMigrationManifest(paths.manifest)!.manifest;
    expect(manifest.state).toBe("failed");
    expect(manifest.artifacts.some((artifact) => artifact.includes(".failed-"))).toBe(true);
    const retry = previewMemoryMigration({ source, aliases });
    expect(retry.state).toBe("retryable");
    expect(retry.warnings.some((warning) => warning.includes("cambio desde el intento anterior"))).toBe(true);
    expect(applyMemoryMigration(retry.confirmation!, { source, aliases })).toMatchObject({ applied: true, active: true });
    expect(fs.readFileSync(source, "utf8").endsWith(" ")).toBe(true);
  });

  test("reanuda un destino verificado sin volver a importar", () => {
    const first = previewMemoryMigration({ source, aliases });
    const applied = applyMemoryMigration(first.confirmation!, { source, aliases });
    const paths = memoryV2Paths(source);
    fs.unlinkSync(paths.marker);
    const backups = fs.readdirSync(path.join(root, "backups"));

    const resume = previewMemoryMigration({ source, aliases });
    expect(resume.state).toBe("resumable");
    const result = applyMemoryMigration(resume.confirmation!, { source, aliases });
    expect(result).toMatchObject({ applied: false, resumed: true, active: true, backup: applied.backup });
    expect(fs.readdirSync(path.join(root, "backups"))).toEqual(backups);
    expect(fs.existsSync(paths.marker)).toBe(true);
  });

  test("revalida el backend dentro del lock y nunca escribe JSON despues del marker", () => {
    const paths = memoryV2Paths(source);
    const engine = MemoryEngine.open(paths.database, { access: "create" });
    engine.close();
    const before = fs.readFileSync(source);
    const lock = `${path.resolve(source)}.write.lock`;
    const originalOpen = fs.openSync.bind(fs);
    const interceptor = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
      const descriptor = originalOpen(file, flags, mode);
      if (path.resolve(String(file)) === lock && flags === "wx") {
        fs.writeFileSync(paths.marker, JSON.stringify({ version: 1, backend: "sqlite", schemaVersion: 1 }), { mode: 0o600 });
      }
      return descriptor;
    }) as typeof fs.openSync);
    try {
      expect(() => saveDb({ observations: [], sessions: [], nextId: 1 }, source)).toThrow("JSON retenido no se modifica");
      expect(fs.readFileSync(source)).toEqual(before);
    } finally { interceptor.mockRestore(); }
  });

  test("un manifiesto no puede dirigir cuarentena o backup fuera del sandbox", () => {
    const preview = previewMemoryMigration({ source, aliases });
    applyMemoryMigration(preview.confirmation!, { source, aliases });
    const paths = memoryV2Paths(source);
    fs.unlinkSync(paths.marker);
    const victim = path.join("/tmp/opencode", `malahor-migration-victim-${process.pid}-${Date.now()}`);
    fs.writeFileSync(victim, "preserve", { mode: 0o600 });
    try {
      const manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
      manifest.stagingPath = victim;
      fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const blocked = previewMemoryMigration({ source, aliases });
      expect(blocked).toMatchObject({ state: "blocked", confirmation: null });
      expect(fs.readFileSync(victim, "utf8")).toBe("preserve");
      expect(fs.existsSync(paths.database)).toBe(true);
    } finally { fs.rmSync(victim, { force: true }); }
  });

  test("CLI muestra preview y aplica solo con --apply --yes y token", () => {
    const output: string[] = [];
    const writer = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      runMemory({ action: "migrate", args: [], all: false, confirm: undefined, dryRun: true, yes: false });
      expect(output.join("")).toContain("Migration: ready");
      expect(fs.existsSync(path.join(root, "memory"))).toBe(false);
      const preview = previewMemoryMigration({ source, aliases });
      expect(() => runMemory({ action: "migrate", args: [], all: false, confirm: preview.confirmation!,
        dryRun: false, yes: false, apply: true })).toThrow("requiere --yes");
      runMemory({ action: "migrate", args: [], all: false, confirm: preview.confirmation!,
        dryRun: false, yes: true, apply: true });
      expect(output.join("")).toContain("Result: imported and activated");
    } finally { writer.mockRestore(); }
  });
});

function legacyFixture(): MnemoDb {
  return {
    observations: [
      observation(9, "Acme Legacy/Store", "Alias"),
      observation(2, "acme/store", "Canonico"),
      observation(15, "global", "Global"),
    ],
    sessions: [
      { project: "Acme Legacy/Store", summary: "Misma sesion", created_at: "2026-10-01T10:00:00.000Z" },
      { project: "Acme Legacy/Store", summary: "Misma sesion", created_at: "2026-10-01T10:00:00.000Z" },
      { project: "acme/store", summary: "Canonica", created_at: "2026-10-01T10:00:00.000Z" },
    ],
    nextId: 40,
  };
}

function canonicalFixture(): MnemoDb {
  const fixture = legacyFixture();
  return {
    ...fixture,
    observations: fixture.observations.map((item) => ({ ...item, project: item.project === "global" ? "global" : "acme/store" })),
    sessions: fixture.sessions.map((item) => ({ ...item, project: "acme/store" })),
  };
}

function observation(id: number, project: string, title = `Observation ${id}`) {
  return {
    id,
    project,
    type: "general" as const,
    title,
    content: `Content ${id}`,
    tags: `tag-${id}`,
    created_at: `2026-10-${String(id).padStart(2, "0")}T10:00:00.000Z`,
  };
}
