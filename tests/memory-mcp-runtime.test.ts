import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { memorySandbox, seedEngine, syntheticMarker } from "./memory-engine-fixture";
import { fixtureDb } from "./mnemo-fixture";
import { MemoryEngine } from "../src/mnemo/engine";

let artifact: string;

beforeAll(async () => {
  const { root } = memorySandbox();
  const build = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../src/mnemo/index.ts")],
    outdir: path.join(root, "installed"), naming: "mnemo.mjs", format: "esm", target: "node",
  });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  artifact = build.outputs[0].path;
  expect(fs.readdirSync(path.dirname(artifact))).toEqual(["mnemo.mjs"]);
});

function rpc(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

describe("MCP v2 bundle real", () => {
  for (const executable of ["node", "bun"]) {
    test(`${executable}: tools/list y flujo pin/rollup/promote`, () => {
      const { root, file } = memorySandbox();
      seedEngine(file, fixtureDb()).close(); syntheticMarker(root);
      fs.writeFileSync(path.join(root, "config.jsonc"), "{}", { mode: 0o600 });
      const confirm = "PROMOTE 5:acme/store/checkout/coupons->acme/store";
      const input = [
        rpc(1, "initialize"),
        rpc(2, "tools/list"),
        rpc(3, "tools/call", { name: "mem_pin", arguments: { id: 5 } }),
        rpc(4, "tools/call", { name: "mem_context", arguments: { project: "acme/store", rollup: true, limit: 1 } }),
        rpc(5, "tools/call", { name: "mem_promote_preview", arguments: { id: 5, ancestor: "acme/store" } }),
        rpc(6, "tools/call", { name: "mem_promote", arguments: { id: 5, ancestor: "acme/store", confirm } }),
        rpc(7, "tools/call", { name: "mem_tree", arguments: { prefix: "acme/store" } }),
      ].join("\n") + "\n";
      const result = spawnSync(executable, [artifact], {
        cwd: root, input, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, MALAHOR_HOME: root,
          MALAHOR_CONFIG: path.join(root, "config.jsonc"), MALAHOR_OPENCODE_DIR: path.join(root, "opencode"), MALAHOR_OPENCODE_DETECT: "0" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const messages = new Map(result.stdout.trim().split("\n").map((line) => {
        const value = JSON.parse(line); return [value.id, value];
      }));
      expect(messages.get(2).result.tools.some((tool: { name: string }) => tool.name === "mem_promote")).toBe(true);
      expect(JSON.parse(messages.get(3).result.content[0].text)).toEqual({ id: 5, pinned: true });
      expect(JSON.parse(messages.get(4).result.content[0].text).observations[0].id).toBe(5);
      expect(JSON.parse(messages.get(5).result.content[0].text).requiresConfirmation).toBe(confirm);
      expect(JSON.parse(messages.get(6).result.content[0].text).promoted).toBe(true);
      expect(JSON.parse(messages.get(7).result.content[0].text).some((scope: { path: string }) => scope.path === "acme/store")).toBe(true);
      const engine = MemoryEngine.open(file, { access: "write" });
      try { expect(engine.get(5)?.project).toBe("acme/store"); engine.integrity(); } finally { engine.close(); }
      expect(fs.readdirSync(path.join(root, "backups"))).toHaveLength(1);
    });
  }
});
