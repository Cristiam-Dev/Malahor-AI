import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { memorySandbox } from "./memory-engine-fixture";

interface RuntimeReport {
  passed: boolean;
  action: string;
  sourceHash: string;
  observations: number;
  latestSession: string | null;
  rootLatestSession: string | null;
  backups: number;
  runtime: { node: string; bun: string | null };
}

let artifact: string;

beforeAll(async () => {
  const { root } = memorySandbox();
  const build = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "fixtures/memory-migration-runtime.ts")],
    outdir: path.join(root, "installed"),
    naming: "migration.mjs",
    format: "esm",
    target: "node",
  });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  artifact = build.outputs[0].path;
  expect(fs.readdirSync(path.dirname(artifact))).toEqual(["migration.mjs"]);
});

function seed(root: string): void {
  fs.mkdirSync(path.join(root, "mnemo"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, "mnemo", "db.json"), `${JSON.stringify({
    observations: [
      { id: 9, project: "Acme Legacy/Store", type: "decision", title: "Legacy runtime", content: "preserve",
        tags: "migration", created_at: "2026-10-01T10:00:00.000Z" },
      { id: 2, project: "global", type: "general", title: "Global", content: "all scopes",
        tags: "migration", created_at: "2026-10-01T10:00:00.000Z" },
    ],
    sessions: [{ project: "Acme Legacy/Store", summary: "Legacy checkpoint", created_at: "2026-10-01T10:00:00.000Z" }],
    nextId: 40,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "config.jsonc"), JSON.stringify({ projects: { aliases: { acme: ["Acme Legacy"] } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({
    acme: { context: "mnemo", roots: [root], defaultRoot: root },
  }), { mode: 0o600 });
}

function run(executable: string, action: string, root: string): RuntimeReport {
  const result = spawnSync(executable, [artifact, action, root], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      MALAHOR_HOME: root,
      MALAHOR_CONFIG: path.join(root, "config.jsonc"),
      MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
      MALAHOR_OPENCODE_DETECT: "0",
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as RuntimeReport;
  expect(report.passed).toBe(true);
  return report;
}

describe("migrador real desde bundle autocontenido", () => {
  for (const [origin, peer] of [["node", "bun"], ["bun", "node"]]) {
    test(`${origin} migra -> ${peer} escribe -> ${origin} relee sin tocar JSON`, () => {
      const { root } = memorySandbox();
      seed(root);
      const migrated = run(origin, "migrate", root);
      const appended = run(peer, "append", root);
      const read = run(origin, "read", root);
      expect(migrated.runtime.bun === null).toBe(origin === "node");
      expect(appended.runtime.bun === null).toBe(peer === "node");
      expect(appended.sourceHash).toBe(migrated.sourceHash);
      expect(read.sourceHash).toBe(migrated.sourceHash);
      expect(read).toMatchObject({ observations: 4, latestSession: "Legacy checkpoint",
        rootLatestSession: "Runtime checkpoint", backups: 1 });
      fs.writeFileSync(path.join(root, "migration-runtime-report.json"),
        JSON.stringify({ migrated, appended, read }, null, 2), { mode: 0o600 });
    });
  }
});
