import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  describePluginStateRemoval,
  describePluginSync,
  isManagedContent,
  removeManagedPlugin,
  removePluginState,
  syncManagedPlugin,
} from "../src/cli/core/managed-plugin";

const ASSET = "// malahor-managed\n// version 1\nexport default {};\n";

function tempDir(): string {
  return fs.mkdtempSync(path.join("/tmp/opencode", "malahor-managed-plugin-"));
}

function setupFixture() {
  const root = tempDir();
  const asset = path.join(root, "asset.ts");
  fs.writeFileSync(asset, ASSET, "utf8");
  const destination = path.join(root, "plugins", "malahor");
  const backups = path.join(root, "backups");
  const file = path.join(destination, "index.ts");
  return { root, asset, destination, backups, file };
}

function hasBackup(backups: string): boolean {
  return fs.existsSync(backups) && fs.readdirSync(backups).some((name) => name.startsWith("index.ts."));
}

describe("plugin gestionado", () => {
  test("instala el asset con marcador en un destino limpio", () => {
    const fixture = setupFixture();

    const result = syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, false);

    expect(result.status).toBe("installed");
    expect(fs.readFileSync(fixture.file, "utf8")).toBe(ASSET);
    expect(isManagedContent(fs.readFileSync(fixture.file, "utf8"))).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(fixture.file).mode & 0o777).toBe(0o644);
    }
  });

  test("es idempotente y no genera backups", () => {
    const fixture = setupFixture();
    syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, false);

    const result = syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, false);

    expect(result.status).toBe("up-to-date");
    expect(hasBackup(fixture.backups)).toBe(false);
  });

  test("actualiza solo contenido gestionado y deja backup", () => {
    const fixture = setupFixture();
    fs.mkdirSync(fixture.destination, { recursive: true });
    fs.writeFileSync(fixture.file, "// malahor-managed\n// version 0\nexport default {};\n", "utf8");

    const result = syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, false);

    expect(result.status).toBe("updated");
    expect(result.backup?.created).toBe(true);
    expect(hasBackup(fixture.backups)).toBe(true);
    expect(fs.readFileSync(fixture.file, "utf8")).toBe(ASSET);
  });

  test("no pisa un archivo ajeno", () => {
    const fixture = setupFixture();
    fs.mkdirSync(fixture.destination, { recursive: true });
    const foreign = "// plugin del usuario\nexport default {};\n";
    fs.writeFileSync(fixture.file, foreign, "utf8");

    const result = syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, false);

    expect(result.status).toBe("skipped-foreign");
    expect(fs.readFileSync(fixture.file, "utf8")).toBe(foreign);
    expect(hasBackup(fixture.backups)).toBe(false);
    expect(describePluginSync(result)).toContain("no gestionado");
  });

  test("dry-run no escribe nada", () => {
    const fixture = setupFixture();

    const result = syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, true);

    expect(result.status).toBe("would-install");
    expect(fs.existsSync(fixture.file)).toBe(false);
  });

  test("dry-run de update no reescribe ni respalda", () => {
    const fixture = setupFixture();
    fs.mkdirSync(fixture.destination, { recursive: true });
    const managed = "// malahor-managed\n// version 0\nexport default {};\n";
    fs.writeFileSync(fixture.file, managed, "utf8");

    const result = syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, true);

    expect(result.status).toBe("would-update");
    expect(fs.readFileSync(fixture.file, "utf8")).toBe(managed);
    expect(hasBackup(fixture.backups)).toBe(false);
  });

  test("uninstall retira solo lo gestionado y limpia el directorio vacio", () => {
    const fixture = setupFixture();
    syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, false);

    const result = removeManagedPlugin(fixture.destination, fixture.backups, false);

    expect(result.status).toBe("removed");
    expect(fs.existsSync(fixture.file)).toBe(false);
    expect(fs.existsSync(fixture.destination)).toBe(false);
    expect(hasBackup(fixture.backups)).toBe(true);
  });

  test("uninstall conserva archivos ajenos dentro del directorio", () => {
    const fixture = setupFixture();
    syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, false);
    const extra = path.join(fixture.destination, "notas.txt");
    fs.writeFileSync(extra, "ajeno", "utf8");

    const result = removeManagedPlugin(fixture.destination, fixture.backups, false);

    expect(result.status).toBe("removed");
    expect(fs.existsSync(fixture.file)).toBe(false);
    expect(fs.existsSync(extra)).toBe(true);
    expect(fs.existsSync(fixture.destination)).toBe(true);
  });

  test("uninstall no toca un index.ts ajeno", () => {
    const fixture = setupFixture();
    fs.mkdirSync(fixture.destination, { recursive: true });
    fs.writeFileSync(fixture.file, "// ajeno\nexport default {};\n", "utf8");

    const result = removeManagedPlugin(fixture.destination, fixture.backups, false);

    expect(result.status).toBe("kept-foreign");
    expect(fs.existsSync(fixture.file)).toBe(true);
  });

  test("uninstall sin archivo no hace nada", () => {
    const fixture = setupFixture();

    const result = removeManagedPlugin(fixture.destination, fixture.backups, false);

    expect(result.status).toBe("nothing-to-remove");
  });

  test("dry-run de uninstall no borra", () => {
    const fixture = setupFixture();
    syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, false);

    const result = removeManagedPlugin(fixture.destination, fixture.backups, true);

    expect(result.status).toBe("would-remove");
    expect(fs.existsSync(fixture.file)).toBe(true);
    expect(hasBackup(fixture.backups)).toBe(false);
  });

  test("asset ausente se reporta sin escribir", () => {
    const fixture = setupFixture();
    fs.rmSync(fixture.asset);

    const result = syncManagedPlugin(fixture.asset, fixture.destination, fixture.backups, false);

    expect(result.status).toBe("missing-asset");
    expect(fs.existsSync(fixture.file)).toBe(false);
  });

  test("removePluginState borra solo con dry-run desactivado", () => {
    const fixture = setupFixture();
    const stateFile = path.join(fixture.root, "plugin-state.json");
    fs.writeFileSync(stateFile, "{}\n", "utf8");

    expect(removePluginState(stateFile, true)).toBe("would-remove");
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(describePluginStateRemoval("would-remove")).toContain("would remove");

    expect(removePluginState(stateFile, false)).toBe("removed");
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(removePluginState(stateFile, false)).toBe("nothing-to-remove");
  });

  test("el marcador solo cuenta en las primeras lineas", () => {
    const deep = `${"\n".repeat(10)}// malahor-managed\n`;
    expect(isManagedContent("// malahor-managed\n")).toBe(true);
    expect(isManagedContent("// otro\n// malahor-managed\n")).toBe(true);
    expect(isManagedContent(deep)).toBe(false);
    expect(isManagedContent("// plugin ajeno\n")).toBe(false);
  });
});
