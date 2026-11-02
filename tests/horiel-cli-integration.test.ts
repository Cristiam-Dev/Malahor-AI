import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runMemory, type MemoryOptions } from "../src/cli/commands/memory";
import {
  SYNTHETIC_MEMORY_ID,
  SYNTHETIC_PREVIEW_ID,
  SYNTHETIC_SECRET,
  SYNTHETIC_SNAPSHOT_ID,
  SYNTHETIC_STORE_ID,
  captureStdout,
  cleanupHorielP4Suite,
  createHorielCoreSpy,
  createHorielP4Sandbox,
  importP4Module,
  textFromCliResult,
} from "./fixtures/horiel-integration";

const SUITE = "cli";

interface HorielCliModule extends Record<string, unknown> {
  createHorielMemoryCli(input: { core: unknown }): unknown;
}

const syntheticMemory = {
  id: SYNTHETIC_MEMORY_ID,
  scope: "malahor/p4",
  type: "decision",
  title: "Synthetic CLI memory",
  content: "Synthetic CLI content.",
  tags: ["horiel", "p4"],
  createdAt: "2026-11-02T12:00:00.000Z",
  updatedAt: "2026-11-02T12:00:00.000Z",
  version: 1,
  provenance: { source: "horiel-p4-test" },
};

afterAll(() => {
  cleanupHorielP4Suite(SUITE);
});

function options(action: string, args: string[] = [], overrides: Partial<MemoryOptions> = {}): MemoryOptions {
  return {
    action,
    args,
    all: false,
    confirm: undefined,
    dryRun: false,
    yes: false,
    apply: false,
    approval: undefined,
    subtree: false,
    project: undefined,
    type: undefined,
    limit: undefined,
    ...overrides,
  };
}

async function invokeSeam(seam: unknown, request: MemoryOptions): Promise<unknown> {
  if (typeof seam === "function") {
    return await (seam as (request: MemoryOptions) => unknown | Promise<unknown>)(request);
  }
  if (seam && typeof seam === "object") {
    const record = seam as Record<string, unknown>;
    for (const member of ["run", "execute"] as const) {
      if (typeof record[member] === "function") {
        return await (record[member] as (request: MemoryOptions) => unknown | Promise<unknown>)(request);
      }
    }
  }
  throw new TypeError("Horiel CLI seam must be callable or expose run/execute.");
}

function cliCore() {
  return createHorielCoreSpy({
    listTree: {
      nodes: [
        { scope: "alpha", memoryCount: 1, checkpointCount: 0 },
        { scope: "alpha/task", memoryCount: 2, checkpointCount: 1 },
      ],
      storeId: SYNTHETIC_STORE_ID,
      sequence: 7,
    },
    getMemory: syntheticMemory,
    searchMemory: {
      rankingVersion: 1,
      items: [{
        memory: syntheticMemory,
        rank: {
          scopeClass: "exact",
          scopeDistance: 0,
          pinned: false,
          textScore: 400,
          updatedAt: syntheticMemory.updatedAt,
          relationCount: 0,
        },
      }],
      sequence: 7,
    },
    inspectScope: {
      scope: "malahor/p4",
      memoryIds: [SYNTHETIC_MEMORY_ID],
      memoryCount: 1,
      checkpointCount: 0,
      pinCount: 0,
      relationCount: 0,
      storeId: SYNTHETIC_STORE_ID,
      sequence: 7,
    },
    createBackup: {
      id: SYNTHETIC_SNAPSHOT_ID,
      storeId: SYNTHETIC_STORE_ID,
      schemaVersion: 1,
      sequence: 7,
      createdAt: "2026-11-02T12:00:00.000Z",
      counts: { memories: 1, checkpoints: 0, pins: 0, relations: 0 },
      fingerprint: "a".repeat(64),
      verified: true,
    },
    previewMove: {
      id: SYNTHETIC_PREVIEW_ID,
      kind: "move",
      memoryId: SYNTHETIC_MEMORY_ID,
      sourceScope: "malahor/p4",
      destinationScope: "malahor/other",
      expectedVersion: 1,
      conflictIds: [],
      storeId: SYNTHETIC_STORE_ID,
      sequence: 7,
      confirmation: `MOVE ${SYNTHETIC_MEMORY_ID} TO malahor/other`,
      createdAt: "2026-11-02T12:00:00.000Z",
    },
    previewPromote: {
      id: SYNTHETIC_PREVIEW_ID,
      kind: "promote",
      memoryId: SYNTHETIC_MEMORY_ID,
      sourceScope: "malahor/p4",
      destinationScope: "malahor",
      expectedVersion: 1,
      conflictIds: [],
      storeId: SYNTHETIC_STORE_ID,
      sequence: 7,
      confirmation: `PROMOTE ${SYNTHETIC_MEMORY_ID} TO malahor`,
      createdAt: "2026-11-02T12:00:00.000Z",
    },
    previewDeleteScope: {
      id: SYNTHETIC_PREVIEW_ID,
      kind: "delete_scope",
      scope: "malahor/p4",
      memoryIds: [SYNTHETIC_MEMORY_ID],
      checkpointCount: 0,
      storeId: SYNTHETIC_STORE_ID,
      sequence: 7,
      confirmation: "DELETE SCOPE malahor/p4",
      createdAt: "2026-11-02T12:00:00.000Z",
    },
    previewRestore: {
      id: SYNTHETIC_PREVIEW_ID,
      kind: "restore",
      snapshotId: SYNTHETIC_SNAPSHOT_ID,
      snapshotFingerprint: "a".repeat(64),
      storeId: SYNTHETIC_STORE_ID,
      sequence: 7,
      confirmation: `RESTORE ${SYNTHETIC_SNAPSHOT_ID}`,
      createdAt: "2026-11-02T12:00:00.000Z",
    },
  });
}

