import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const base = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
const directory = fs.mkdtempSync(path.join(base, "malahor-memory-sqlite-host-"));
fs.chmodSync(directory, 0o700);
const workspace = path.join(directory, "workspace");
const config = path.join(directory, "config");
const plugin = path.join(workspace, ".opencode", "plugins", "memory-runtime-spike");
for (const target of [workspace, plugin]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
const output = path.join(directory, "host-runtime.json");
const probeUrl = new URL("probe.mjs", import.meta.url).href;
const worker = fileURLToPath(new URL("worker.mjs", import.meta.url));
fs.writeFileSync(path.join(plugin, "index.ts"), `
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { interop, loadDriver, probe } from ${JSON.stringify(probeUrl)};
export default {
  id: "memory-runtime-spike",
  async setup() {
    const directory = ${JSON.stringify(directory)};
    const sandbox = (name) => {
      const dir = fs.mkdtempSync(path.join(directory, "malahor-memory-sqlite-" + name + "-"));
      fs.chmodSync(dir, 0o700);
      return dir;
    };
    const driver = process.versions.bun ? "bun" : "node";
    const directDirectory = sandbox("direct");
    const fallbackDirectory = sandbox("fallback");
    const nodeProbe = (action, directory) => {
      const result = spawnSync("node", [${JSON.stringify(worker)}, "node", action, directory], {
        encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      return result.status === 0
        ? { ...JSON.parse(result.stdout), diagnostics: result.stderr.trim() }
        : { status: "failed", reason: result.error?.message ?? result.stderr };
    };
    let direct;
    try {
      direct = { status: "passed", driver, ...probe(await loadDriver(driver), directDirectory) };
    } catch (error) {
      direct = { status: "failed", driver, reason: String(error) };
    }
    const nodeFallback = nodeProbe("probe", fallbackDirectory);
    const interoperability = [];
    if (direct.status === "passed" && nodeFallback.status === "passed") {
      const nodeWrite = nodeProbe("interop-write", directDirectory);
      const hostRead = { status: "passed", ...interop(await loadDriver(driver), directDirectory, false) };
      const hostWrite = { status: "passed", ...interop(await loadDriver(driver), fallbackDirectory, true) };
      const nodeRead = nodeProbe("interop-read", fallbackDirectory);
      interoperability.push({ from: "host", via: "node", write: nodeWrite, read: hostRead });
      interoperability.push({ from: "node", via: "host", write: hostWrite, read: nodeRead });
    }
    const result = {
      runtime: { node: process.version, bun: process.versions.bun ?? null },
      direct, nodeFallback, interoperability,
    };
    fs.writeFileSync(${JSON.stringify(`${output}.tmp`)}, JSON.stringify(result, null, 2) + "\\n", { mode: 0o600 });
    fs.renameSync(${JSON.stringify(`${output}.tmp`)}, ${JSON.stringify(output)});
  },
};
`, { mode: 0o600 });

// Un servidor privado, sin credenciales/config del host y sin generar prompts/modelos.
const password = randomBytes(32).toString("hex");
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  HOME: directory, USERPROFILE: directory,
  XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(directory, "data"),
  XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "state"),
  MALAHOR_HOME: path.join(directory, "malahor"), TMPDIR: directory, NO_COLOR: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [plugin] }),
  OPENCODE_SERVER_PASSWORD: password,
};
const child = spawn("opencode", ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stderr.on("data", (data) => { stderr += data; });
const exited = new Promise((resolve) => child.once("close", resolve));
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout al iniciar host privado")), 20_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("El host privado termino antes de publicar URL")); });
    child.stdout.on("data", (data) => {
      stdout += data;
      const match = stdout.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const endpoint = `/api/agent?location%5Bdirectory%5D=${encodeURIComponent(workspace)}`;
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  const infoResponse = await fetch(new URL("/api/info", url), { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(infoResponse.ok, true);
  const info = await infoResponse.json();
  const response = await fetch(new URL(endpoint, url), {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.ok, true, `Host HTTP ${response.status}`);
  await response.text();
  if (!fs.existsSync(output)) {
    await new Promise((resolve, reject) => {
      const watcher = fs.watch(directory, (_event, name) => {
        if (name === path.basename(output) && fs.existsSync(output)) {
          clearTimeout(timer); watcher.close(); resolve();
        }
      });
      const timer = setTimeout(() => {
        watcher.close(); reject(new Error(`El host no cargo el plugin; diagnostico: ${directory}`));
      }, 20_000);
      if (fs.existsSync(output)) { clearTimeout(timer); watcher.close(); resolve(); }
    });
  }
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(report.direct.status, "passed", report.direct.reason);
  assert.equal(report.nodeFallback.status, "passed", report.nodeFallback.reason);
  assert.equal(report.interoperability.length, 2);
  for (const transfer of report.interoperability) {
    assert.equal(transfer.write.status, "passed", transfer.write.reason);
    assert.equal(transfer.read.status, "passed", transfer.read.reason);
  }
  console.log(JSON.stringify({ task: "T-5.3.1", opencode: info.version, directory, ...report }, null, 2));
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  await exited;
  fs.writeFileSync(path.join(directory, "command-output.json"), JSON.stringify({ stdout, stderr }, null, 2), { mode: 0o600 });
}
