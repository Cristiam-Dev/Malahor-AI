import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  ensureOpencodeSdk,
  OPENCODE_SDK_PACKAGE,
  OPENCODE_SDK_PIN,
  removeOpencodeSdk,
  type EnsureSdkOptions,
  type PackageManager,
} from "../src/cli/core/opencode-sdk";

function tempDir(): string {
  return fs.mkdtempSync(path.join("/tmp/opencode", "malahor-sdk-"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function dependencyOf(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const pkg = readJson(filePath);
  const deps = pkg.dependencies;
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) return null;
  const value = (deps as Record<string, unknown>)[OPENCODE_SDK_PACKAGE];
  return typeof value === "string" ? value : null;
}

function writeInstalled(opencodeDir: string, version: string): void {
  writeJson(path.join(opencodeDir, "node_modules", "@opencode", "plugin", "package.json"), {
    name: OPENCODE_SDK_PACKAGE,
    version,
  });
}

function baseOptions(opencodeDir: string): { options: EnsureSdkOptions; calls: Array<{ manager: PackageManager; cwd: string }> } {
  const calls: Array<{ manager: PackageManager; cwd: string }> = [];

  return {
    calls,
    options: {
      opencodeDir,
      backupsDir: path.join(opencodeDir, "backups"),
      stateFile: path.join(opencodeDir, "state", "opencode-sdk.json"),
      dryRun: false,
      commands: { bun: true, npm: true },
      runInstall: (manager, cwd) => {
        calls.push({ manager, cwd });
        writeInstalled(opencodeDir, OPENCODE_SDK_PIN);
      },
    },
  };
}

function removeOptions(opencodeDir: string) {
  return {
    opencodeDir,
    backupsDir: path.join(opencodeDir, "backups"),
    stateFile: path.join(opencodeDir, "state", "opencode-sdk.json"),
    dryRun: false,
  };
}

describe("SDK de OpenCode", () => {
  test("instala el pin exacto en un directorio limpio y registra ownership", () => {
    const dir = tempDir();
    const { options, calls } = baseOptions(dir);
    const packageJson = path.join(dir, "package.json");

    const result = ensureOpencodeSdk(options);

    expect(result.status).toBe("installed");
    expect(result.manager).toBe("bun");
    expect(result.dependencyChanged).toBe(true);
    expect(dependencyOf(packageJson)).toBe(OPENCODE_SDK_PIN);
    expect(calls).toEqual([{ manager: "bun", cwd: dir }]);

    const state = readJson(options.stateFile);
    expect(state.addedDependency).toBe(true);
    expect(state.createdPackageJson).toBe(true);
    expect(state.installedWith).toBe("bun");
  });

  test("preserva el pin V1 y dependencias ajenas", () => {
    const dir = tempDir();
    const packageJson = path.join(dir, "package.json");
    writeJson(packageJson, { dependencies: { "@opencode-ai/plugin": "1.14.20", otro: "^1.2.0" } });
    const { options } = baseOptions(dir);

    ensureOpencodeSdk(options);

    const pkg = readJson(packageJson);
    const deps = pkg.dependencies as Record<string, unknown>;
    expect(deps["@opencode-ai/plugin"]).toBe("1.14.20");
    expect(deps.otro).toBe("^1.2.0");
    expect(deps[OPENCODE_SDK_PACKAGE]).toBe(OPENCODE_SDK_PIN);
  });

  test("no degrada ni reescribe una version exacta mayor ya instalada", () => {
    const dir = tempDir();
    const packageJson = path.join(dir, "package.json");
    writeJson(packageJson, { dependencies: { [OPENCODE_SDK_PACKAGE]: "2.0.32" } });
    writeInstalled(dir, "2.0.32");
    const { options, calls } = baseOptions(dir);

    const result = ensureOpencodeSdk(options);

    expect(result.status).toBe("up-to-date");
    expect(calls.length).toBe(0);
    expect(dependencyOf(packageJson)).toBe("2.0.32");
  });

  test("respeta un rango que cumple el piso", () => {
    const dir = tempDir();
    const packageJson = path.join(dir, "package.json");
    writeJson(packageJson, { dependencies: { [OPENCODE_SDK_PACKAGE]: "^2.0.4" } });
    writeInstalled(dir, "2.5.0");
    const { options, calls } = baseOptions(dir);

    const result = ensureOpencodeSdk(options);

    expect(result.status).toBe("up-to-date");
    expect(calls.length).toBe(0);
    expect(dependencyOf(packageJson)).toBe("^2.0.4");
  });

  test("reemplaza una version por debajo del piso y deja backup", () => {
    const dir = tempDir();
    const packageJson = path.join(dir, "package.json");
    writeJson(packageJson, { dependencies: { [OPENCODE_SDK_PACKAGE]: "1.0.0" } });
    const { options } = baseOptions(dir);

    const result = ensureOpencodeSdk(options);

    expect(result.status).toBe("installed");
    expect(result.dependencyChanged).toBe(true);
    expect(dependencyOf(packageJson)).toBe(OPENCODE_SDK_PIN);
    expect(fs.readdirSync(options.backupsDir).some((file) => file.startsWith("package.json."))).toBe(true);
  });

  test("materializa node_modules sin reescribir un pin correcto", () => {
    const dir = tempDir();
    const packageJson = path.join(dir, "package.json");
    writeJson(packageJson, { dependencies: { [OPENCODE_SDK_PACKAGE]: OPENCODE_SDK_PIN } });
    const { options, calls } = baseOptions(dir);

    const result = ensureOpencodeSdk(options);

    expect(result.status).toBe("installed");
    expect(result.dependencyChanged).toBe(false);
    expect(calls.length).toBe(1);
    expect(fs.existsSync(options.stateFile)).toBe(false);
    expect(dependencyOf(packageJson)).toBe(OPENCODE_SDK_PIN);
  });

  test("sin bun ni npm deja el pin y avisa", () => {
    const dir = tempDir();
    const { options, calls } = baseOptions(dir);
    options.commands = { bun: false, npm: false };

    const result = ensureOpencodeSdk(options);

    expect(result.status).toBe("skipped-no-manager");
    expect(calls.length).toBe(0);
    expect(dependencyOf(path.join(dir, "package.json"))).toBe(OPENCODE_SDK_PIN);
    expect(fs.existsSync(options.stateFile)).toBe(true);
  });

  test("JSON invalido: no escribe ni registra ownership", () => {
    const dir = tempDir();
    const packageJson = path.join(dir, "package.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(packageJson, "{ roto", "utf8");
    const { options, calls } = baseOptions(dir);

    const result = ensureOpencodeSdk(options);

    expect(result.status).toBe("skipped-invalid-json");
    expect(calls.length).toBe(0);
    expect(fs.readFileSync(packageJson, "utf8")).toBe("{ roto");
    expect(fs.existsSync(options.stateFile)).toBe(false);
  });

  test("dry-run no escribe ni instala", () => {
    const dir = tempDir();
    const { options, calls } = baseOptions(dir);
    options.dryRun = true;

    const result = ensureOpencodeSdk(options);

    expect(result.status).toBe("would-install");
    expect(calls.length).toBe(0);
    expect(fs.existsSync(path.join(dir, "package.json"))).toBe(false);
    expect(fs.existsSync(options.stateFile)).toBe(false);
  });

  test("uninstall retira lo propio y borra el package.json que creo", () => {
    const dir = tempDir();
    const { options } = baseOptions(dir);
    ensureOpencodeSdk(options);

    const result = removeOpencodeSdk(removeOptions(dir));

    expect(result.status).toBe("removed");
    expect(result.packageJsonDeleted).toBe(true);
    expect(fs.existsSync(path.join(dir, "package.json"))).toBe(false);
    expect(fs.existsSync(options.stateFile)).toBe(false);
  });

  test("uninstall conserva dependencias ajenas y el archivo", () => {
    const dir = tempDir();
    const packageJson = path.join(dir, "package.json");
    writeJson(packageJson, { dependencies: { "@opencode-ai/plugin": "1.14.20" } });
    const { options } = baseOptions(dir);
    ensureOpencodeSdk(options);

    const result = removeOpencodeSdk(removeOptions(dir));

    expect(result.status).toBe("removed");
    expect(result.packageJsonDeleted).toBe(false);
    expect(dependencyOf(packageJson)).toBeNull();
    const deps = readJson(packageJson).dependencies as Record<string, unknown>;
    expect(deps["@opencode-ai/plugin"]).toBe("1.14.20");
  });

  test("sin ownership no toca la dependencia", () => {
    const dir = tempDir();
    const packageJson = path.join(dir, "package.json");
    writeJson(packageJson, { dependencies: { [OPENCODE_SDK_PACKAGE]: "2.0.32" } });

    const result = removeOpencodeSdk(removeOptions(dir));

    expect(result.status).toBe("kept-not-owned");
    expect(dependencyOf(packageJson)).toBe("2.0.32");
  });

  test("si el usuario cambio la version, uninstall no la retira", () => {
    const dir = tempDir();
    const packageJson = path.join(dir, "package.json");
    const { options } = baseOptions(dir);
    ensureOpencodeSdk(options);
    writeJson(packageJson, { dependencies: { [OPENCODE_SDK_PACKAGE]: "2.0.32" } });

    const result = removeOpencodeSdk(removeOptions(dir));

    expect(result.status).toBe("kept-not-owned");
    expect(dependencyOf(packageJson)).toBe("2.0.32");
    expect(fs.existsSync(options.stateFile)).toBe(false);
  });

  test("dry-run de uninstall no modifica nada", () => {
    const dir = tempDir();
    const packageJson = path.join(dir, "package.json");
    const { options } = baseOptions(dir);
    ensureOpencodeSdk(options);

    const result = removeOpencodeSdk({ ...removeOptions(dir), dryRun: true });

    expect(result.status).toBe("would-remove");
    expect(fs.existsSync(packageJson)).toBe(true);
    expect(fs.existsSync(options.stateFile)).toBe(true);
  });
});