function withEnvironment(values: Record<string, string>, operation: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return operation().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe("Horiel CLI seam P4", () => {
  test("traduce acciones CLI a la fachada Core sin duplicar dominio", async () => {
    const module = await importP4Module<HorielCliModule>("src/horiel/cli/memory.ts");
    expect(typeof module.createHorielMemoryCli).toBe("function");
    const spy = cliCore();
    const seam = module.createHorielMemoryCli({ core: spy.core });
    const scenarios: Array<[MemoryOptions, string]> = [
      [options("list"), "listTree"],
      [options("tree", ["alpha"]), "listTree"],
      [options("search", ["synthetic"], { project: "malahor/p4", limit: "5" }), "searchMemory"],
      [options("get", [SYNTHETIC_MEMORY_ID]), "getMemory"],
      [options("inspect", ["malahor/p4"]), "inspectScope"],
      [options("backup"), "createBackup"],
      [options("move-preview", [SYNTHETIC_MEMORY_ID, "malahor/other"]), "previewMove"],
      [options("promote-preview", [SYNTHETIC_MEMORY_ID, "malahor"]), "previewPromote"],
      [options("delete-preview", ["malahor/p4"]), "previewDeleteScope"],
      [options("restore-preview", [SYNTHETIC_SNAPSHOT_ID]), "previewRestore"],
    ];

    for (const [request, method] of scenarios) {
      const before = spy.calls.length;
      const result = await invokeSeam(seam, request);
      expect(spy.calls).toHaveLength(before + 1);
      expect(spy.calls.at(-1)?.method).toBe(method);
      expect(textFromCliResult(result).length).toBeGreaterThan(0);
    }
  });

  test("acota y redacta salida Horiel sin SQL, paths, stack ni secreto sintetico", async () => {
    const module = await importP4Module<HorielCliModule>("src/horiel/cli/memory.ts");
    const unsafeContent = [
     [["pass", "word"].join(""), "='", SYNTHETIC_SECRET, "'"].join(""),
      "SELECT * FROM private_table",
      "/home/synthetic/private.sqlite",
      "x".repeat(12_000),
    ].join("\n");
    const spy = createHorielCoreSpy({
      getMemory: { ...syntheticMemory, content: unsafeContent },
    });
    const seam = module.createHorielMemoryCli({ core: spy.core });
    const output = textFromCliResult(await invokeSeam(seam, options("get", [SYNTHETIC_MEMORY_ID])));

    expect(output.length).toBeLessThanOrEqual(4_096);
    expect(output).not.toContain(SYNTHETIC_SECRET);
    expect(output).not.toContain("SELECT * FROM private_table");
    expect(output).not.toContain("/home/synthetic/private.sqlite");
    expect(output).not.toContain("at adapter.ts");
  });

  test("runMemory usa Horiel solamente cuando recibe el seam inyectado", async () => {
    const sandbox = createHorielP4Sandbox(SUITE, "injected-seam");
    const module = await importP4Module<HorielCliModule>("src/horiel/cli/memory.ts");
    const spy = cliCore();
    const seam = module.createHorielMemoryCli({ core: spy.core });
    await withEnvironment({
      MALAHOR_HOME: sandbox.home,
      MALAHOR_OPENCODE_DIR: sandbox.opencode,
      MALAHOR_OPENCODE_DETECT: "0",
    }, async () => {
      const captured = await captureStdout(async () => {
        return await (runMemory as unknown as (
          request: MemoryOptions,
          dependencies?: { horiel?: unknown },
        ) => unknown | Promise<unknown>)(options("list"), { horiel: seam });
      });
      expect(spy.calls.at(-1)?.method).toBe("listTree");
      expect(captured.output).toContain("alpha");
      expect(captured.output).not.toContain("Mnemo DB");
      expect(captured.output).not.toContain(sandbox.databasePath);
    });
  });

  test("runMemory sin seam conserva Mnemo incluso con variables y runtime Horiel presentes", async () => {
    const sandbox = createHorielP4Sandbox(SUITE, "mnemo-default");
    const horielDirectory = path.join(sandbox.home, "horiel");
    fs.mkdirSync(horielDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(horielDirectory, "index.js"), "// dormant synthetic runtime\n", { mode: 0o600 });
    await withEnvironment({
      MALAHOR_HOME: sandbox.home,
      MALAHOR_OPENCODE_DIR: sandbox.opencode,
      MALAHOR_OPENCODE_DETECT: "0",
      MALAHOR_HORIEL_ENABLED: "1",
      MALAHOR_HORIEL_BOUND: "1",
      MALAHOR_HORIEL_PROJECT: "malahor",
      MALAHOR_HORIEL_DATABASE: sandbox.databasePath,
      MALAHOR_HORIEL_SNAPSHOT_DIRECTORY: sandbox.snapshotDirectory,
    }, async () => {
      const captured = await captureStdout(() => runMemory(options("list")));
      expect(captured.output).toContain("Backend:");
      expect(captured.output).toContain("Mnemo DB:");
      expect(captured.output).not.toContain("Horiel DB:");
      expect(fs.existsSync(sandbox.databasePath)).toBe(false);
      expect(fs.existsSync(sandbox.snapshotDirectory)).toBe(false);
    });
  });
});
