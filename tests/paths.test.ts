import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../src/cli/core/paths";

function fixtureRoot(): string {
  return fs.mkdtempSync(path.join("/tmp/opencode", "malahor-paths-"));
}

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
