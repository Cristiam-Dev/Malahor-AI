import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  ensurePrivateDirectory,
  privateDirectoryReady,
  resolvePaths,
} from "../src/cli/core/paths";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-paths-"));
  fixtures.push(root);
  return root;
}

describe("private directories", () => {
  test("crea un directorio privado listo para usar", () => {
    const directory = path.join(fixtureRoot(), "mnemo", "data");

    expect(privateDirectoryReady(directory)).toBe(false);
    ensurePrivateDirectory(directory);

    expect(fs.lstatSync(directory).isDirectory()).toBe(true);
    expect(privateDirectoryReady(directory)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  test("repara un directorio POSIX con permisos permisivos", () => {
    const directory = path.join(fixtureRoot(), "mnemo");
    fs.mkdirSync(directory, { mode: 0o777 });

    if (process.platform !== "win32") {
      fs.chmodSync(directory, 0o777);
      expect(privateDirectoryReady(directory)).toBe(false);
    }

    ensurePrivateDirectory(directory);

    expect(privateDirectoryReady(directory)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  test("rechaza un symlink sin alterar el directorio objetivo", () => {
    const root = fixtureRoot();
    const target = path.join(root, "target");
    const link = path.join(root, "mnemo");
    const sentinel = path.join(target, "sentinel.txt");
    fs.mkdirSync(target, { mode: 0o755 });
    fs.writeFileSync(sentinel, "intacto\n", "utf8");
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    const targetMode = fs.statSync(target).mode & 0o777;

    expect(privateDirectoryReady(link)).toBe(false);
    expect(() => ensurePrivateDirectory(link)).toThrow(/real|symlink/i);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("intacto\n");
    expect(fs.readdirSync(target)).toEqual(["sentinel.txt"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(target).mode & 0o777).toBe(targetMode);
    }
  });
});

describe("path resolution", () => {
  test("detecta el directorio real de OpenCode desde la API v2", () => {
    const root = fixtureRoot();
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeOpenCode = path.join(binDir, "opencode");
    fs.writeFileSync(fakeOpenCode, `#!/usr/bin/env node
console.log(JSON.stringify([
  { type: "document", path: "C:\\\\Users\\\\3209432\\\\.config\\\\opencode\\\\opencode.jsonc", info: {} },
  { type: "directory", path: "C:\\\\Users\\\\3209432\\\\.config\\\\opencode" }
]));
`, "utf8");
    fs.chmodSync(fakeOpenCode, 0o755);

    const paths = resolvePaths({
      HOME: root,
      USERPROFILE: "C:\\Users\\3209432",
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    }, root, "win32");

    expect(paths.opencodeDir).toBe("C:\\Users\\3209432\\.config\\opencode");
    expect(paths.opencodeConfig).toBe("C:\\Users\\3209432\\.config\\opencode\\opencode.jsonc");
  });

  test("detecta rutas aunque cambie la forma del JSON de OpenCode", () => {
    const root = fixtureRoot();
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeOpenCode = path.join(binDir, "opencode");
    fs.writeFileSync(fakeOpenCode, `#!/usr/bin/env node
console.log(JSON.stringify({
  config: {
    documents: [{ file: "ignored", path: "/Users/felipe/.config/opencode/opencode.json" }]
  }
}));
`, "utf8");
    fs.chmodSync(fakeOpenCode, 0o755);

    const paths = resolvePaths({
      HOME: "/Users/felipe",
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    }, root, "darwin");

    expect(paths.opencodeDir).toBe("/Users/felipe/.config/opencode");
  });

  test("si la API falla usa una ruta existente con config", () => {
    const root = fixtureRoot();
    const configDir = path.join(root, ".config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "opencode.jsonc"), "{}", "utf8");

    const paths = resolvePaths({
      HOME: root,
      MALAHOR_OPENCODE_BIN: path.join(root, "missing-opencode"),
    }, root, "linux");

    expect(paths.opencodeDir).toBe(configDir);
  });

  test("MALAHOR_OPENCODE_DIR gana sobre deteccion automatica", () => {
    const root = fixtureRoot();
    const paths = resolvePaths({
      HOME: root,
      MALAHOR_OPENCODE_DIR: path.join(root, "custom-opencode"),
    }, root);

    expect(paths.opencodeDir).toBe(path.join(root, "custom-opencode"));
    expect(paths.docsDir).toBe(path.join(root, ".malahor", "docs"));
    expect(paths.docsIndex).toBe(path.join(root, ".malahor", "docs", "index.js"));
    expect(paths.vaultDir).toBe(path.join(root, ".malahor", "vault"));
  });

  test("fallback Windows usa ~/.config/opencode sin depender de AppData", () => {
    const root = fixtureRoot();
    const paths = resolvePaths({
      USERPROFILE: "C:\\Users\\Felipe",
      APPDATA: "C:\\Users\\Felipe\\AppData\\Roaming",
      MALAHOR_OPENCODE_DETECT: "0",
    }, root, "win32");

    expect(paths.opencodeDir).toBe("C:\\Users\\Felipe\\.config\\opencode");
  });
});
