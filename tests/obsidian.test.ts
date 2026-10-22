import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { syncOpenCodeObsidian } from "../src/cli/commands/obsidian";
import { resolvePaths } from "../src/cli/core/paths";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-obsidian-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("configuracion de Obsidian", () => {
  test("no agrega un deny global de external_directory", () => {
    const paths = resolvePaths({
      ...process.env,
      MALAHOR_HOME: path.join(root, "home"),
      MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
      MALAHOR_OPENCODE_DETECT: "0",
    }, root);
    fs.mkdirSync(path.dirname(paths.opencodeConfig), { recursive: true });
    fs.writeFileSync(paths.opencodeConfig, `${JSON.stringify({ model: "user-model" }, null, 2)}\n`, "utf8");

    const next = syncOpenCodeObsidian(paths, paths.opencodeConfig, "wsl-windows", "/tmp/mcp-obsidian.sh", true);

    expect(next.permission).toBeUndefined();
    expect((next.mcp as Record<string, unknown>).obsidian).toEqual({
      type: "local",
      command: ["/tmp/mcp-obsidian.sh"],
      enabled: true,
    });
  });
});
