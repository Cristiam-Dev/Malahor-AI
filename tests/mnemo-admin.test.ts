import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { deleteProjectMemory, inspectProjectMemory, moveMemory, previewMemoryMove, previewProjectDeletion } from "../src/mnemo/admin";
import { backupMemory, previewMemoryRestore, restoreMemoryBackup } from "../src/mnemo/admin-backup";
import { previewMemoryReset, resetMemory } from "../src/mnemo/admin-reset";
import { dbPath, loadDb, saveDb } from "../src/mnemo/db";
import { contextForProject } from "../src/mnemo/context";
import { callTool, toolDefinitions } from "../src/mnemo/tools";
import { cleanupTestEnv, fixtureDb, setupTestEnv, type TestEnvSnapshot } from "./mnemo-fixture";

let testEnv: TestEnvSnapshot;

beforeEach(() => {
  testEnv = setupTestEnv();
});

afterEach(() => {
  cleanupTestEnv(testEnv);
});

describe("Mnemo memory administration", () => {
  it("previews and deletes exact project memory with backup and confirmation", () => {
    saveDb(fixtureDb());

    const preview = previewProjectDeletion("acme/store/checkout/coupons", dbPath());
    expect(preview.observations).toBe(1);
    expect(preview.requiresConfirmation).toBe("acme/store/checkout/coupons");
    expect(() => deleteProjectMemory("acme/store/checkout/coupons", "wrong", dbPath())).toThrow("Confirmacion invalida");

    const result = deleteProjectMemory("acme/store/checkout/coupons", "acme/store/checkout/coupons", dbPath());
    const context = contextForProject("acme/store/checkout/coupons", 8, dbPath());

    expect(result.deletedObservations).toBe(1);
    expect(result.backup.created).toBe(true);
    expect(result.backup.destination && fs.existsSync(result.backup.destination)).toBe(true);
    expect(context.observations.some((item) => item.project === "acme/store/checkout/coupons")).toBe(false);
    expect(context.observations.some((item) => item.project === "acme/store")).toBe(true);
  });

  it("protects global memory with a special confirmation phrase", () => {
    saveDb(fixtureDb());

    const preview = previewProjectDeletion("global", dbPath());
    expect(preview.protected).toBe(true);
    expect(preview.requiresConfirmation).toBe("DELETE GLOBAL");
    expect(() => deleteProjectMemory("global", "global", dbPath())).toThrow("Confirmacion invalida");
  });

  it("backs up and restores Mnemo from the harness-safe admin API", () => {
    saveDb(fixtureDb());

    const backup = backupMemory(dbPath());
    deleteProjectMemory("acme/store/checkout/coupons", "acme/store/checkout/coupons", dbPath());
    const preview = previewMemoryRestore(backup.destination ?? "", dbPath());
    expect(preview.observations).toBe(5);
    expect(() => restoreMemoryBackup(backup.destination ?? "", "NO", dbPath())).toThrow("Confirmacion invalida");

    const result = restoreMemoryBackup(backup.destination ?? "", "RESTORE", dbPath());
    const context = contextForProject("acme/store/checkout/coupons", 8, dbPath());

    expect(result.restored).toBe(true);
    expect(result.currentBackup.created).toBe(true);
    expect(context.observations.some((item) => item.project === "acme/store/checkout/coupons")).toBe(true);
  });

  it("resetea scope exacto o toda la memoria JSON con preview, hook y backup", () => {
    saveDb(fixtureDb());
    const restoreSource = backupMemory(dbPath()).destination!;
    const preview = previewMemoryReset("acme/store", dbPath());
    expect(preview).toMatchObject({ backend: "json", observations: 1, sessions: 1,
      requiresConfirmation: "acme/store", canReset: true });
    expect(preview.childScopes).toEqual([
      "acme/store/checkout/coupons",
      "acme/store/checkout/payments",
    ]);
    expect(() => resetMemory("acme/store", "wrong", dbPath())).toThrow("Confirmacion invalida");

    const exact = resetMemory("acme/store", "acme/store", dbPath());
    expect(exact.backup.destination).toEndWith(".bak");
    expect(loadDb().observations.map((item) => item.id)).toEqual([1, 2, 4, 5]);
    expect(loadDb().sessions).toEqual([]);

    restoreMemoryBackup(restoreSource, "RESTORE", dbPath());
    const total = resetMemory(null, "ALL", dbPath());
    expect(total).toMatchObject({ removedObservations: 5, removedSessions: 1, reset: true });
    expect(loadDb()).toEqual({ observations: [], sessions: [], nextId: 1 });
    const backupsBeforeNoOp = fs.readdirSync(path.dirname(restoreSource)).length;
    expect(resetMemory(null, "ALL", dbPath())).toMatchObject({ reset: false, removedObservations: 0, removedSessions: 0 });
    expect(fs.readdirSync(path.dirname(restoreSource))).toHaveLength(backupsBeforeNoOp);
  });

  it("rechaza restore desde enlaces o fuera de la carpeta de backups", () => {
    saveDb(fixtureDb());
    const backup = backupMemory(dbPath()).destination!;
    const outside = path.join(testEnv.root, "outside.json");
    fs.copyFileSync(backup, outside);
    fs.chmodSync(outside, 0o600);
    const link = path.join(path.dirname(backup), "linked.json");
    fs.symlinkSync(outside, link);

    expect(() => previewMemoryRestore(link, dbPath())).toThrow("sin enlaces");
    expect(() => previewMemoryRestore(outside, dbPath())).toThrow("solo acepta backups");
    expect(loadDb()).toEqual(fixtureDb());
  });

  it("inspects and moves an observation between scopes with preview confirmation", () => {
    saveDb(fixtureDb());

    const inspect = inspectProjectMemory("acme/store/checkout/payments", dbPath());
    const preview = previewMemoryMove(4, "acme/store/checkout/coupons", dbPath());
    expect(inspect.recentObservations.map((item) => item.id)).toContain(4);
    expect(preview.requiresConfirmation).toBe("4:acme/store/checkout/coupons");
    expect(() => moveMemory(4, "acme/store/checkout/coupons", "wrong", dbPath())).toThrow("Confirmacion invalida");

    const result = moveMemory(4, "acme/store/checkout/coupons", "4:acme/store/checkout/coupons", dbPath());
    const movedInspect = inspectProjectMemory("acme/store/checkout/coupons", dbPath());

    expect(result.moved).toBe(true);
    expect(result.backup.created).toBe(true);
    expect(movedInspect.recentObservations.map((item) => item.id)).toContain(4);
  });

  it("exposes memory admin tools through MCP calls", () => {
    saveDb(fixtureDb());

    const inspect = callTool({ name: "mem_inspect_project", arguments: { project: "acme/store" } }) as ReturnType<typeof inspectProjectMemory>;
    const movePreview = callTool({ name: "mem_move_preview", arguments: { id: 4, targetProject: "acme/store/checkout/coupons" } }) as ReturnType<typeof previewMemoryMove>;

    expect(toolDefinitions.some((tool) => tool.name === "mem_backup")).toBe(true);
    expect(toolDefinitions.some((tool) => tool.name === "mem_restore")).toBe(true);
    expect(toolDefinitions.some((tool) => tool.name === "mem_move")).toBe(true);
    expect(inspect.project).toBe("acme/store");
    expect(movePreview.requiresConfirmation).toBe("4:acme/store/checkout/coupons");
  });
});
