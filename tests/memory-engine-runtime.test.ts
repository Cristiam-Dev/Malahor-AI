import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { memorySandbox } from "./memory-engine-fixture";

let artifact: string;
interface Report { passed: boolean; action: string; legacyHash: string; runtime: { node: string; bun: string | null }; }

beforeAll(async () => {
  const { root } = memorySandbox();
  const build = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "fixtures/memory-engine-runtime.ts")],
    outdir: path.join(root, "installed"), naming: "memory.mjs", format: "esm", target: "node",
  });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  artifact = build.outputs[0].path;
  expect(fs.readdirSync(path.dirname(artifact))).toEqual(["memory.mjs"]);
});

function run(executable: string, action: string, root: string): Report {
  const result = spawnSync(executable, [artifact, action, root], {
    cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, MALAHOR_HOME: root,
      MALAHOR_CONFIG: path.join(root, "config.jsonc"), MALAHOR_OPENCODE_DIR: path.join(root, "opencode"), MALAHOR_OPENCODE_DETECT: "0" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(report.passed).toBe(true);
  return report;
}

describe("engine y fachada en runtime real desde bundle autocontenido", () => {
  for (const [origin, peer] of [["node", "bun"], ["bun", "node"]]) {
    test(`${origin} -> ${peer} -> ${origin}: MCP/CLI/contexto, FTS, backup e IDs`, () => {
      const { root } = memorySandbox();
      const first = run(origin, "exercise", root);
      const append = run(peer, "append", root);
      const read = run(origin, "read", root);
      expect(first.runtime.bun === null).toBe(origin === "node");
      expect(append.legacyHash).toBe(first.legacyHash);
      expect(read.legacyHash).toBe(first.legacyHash);
      fs.writeFileSync(path.join(root, "runtime-report.json"), JSON.stringify({ first, append, read }, null, 2), { mode: 0o600 });
    });
  }
});
