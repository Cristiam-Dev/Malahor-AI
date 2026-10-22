import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { applyV2Consolidation, previewV2Consolidation } from "../src/cli/core/opencode-config/v2";
import { buildRollbackPlan } from "../src/cli/core/opencode-config/apply";
import { nodeValue, readDocument } from "../src/cli/core/opencode-config/jsonc";

function fixture(): string {
  return fs.mkdtempSync(path.join("/tmp/opencode", "malahor-config-v2-"));
}

describe("consolidacion V2 explicita", () => {
  test("convierte mcp.servers, conserva seguridad y deja rollback", () => {
    const directory = fixture();
    const mnemo = path.join(directory, "mnemo.js");
    fs.writeFileSync(mnemo, "// mnemo\n", "utf8");
    fs.writeFileSync(path.join(directory, "opencode.jsonc"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { mnemo: { type: "local", command: ["node", mnemo], enabled: true } },
      compaction: { auto: true },
      agent: { build: { options: { malahor: { policyFormat: 2 } } } },
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(directory, "opencode.json"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        servers: {
          mnemo: { type: "local", command: ["node", mnemo] },
          obsidian: { type: "remote", url: "https://obsidian.example/mcp" },
        },
      },
      permission: { external_directory: "deny" },
    }, null, 2)}\n`, "utf8");

    const location = { opencodeDir: directory };
    const preview = previewV2Consolidation(location);
    expect(preview.state).toBe("ready");
    expect(preview.changes).toContain("/mcp/servers");
    expect(preview.changes).toContain("/mcp/mnemo");
    expect(preview.confirmation).toBeTruthy();

    const transaction = applyV2Consolidation(location, preview.confirmation!);
    expect(transaction.state).toBe("applied");
    expect(fs.existsSync(transaction.disabledPath)).toBe(true);
    expect(fs.existsSync(path.join(directory, ".malahor-config-backups", transaction.id, "opencode.json.backup"))).toBe(true);

    const config = nodeValue(readDocument(fs.readFileSync(transaction.targetPath, "utf8")).root) as Record<string, unknown>;
    const mcp = config.mcp as Record<string, unknown>;
    expect(mcp.mnemo).toBeUndefined();
    expect((mcp.servers as Record<string, unknown>).obsidian).toBeDefined();
    expect((config.permission as Record<string, unknown>).external_directory).toBe("deny");
    expect(buildRollbackPlan(location).state).toBe("ready");
  });

  test("bloquea conflictos de permisos en vez de resolverlos silenciosamente", () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, "opencode.jsonc"), JSON.stringify({ permission: { external_directory: "allow" } }), "utf8");
    fs.writeFileSync(path.join(directory, "opencode.json"), JSON.stringify({ mcp: { servers: {} }, permission: { external_directory: "deny" } }), "utf8");

    const preview = previewV2Consolidation({ opencodeDir: directory });
    expect(preview.state).toBe("blocked");
    expect(preview.conflicts).toContain("/permission/external_directory");
  });
});
