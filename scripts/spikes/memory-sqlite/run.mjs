import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const base = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
const directory = fs.mkdtempSync(path.join(base, "malahor-memory-sqlite-"));
fs.chmodSync(directory, 0o700);
const worker = fileURLToPath(new URL("worker.mjs", import.meta.url));
const candidates = [
  { driver: "node", executable: "node", required: true },
  { driver: "bun", executable: "bun", required: false },
  { driver: "better", executable: "node", required: false },
];

function run(candidate, action, sandbox) {
  const result = spawnSync(candidate.executable, [worker, candidate.driver, action, sandbox], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") return { driver: candidate.driver, status: "unavailable", reason: `${candidate.executable} no instalado` };
  if (result.error || result.status !== 0) {
    return { driver: candidate.driver, status: "failed", reason: result.error?.message ?? result.stderr, exitCode: result.status };
  }
  try {
    return { ...JSON.parse(result.stdout), diagnostics: result.stderr.trim() };
  } catch {
    return { driver: candidate.driver, status: "failed", reason: "El probe no devolvio JSON valido", diagnostics: result.stderr };
  }
}

const results = candidates.map((candidate) => {
  const sandbox = fs.mkdtempSync(path.join(directory, `malahor-memory-sqlite-${candidate.driver}-`));
  fs.chmodSync(sandbox, 0o700);
  return { ...run(candidate, "probe", sandbox), sandbox };
});
const interoperability = [];
for (const origin of results.filter((r) => ["node", "bun"].includes(r.driver) && r.status === "passed")) {
  const peer = candidates.find((c) => ["node", "bun"].includes(c.driver) && c.driver !== origin.driver);
  if (!results.some((r) => r.driver === peer.driver && r.status === "passed")) continue;
  const write = run(peer, "interop-write", origin.sandbox);
  const read = write.status === "passed" ? run(candidates.find((c) => c.driver === origin.driver), "interop-read", origin.sandbox) : null;
  interoperability.push({ from: origin.driver, via: peer.driver, write, read });
}
const passed = results.every((r) => r.status === "passed" || (r.status === "unavailable" && !candidates.find((c) => c.driver === r.driver).required))
  && interoperability.every((r) => r.write.status === "passed" && r.read?.status === "passed");
const report = { task: "T-5.3.1", passed, directory, results, interoperability };
fs.writeFileSync(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
