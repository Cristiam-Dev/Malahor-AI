import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  describeInstructionsSync,
  instructionsState,
  legacyInstructionsHint,
  MALAHOR_MANAGED_MARKER,
  syncManagedInstructions,
} from "../src/cli/core/instructions";

function tempDir(): string {
  return fs.mkdtempSync(path.join("/tmp/opencode", "malahor-instructions-"));
}

const MANAGED_ASSET = `${MALAHOR_MANAGED_MARKER}: prueba -->\n# Malahor\n\ncontenido v2\n`;

function writeAsset(dir: string, content = MANAGED_ASSET): string {
  const asset = path.join(dir, "AGENTS.asset.md");
  fs.writeFileSync(asset, content, "utf8");
  return asset;
}

describe("instrucciones gestionadas (AGENTS.md)", () => {
  test("estado: managed/foreign/missing", () => {
    const dir = tempDir();
    const managed = path.join(dir, "AGENTS.md");
    fs.writeFileSync(managed, MANAGED_ASSET, "utf8");
    expect(instructionsState(managed)).toBe("managed");

    const foreign = path.join(dir, "propio.md");
    fs.writeFileSync(foreign, "# Mi propio archivo\n", "utf8");
    expect(instructionsState(foreign)).toBe("foreign");

    expect(instructionsState(path.join(dir, "no-existe.md"))).toBe("missing");
  });

  test("crea el archivo gestionado cuando falta", () => {
    const dir = tempDir();
    const asset = writeAsset(dir);
    const destination = path.join(dir, "opencode", "AGENTS.md");

    const result = syncManagedInstructions(asset, destination, path.join(dir, "backups"), false);

    expect(result.action).toBe("created");
    expect(result.backup).toBeNull();
    expect(fs.readFileSync(destination, "utf8")).toBe(MANAGED_ASSET);
  });

  test("no pisa un AGENTS.md ajeno", () => {
    const dir = tempDir();
    const asset = writeAsset(dir);
    const destination = path.join(dir, "AGENTS.md");
    fs.writeFileSync(destination, "# mio\n", "utf8");

    const result = syncManagedInstructions(asset, destination, path.join(dir, "backups"), false);

    expect(result.action).toBe("kept-foreign");
    expect(fs.readFileSync(destination, "utf8")).toBe("# mio\n");
  });

  test("refresca un gestionado con backup previo", () => {
    const dir = tempDir();
    const asset = writeAsset(dir);
    const destination = path.join(dir, "AGENTS.md");
    fs.writeFileSync(destination, `${MALAHOR_MANAGED_MARKER}: viejo -->\ncontenido viejo\n`, "utf8");

    const backupsDir = path.join(dir, "backups");
    const result = syncManagedInstructions(asset, destination, backupsDir, false);

    expect(result.action).toBe("refreshed");
    expect(result.backup?.created).toBe(true);
    expect(fs.readFileSync(destination, "utf8")).toBe(MANAGED_ASSET);

    const backupDestination = result.backup?.destination;
    expect(backupDestination).toBeTruthy();
    expect(fs.existsSync(backupDestination as string)).toBe(true);
    expect(fs.readFileSync(backupDestination as string, "utf8")).toContain("contenido viejo");
  });

  test("sin cambios cuando el contenido ya coincide", () => {
    const dir = tempDir();
    const asset = writeAsset(dir);
    const destination = path.join(dir, "AGENTS.md");
    fs.copyFileSync(asset, destination);

    const result = syncManagedInstructions(asset, destination, path.join(dir, "backups"), false);

    expect(result.action).toBe("unchanged");
    expect(result.backup).toBeNull();
  });

  test("dry-run reporta sin escribir", () => {
    const dir = tempDir();
    const asset = writeAsset(dir);
    const destination = path.join(dir, "AGENTS.md");

    const result = syncManagedInstructions(asset, destination, path.join(dir, "backups"), true);

    expect(result.action).toBe("created");
    expect(fs.existsSync(destination)).toBe(false);
    expect(describeInstructionsSync(result, true)).toContain("would install");
  });

  test("hint de OPENCODE.md legado solo aparece si existe", () => {
    const dir = tempDir();
    const legacy = path.join(dir, "OPENCODE.md");

    expect(legacyInstructionsHint(legacy)).toBeNull();
    fs.writeFileSync(legacy, "# protocolo viejo\n", "utf8");
    expect(legacyInstructionsHint(legacy)).toContain("doctor --self-heal");
  });
});
