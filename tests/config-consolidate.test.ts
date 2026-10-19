import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { describePlan, describeRollback, planForJson } from "../src/cli/commands/config";
import { applyConsolidation, applyRollback, buildRollbackPlan } from "../src/cli/core/opencode-config/apply";
import { readDocument } from "../src/cli/core/opencode-config/jsonc";
import { mergeConfigText } from "../src/cli/core/opencode-config/merge";
import { hasDuplicateConfigs, previewConsolidation } from "../src/cli/core/opencode-config/preview";
import { pendingTransactions } from "../src/cli/core/opencode-config/store";

function tempDir(): string {
  return fs.mkdtempSync(path.join("/tmp/opencode", "malahor-config-"));
}

function write(dir: string, name: string, text: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, text, "utf8");
  return filePath;
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

describe("config: preview y merge", () => {
  test("missing/single/ready y deteccion de duplicados", () => {
    const dir = tempDir();
    expect(previewConsolidation({ opencodeDir: dir }).state).toBe("missing");
    expect(hasDuplicateConfigs(dir)).toBe(false);

    write(dir, "opencode.jsonc", "{}\n");
    expect(previewConsolidation({ opencodeDir: dir }).state).toBe("single");
    expect(hasDuplicateConfigs(dir)).toBe(false);

    write(dir, "opencode.json", "{}\n");
    expect(previewConsolidation({ opencodeDir: dir }).state).toBe("ready");
    expect(hasDuplicateConfigs(dir)).toBe(true);
  });

  test("merge aditivo conserva comentarios, comas finales y sintaxis del origen", () => {
    const target = `{\n  // modelo principal\n  "$schema": "https://opencode.ai/config.json",\n  "model": "acme/x",\n  "experimental": {\n    "alpha": 1,\n  },\n}\n`;
    const source = `{\n  "model": "acme/x",\n  "theme": "dark",\n  "experimental": { "beta": 2 } // nota beta\n}\n`;
    const merge = mergeConfigText(target, source);

    expect(merge.conflicts).toEqual([]);
    expect(merge.additions).toEqual(["/theme", "/experimental/beta"]);
    expect(merge.text).toContain("// modelo principal");
    expect(merge.text).toContain('"theme": "dark"');
    expect(merge.text).toContain('"beta": 2');
    expect(merge.text).toContain("// nota beta");
    expect(merge.text).toContain("Comentarios conservados del archivo de origen");
    expect(() => readDocument(merge.text)).not.toThrow();
  });

  test("valores distintos, seguridad y alias V1/V2 bloquean con ruta, sin fusionar", () => {
    const valueDir = tempDir();
    write(valueDir, "opencode.jsonc", `{\n  "model": "a"\n}\n`);
    write(valueDir, "opencode.json", `{\n  "model": "b"\n}\n`);
    const valuePlan = previewConsolidation({ opencodeDir: valueDir });
    expect(valuePlan.state).toBe("blocked");
    expect(valuePlan.merge?.conflicts).toContainEqual({ path: "/model", reason: "value" });

    const securityDir = tempDir();
    write(securityDir, "opencode.jsonc", `{}\n`);
    write(securityDir, "opencode.json", `{\n  "permission": { "bash": { "git push *": "ask" } }\n}\n`);
    const securityPlan = previewConsolidation({ opencodeDir: securityDir });
    expect(securityPlan.state).toBe("blocked");
    expect(securityPlan.merge?.conflicts).toContainEqual({ path: "/permission", reason: "security-review" });

    const nestedDir = tempDir();
    write(nestedDir, "opencode.jsonc", `{}\n`);
    write(nestedDir, "opencode.json", `{\n  "options": { "permission": "allow" }\n}\n`);
    expect(previewConsolidation({ opencodeDir: nestedDir }).merge?.conflicts).toContainEqual({ path: "/options", reason: "security-review" });

    const aliasDir = tempDir();
    write(aliasDir, "opencode.jsonc", `{\n  "plugins": []\n}\n`);
    write(aliasDir, "opencode.json", `{\n  "plugin": []\n}\n`);
    const aliasConflicts = previewConsolidation({ opencodeDir: aliasDir }).merge?.conflicts ?? [];
    expect(aliasConflicts.some((conflict) => conflict.reason === "semantic-alias")).toBe(true);

    const compactionDir = tempDir();
    write(compactionDir, "opencode.jsonc", `{\n  "compaction": { "auto": true, "keep": { "tokens": 8000 } }\n}\n`);
    write(compactionDir, "opencode.json", `{\n  "compaction": { "auto": true, "preserve_recent_tokens": 8000 }\n}\n`);
    const compactionConflicts = previewConsolidation({ opencodeDir: compactionDir }).merge?.conflicts ?? [];
    expect(compactionConflicts.some((conflict) => conflict.path.includes("preserve_recent_tokens"))).toBe(true);
  });

  test("entradas invalidas o inseguras no se interpretan como configuracion vacia", () => {
    const dir = tempDir();
    const targetText = `{\n  "model": "a"\n}\n`;
    const targetPath = write(dir, "opencode.jsonc", targetText);

    for (const invalid of ['{ "a": 1, "a": 2 }', "[1, 2]", "{ broken", '{"a": }']) {
      const sourcePath = write(dir, "opencode.json", `${invalid}\n`);
      expect(previewConsolidation({ opencodeDir: dir }).state).toBe("blocked");
      expect(read(targetPath)).toBe(targetText);
      fs.unlinkSync(sourcePath);
    }

    const realDir = tempDir();
    const realPath = write(realDir, "real.json", "{}\n");
    const linkDir = tempDir();
    fs.symlinkSync(realPath, path.join(linkDir, "opencode.json"));
    write(linkDir, "opencode.jsonc", "{}\n");
    expect(previewConsolidation({ opencodeDir: linkDir }).state).toBe("blocked");
    expect(() => applyConsolidation({ opencodeDir: linkDir }, "CONSOLIDATE:x")).toThrow();
  });
});

