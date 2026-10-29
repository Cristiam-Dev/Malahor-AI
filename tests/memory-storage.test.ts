import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { dbPath, getObservation, listProjects, loadDb, saveDb, saveObservation, saveSessionSummary, searchObservations } from "../src/mnemo/db";
import { MemoryEngine } from "../src/mnemo/engine";
import { memoryLocation } from "../src/mnemo/storage";
import { contextForProject, memoryBrief } from "../src/mnemo/context";
import { backupMemory, previewMemoryRestore, restoreMemoryBackup } from "../src/mnemo/admin-backup";
import { deleteProjectMemory, inspectProjectMemory, moveMemory } from "../src/mnemo/admin";
import { callTool } from "../src/mnemo/tools";
import { runContext } from "../src/cli/commands/context";
import { runMemory } from "../src/cli/commands/memory";
import { fixtureDb } from "./mnemo-fixture";
import { memorySandbox, seedEngine, syntheticMarker } from "./memory-engine-fixture";

let root: string;
let file: string;
let previous: Record<string, string | undefined>;
let legacyBytes: Buffer;
const variables = ["MALAHOR_HOME", "MALAHOR_CONFIG", "MALAHOR_OPENCODE_DIR", "MALAHOR_OPENCODE_DETECT"];

beforeEach(() => {
  ({ root, file } = memorySandbox());
  previous = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  process.env.MALAHOR_HOME = root;
  process.env.MALAHOR_CONFIG = path.join(root, "config.jsonc");
  process.env.MALAHOR_OPENCODE_DIR = path.join(root, "opencode");
  process.env.MALAHOR_OPENCODE_DETECT = "0";
  fs.writeFileSync(process.env.MALAHOR_CONFIG, "{}", { mode: 0o600 });
  saveDb(fixtureDb());
  legacyBytes = fs.readFileSync(dbPath());
});
afterEach(() => {
  for (const key of variables) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

function activateFixture(): void { seedEngine(file).close(); syntheticMarker(root); }
function unchangedJson(): void { expect(fs.readFileSync(dbPath())).toEqual(legacyBytes); }
function silent<T>(operation: () => T): T {
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try { return operation(); } finally { output.mockRestore(); }
}
function contextAction(action: string, args: string[] = [], dryRun = false): void {
  fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ acme: { context: "mnemo", roots: [root], defaultRoot: root } }), { mode: 0o600 });
  silent(() => runContext({ action, args, dryRun, project: "acme", limit: undefined }));
}

