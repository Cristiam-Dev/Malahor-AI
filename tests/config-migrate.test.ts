import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { applyV2ConfigMigration, previewV2ConfigMigration } from "../src/cli/core/opencode-config/migrate";
import { nodeValue, readDocument } from "../src/cli/core/opencode-config/jsonc";
import { resolvePaths } from "../src/cli/core/paths";

function fixture(): { root: string; paths: ReturnType<typeof resolvePaths> } {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-config-migrate-"));
  const opencodeDir = path.join(root, "opencode");
  fs.mkdirSync(path.join(root, "home", "mnemo"), { recursive: true });
  fs.mkdirSync(opencodeDir, { recursive: true });
  fs.writeFileSync(path.join(root, "home", "mnemo", "index.js"), "// mnemo\n", "utf8");
  return {
    root,
    paths: resolvePaths({
      ...process.env,
      MALAHOR_HOME: path.join(root, "home"),
      MALAHOR_OPENCODE_DIR: opencodeDir,
      MALAHOR_OPENCODE_DETECT: "0",
    }, root),
  };
}

describe("migracion V2 verify-only", () => {
  test("preview y apply retiran solo restos Malahor con backup", () => {
    const { paths } = fixture();
    const original = `{
  // conservar comentario y modelo ajeno
  "model": "user/model",
  "permission": { "external_directory": "deny" },
  "mcp": {
    "mnemo": { "type": "local", "command": ["node", "${paths.mnemoIndex}"], "enabled": true }
  },
  "agent": {
    "build": {
      "permission": { "edit": "deny", "task": "deny", "bash": { "*": "deny", "malahor-ai doctor*": "allow" }, "webfetch": "ask" },
      "options": { "malahor": { "execution": { "intervention": "guiar" }, "policyFormat": 2 }, "foreign": true }
    }
  },
  "compaction": { "auto": true, "keep": { "tokens": 15000 }, "buffer": 25000 }
}\n`;
    fs.writeFileSync(paths.opencodeConfig, original, "utf8");

    const preview = previewV2ConfigMigration(paths);
    expect(preview.state).toBe("ready");
    expect(preview.confirmation).toBeTruthy();
    expect(preview.findings.map((finding) => finding.path)).toEqual(expect.arrayContaining([
      "/mcp/mnemo",
      "/agent/build/options/malahor",
      "/agent/build/permission/edit",
      "/agent/build/permission/task",
       "/agent/build/permission/bash",
       "/permission",
       "/compaction",
    ]));
    expect(fs.readFileSync(paths.opencodeConfig, "utf8")).toBe(original);

    const result = applyV2ConfigMigration(paths, preview.confirmation!);
    expect(result.backup).toBeTruthy();
    expect(fs.existsSync(result.backup!)).toBe(true);

    const migrated = fs.readFileSync(paths.opencodeConfig, "utf8");
    const value = nodeValue(readDocument(migrated).root) as Record<string, unknown>;
    expect(migrated).toContain("conservar comentario");
    expect(value.model).toBe("user/model");
    expect(value.permission).toBeUndefined();
    expect((value.mcp as Record<string, unknown> | undefined)?.mnemo).toBeUndefined();
    expect(value.compaction).toBeUndefined();
    const build = ((value.agent as Record<string, unknown>).build as Record<string, unknown>);
    expect((build.options as Record<string, unknown>).malahor).toBeUndefined();
    expect(build.permission).toEqual({ webfetch: "ask" });
  });

  test("compaction custom queda bloqueada para revision manual", () => {
    const { paths } = fixture();
    fs.writeFileSync(paths.opencodeConfig, `${JSON.stringify({ compaction: { auto: true, keep: { tokens: 8000 }, buffer: 20000 } }, null, 2)}\n`, "utf8");

    const preview = previewV2ConfigMigration(paths);
    expect(preview.state).toBe("blocked");
    expect(preview.findings[0]?.removable).toBe(false);
    expect(() => applyV2ConfigMigration(paths, "INVALID")).toThrow();
  });
});
