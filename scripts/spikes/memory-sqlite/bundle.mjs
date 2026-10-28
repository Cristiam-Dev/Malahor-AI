import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const base = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
const directory = fs.mkdtempSync(path.join(base, "malahor-memory-sqlite-bundle-"));
fs.chmodSync(directory, 0o700);
const entry = path.join(directory, "entry.mjs");
const artifact = path.join(directory, "installed", "index.mjs");
const probeFile = fileURLToPath(new URL("probe.mjs", import.meta.url));
const schemaFile = fileURLToPath(new URL("schema.sql", import.meta.url));
fs.writeFileSync(entry, `
import schema from ${JSON.stringify(schemaFile)} with { type: "text" };
import { runProbeCommand } from ${JSON.stringify(probeFile)};
await runProbeCommand(schema).catch((error) => { console.error(error); process.exitCode = 1; });
`, { mode: 0o600 });

const build = await Bun.build({ entrypoints: [entry], outdir: path.dirname(artifact), naming: "index.mjs", target: "node", format: "esm" });
assert.equal(build.success, true, build.logs.map(String).join("\n"));
assert.deepEqual(fs.readdirSync(path.dirname(artifact)), ["index.mjs"]);
const results = [];
for (const executable of ["node", "bun"]) {
  const sandbox = fs.mkdtempSync(path.join(directory, `malahor-memory-sqlite-${executable}-`));
  fs.chmodSync(sandbox, 0o700);
  const result = spawnSync(executable, [artifact, executable, "probe", sandbox], {
    cwd: path.dirname(artifact), encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "passed");
  results.push({ ...report, diagnostics: result.stderr.trim() });
}
const report = { task: "T-5.3.1", directory, artifact, results };
fs.writeFileSync(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