describe("config: aplicar y revertir", () => {
  test("aplicar consolida, respalda, preserva modo y retira el origen por renombrado", () => {
    const dir = tempDir();
    const targetText = `{\n  // base\n  "$schema": "https://opencode.ai/config.json",\n}\n`;
    const sourceText = `{\n  "theme": "dark"\n}\n`;
    const targetPath = write(dir, "opencode.jsonc", targetText);
    const sourcePath = write(dir, "opencode.json", sourceText);
    fs.chmodSync(targetPath, 0o640);

    const plan = previewConsolidation({ opencodeDir: dir });
    expect(plan.state).toBe("ready");
    expect(plan.merge?.additions).toEqual(["/theme"]);
    expect(describePlan(plan).join("\n")).toContain("Para aplicar");

    expect(() => applyConsolidation({ opencodeDir: dir }, "CONSOLIDATE:nope")).toThrow();
    expect(read(targetPath)).toBe(targetText);
    expect(read(sourcePath)).toBe(sourceText);

    const result = applyConsolidation({ opencodeDir: dir }, plan.confirmation!);
    expect(read(targetPath)).toBe(plan.merge!.text);
    expect(fs.statSync(targetPath).mode & 0o777).toBe(0o640);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(read(result.transaction.disabledPath)).toBe(sourceText);
    expect(read(path.join(result.backupsDir, "opencode.json.backup"))).toBe(sourceText);
    expect(read(path.join(result.backupsDir, "opencode.jsonc.backup"))).toBe(targetText);
    expect(JSON.parse(read(path.join(result.backupsDir, "transaction.json"))).state).toBe("applied");
    expect(previewConsolidation({ opencodeDir: dir }).state).toBe("single");
    expect(pendingTransactions({ opencodeDir: dir })).toEqual([]);
    expect(() => applyConsolidation({ opencodeDir: dir }, plan.confirmation!)).toThrow();
  });

  test("rollback restaura byte a byte y permite reconsolidar", () => {
    const dir = tempDir();
    const targetText = `{\n  "model": "acme/x",\n}\n`;
    const sourceText = `{\n  "theme": "dark",\n}\n`;
    const targetPath = write(dir, "opencode.jsonc", targetText);
    const sourcePath = write(dir, "opencode.json", sourceText);

    const plan = previewConsolidation({ opencodeDir: dir });
    const result = applyConsolidation({ opencodeDir: dir }, plan.confirmation!);

    const rollbackPlan = buildRollbackPlan({ opencodeDir: dir });
    expect(rollbackPlan.state).toBe("ready");
    expect(rollbackPlan.transaction?.id).toBe(result.transaction.id);
    expect(describeRollback(rollbackPlan).join("\n")).toContain(rollbackPlan.confirmation!);

    expect(() => applyRollback({ opencodeDir: dir }, "ROLLBACK:nope")).toThrow();
    expect(fs.existsSync(sourcePath)).toBe(false);

    const transaction = applyRollback({ opencodeDir: dir }, rollbackPlan.confirmation!);
    expect(transaction.state).toBe("rolled-back");
    expect(read(targetPath)).toBe(targetText);
    expect(read(sourcePath)).toBe(sourceText);
    expect(fs.existsSync(result.transaction.disabledPath)).toBe(false);
    expect(previewConsolidation({ opencodeDir: dir }).state).toBe("ready");
    expect(buildRollbackPlan({ opencodeDir: dir }).state).toBe("missing");

    const again = previewConsolidation({ opencodeDir: dir });
    expect(applyConsolidation({ opencodeDir: dir }, again.confirmation!).transaction.id).not.toBe(result.transaction.id);
  });

  test("rollback se bloquea si hay ediciones posteriores o transacciones sin cerrar", () => {
    const dir = tempDir();
    const targetText = `{\n  "model": "acme/x"\n}\n`;
    const sourceText = `{\n  "theme": "dark"\n}\n`;
    const targetPath = write(dir, "opencode.jsonc", targetText);
    const sourcePath = write(dir, "opencode.json", sourceText);

    const plan = previewConsolidation({ opencodeDir: dir });
    const result = applyConsolidation({ opencodeDir: dir }, plan.confirmation!);
    const mergedText = read(targetPath);

    fs.appendFileSync(targetPath, "// edicion posterior\n");
    const blocked = buildRollbackPlan({ opencodeDir: dir });
    expect(blocked.state).toBe("blocked");
    expect(() => applyRollback({ opencodeDir: dir }, blocked.confirmation ?? "ROLLBACK:x")).toThrow();
    expect(read(targetPath)).toContain("// edicion posterior");

    fs.writeFileSync(targetPath, mergedText, "utf8");
    fs.renameSync(result.transaction.disabledPath, sourcePath);
    const transactionFile = path.join(result.backupsDir, "transaction.json");
    const stored = JSON.parse(read(transactionFile));
    stored.state = "prepared";
    fs.writeFileSync(transactionFile, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const pendingPlan = previewConsolidation({ opencodeDir: dir });
    expect(pendingPlan.state).toBe("ready");
    expect(pendingPlan.pending).toContain(result.transaction.id);
    expect(() => applyConsolidation({ opencodeDir: dir }, pendingPlan.confirmation!)).toThrow(/sin cerrar/);
    expect(buildRollbackPlan({ opencodeDir: dir }).state).toBe("blocked");
  });

  test("un preview obsoleto no escribe nada", () => {
    const dir = tempDir();
    const sourcePath = write(dir, "opencode.json", `{\n  "theme": "dark"\n}\n`);
    write(dir, "opencode.jsonc", "{}\n");

    const plan = previewConsolidation({ opencodeDir: dir });
    expect(plan.state).toBe("ready");

    fs.appendFileSync(sourcePath, "// cambio posterior\n");
    const changedText = read(sourcePath);

    expect(() => applyConsolidation({ opencodeDir: dir }, plan.confirmation!)).toThrow();
    expect(read(sourcePath)).toBe(changedText);
    expect(read(path.join(dir, "opencode.jsonc"))).toBe("{}\n");
    expect(fs.existsSync(path.join(dir, ".malahor-config-backups"))).toBe(false);
  });

  test("un fallo parcial restaura el estado original y deja evidencia", () => {
    const dir = tempDir();
    const targetText = `{\n  "model": "acme/x"\n}\n`;
    const sourceText = `{\n  "theme": "dark"\n}\n`;
    const targetPath = write(dir, "opencode.jsonc", targetText);
    const sourcePath = write(dir, "opencode.json", sourceText);

    const plan = previewConsolidation({ opencodeDir: dir });
    const originalRename = fs.renameSync.bind(fs);
    let renameCalls = 0;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof fs.renameSync>) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("fallo simulado de rename");
      return originalRename(...args);
    }) as typeof fs.renameSync);

    try {
      expect(() => applyConsolidation({ opencodeDir: dir }, plan.confirmation!)).toThrow(/restauro el estado original/);
    } finally {
      renameSpy.mockRestore();
    }

    expect(renameCalls).toBeGreaterThanOrEqual(3);
    expect(read(targetPath)).toBe(targetText);
    expect(read(sourcePath)).toBe(sourceText);
    expect(previewConsolidation({ opencodeDir: dir }).state).toBe("ready");

    const backupsRootDir = path.join(dir, ".malahor-config-backups");
    const transactionDirectories = fs.readdirSync(backupsRootDir);
    expect(transactionDirectories.length).toBe(1);
    const stored = JSON.parse(read(path.join(backupsRootDir, transactionDirectories[0], "transaction.json")));
    expect(stored.state).toBe("rolled-back");
    expect(pendingTransactions({ opencodeDir: dir })).toEqual([]);
  });

  test("el preview no expone valores ni secretos", () => {
    const dir = tempDir();
    write(dir, "opencode.jsonc", `{\n  "model": "secret-target"\n}\n`);
    write(dir, "opencode.json", `{\n  "model": "secret-source"\n}\n`);

    const plan = previewConsolidation({ opencodeDir: dir });
    const rendered = describePlan(plan).join("\n");
    expect(rendered).not.toContain("secret-target");
    expect(rendered).not.toContain("secret-source");
    expect(rendered).toContain("/model");
    expect(JSON.stringify(planForJson(plan))).not.toContain("secret-target");
    expect(JSON.stringify(planForJson(plan))).not.toContain("secret-source");

    const readyDir = tempDir();
    write(readyDir, "opencode.jsonc", "{}\n");
    write(readyDir, "opencode.json", `{\n  "theme": "sk-live-TOPSECRET"\n}\n`);
    const readyPlan = previewConsolidation({ opencodeDir: readyDir });
    expect(describePlan(readyPlan).join("\n")).not.toContain("sk-live-TOPSECRET");
    expect(describePlan(readyPlan).join("\n")).toContain("/theme");
    expect(JSON.stringify(planForJson(readyPlan))).not.toContain("sk-live-TOPSECRET");
  });
});