describe("fachada compartida y seleccion explicita", () => {
  test("sin marcador sigue JSON y no crea archivos SQLite/activacion", () => {
    expect(memoryLocation().backend).toBe("json");
    expect(loadDb()).toEqual(fixtureDb());
    saveSessionSummary("acme", "Checkpoint");
    expect(loadDb().sessions).toHaveLength(2);
    expect(fs.existsSync(path.join(root, "memory"))).toBe(false);
  });

  test("un SQLite provisional sin marcador no cambia el backend", () => {
    seedEngine(file).close();
    expect(memoryLocation().backend).toBe("json");
    const item = saveObservation({ project: "acme", type: "general", title: "JSON", content: "", tags: "" });
    expect(item.id).toBe(6);
    const reader = MemoryEngine.open(file);
    try { expect(reader.snapshot().nextId).toBe(6); } finally { reader.close(); }
  });

  test("MCP/lecturas/sesiones usan un unico backend, con relectura por operacion", () => {
    activateFixture();
    expect(memoryLocation().file).toBe(file);
    const item = callTool({ name: "mem_save", arguments: { project: "acme/store", title: "SQL only", content: "Persistente" } }) as { id: number };
    expect(item.id).toBe(6);
    expect(getObservation(6)?.title).toBe("SQL only");
    expect(searchObservations("SQL only", "acme/store").map((row) => row.id)).toEqual([6]);
    saveSessionSummary("acme/store", "Nueva sesion");
    expect(contextForProject("acme/store").latestSession?.summary).toBe("Nueva sesion");
    expect(loadDb().nextId).toBe(7);
    expect(listProjects().find((project) => project.project === "acme/store")?.observations).toBe(2);
    expect(inspectProjectMemory("acme/store").recentObservations.map((row) => row.id)).toContain(6);
    expect(memoryBrief("SQL only", { project: "acme/store" }).observations.map((row) => row.id)).toContain(6);
    unchangedJson();
  });

  test("context save/recover/capsule y CLI memory leen y escriben SQLite", () => {
    activateFixture();
    contextAction("save", ["Checkpoint CLI"]);
    contextAction("recover"); contextAction("capsule");
    expect(contextForProject("acme").latestSession?.summary).toBe("Checkpoint CLI");
    for (const action of ["list", "inspect", "backup"]) {
      silent(() => runMemory({ action, args: action === "inspect" ? ["acme"] : [], all: false, confirm: undefined, dryRun: false, yes: false }));
    }
    const backups = fs.readdirSync(path.join(root, "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toEndWith(".sqlite");
    unchangedJson();
  });

  test("dry-run no escribe sesiones ni backups", () => {
    activateFixture();
    const before = loadDb();
    contextAction("save", ["No guardar"], true);
    const backup = backupMemory(dbPath(), true);
    expect(backup.created).toBe(true);
    expect(fs.existsSync(backup.destination!)).toBe(false);
    expect(fs.existsSync(path.join(root, "backups"))).toBe(false);
    expect(loadDb()).toEqual(before);
    unchangedJson();
  });

  test("backup MCP usa SQLite consistente, no el JSON retenido", () => {
    activateFixture();
    saveSessionSummary("acme", "Solo SQLite");
    const backup = backupMemory();
    expect(backup.source).toBe(file);
    const reader = MemoryEngine.open(backup.destination!);
    try { expect(reader.snapshot()).toEqual(loadDb()); } finally { reader.close(); }
    unchangedJson();
  });

  test("move/delete administrativos operan sobre SQLite con backup y sin tocar JSON", () => {
    activateFixture();

    const moved = moveMemory(5, "acme", "5:acme");
    expect(moved).toMatchObject({ id: 5, fromProject: "acme/store/checkout/coupons", toProject: "acme", moved: true });
    expect(moved.backup.destination).toEndWith(".sqlite");
    expect(fs.existsSync(moved.backup.destination!)).toBe(true);

    const deleted = deleteProjectMemory("acme", "acme");
    expect(deleted).toMatchObject({ project: "acme", deletedObservations: 2, deletedSessions: 0 });
    expect(deleted.backup.destination).toEndWith(".sqlite");
    expect(fs.existsSync(deleted.backup.destination!)).toBe(true);

    const reader = MemoryEngine.open(file, { access: "write" });
    try {
      expect(reader.get(2)).toBeNull();
      expect(reader.get(5)).toBeNull();
      expect(reader.get(3)?.project).toBe("acme/store");
      reader.integrity();
    } finally { reader.close(); }
    expect(fs.readdirSync(path.join(root, "backups"))).toHaveLength(2);
    unchangedJson();
  });

  test("snapshot replace/restore/reset no adaptados bloquean antes de tocar JSON", () => {
    activateFixture();
    for (const action of [
      () => saveDb({ observations: [], sessions: [], nextId: 1 }),
      () => previewMemoryRestore("absent"),
      () => restoreMemoryBackup("absent", "RESTORE"),
      () => silent(() => runMemory({ action: "reset", args: [], all: true, yes: true, confirm: "ALL", dryRun: false })),
      () => silent(() => runMemory({ action: "restore", args: ["absent"], all: false, yes: true, confirm: "RESTORE", dryRun: false })),
    ]) expect(action).toThrow("pendiente de adaptacion SQLite");
    expect(loadDb()).toEqual(fixtureDb());
    expect(fs.existsSync(path.join(root, "backups"))).toBe(false);
    unchangedJson();
  });

  test("marcador sin DB no crea base vacia ni vuelve al JSON", () => {
    fs.mkdirSync(path.dirname(file), { mode: 0o700 }); syntheticMarker(root);
    for (const action of [() => loadDb(), () => getObservation(1), () => saveSessionSummary("acme", "No escribir"), () => backupMemory()]) expect(action).toThrow();
    expect(fs.existsSync(file)).toBe(false);
    unchangedJson();
  });

  test("marcador corrupto/desconocido bloquea todas las rutas", () => {
    activateFixture();
    const marker = path.join(root, "memory", "active.json");
    for (const content of ["{", "null", "[]", "{}", '{"version":2,"backend":"sqlite","schemaVersion":1}',
      '{"version":1,"backend":"json","schemaVersion":1}', '{"version":1,"backend":"sqlite","schemaVersion":1,"file":"../foreign"}']) {
      fs.writeFileSync(marker, content);
      expect(() => saveObservation({ project: "acme", type: "general", title: "blocked", content: "", tags: "" })).toThrow();
      expect(() => contextForProject("acme")).toThrow();
      unchangedJson();
    }
  });

  test("marcador o base enlazados/ampliamente legibles fallan cerrado", () => {
    activateFixture();
    const marker = path.join(root, "memory", "active.json");
    fs.chmodSync(marker, 0o644);
    expect(() => getObservation(1)).toThrow("marcador");
    fs.chmodSync(marker, 0o600);
    const held = path.join(root, "original-marker.json"); fs.renameSync(marker, held); fs.symlinkSync(held, marker);
    expect(() => getObservation(1)).toThrow("marcador");
    fs.unlinkSync(marker); fs.renameSync(held, marker);
    fs.chmodSync(file, 0o644);
    expect(() => saveSessionSummary("acme", "Blocked")).toThrow();
    unchangedJson();
  });

  test("directorio de activacion enlazado no simula ausencia de marcador", () => {
    fs.symlinkSync(path.join(root, "absent-target"), path.join(root, "memory"));
    expect(() => saveSessionSummary("acme", "No escribir")).toThrow("marcador");
    unchangedJson();
  });
});
