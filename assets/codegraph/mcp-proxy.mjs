// malahor-managed: read-only, project-bound stdio MCP bridge for symgraph v2026.10.18.
// This is the only executable exposed by the Malahor CodeGraph MCP registration.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync, backup } from "node:sqlite";

const SAFE_TOOLS = new Set([
  "symgraph-context", "symgraph-search", "symgraph-callers", "symgraph-callees",
  "symgraph-definition", "symgraph-file", "symgraph-references", "symgraph-node",
  "symgraph-status", "symgraph-hierarchy", "symgraph-path", "symgraph-unused",
  "symgraph-implementations",
]);
const PINNED_BINARY_SHA256 = {
  "linux:x64": "0a20a58846850bfe5ceca9b8ea437b81f9069364543fd6a7c21f7081de67cfb3",
  "linux:arm64": "4d9ab74d52c5ba45654d05ababd569dd552e9a8280a19be17fc988b3b7508a30",
  "darwin:x64": "315ff7d65ac98073033b9c88869a48c44b3f19989b0bbe6214fade3683e5a873",
  "darwin:arm64": "4c15a88ad040902fd15be5507550a71d20fd8387293e18f32c586e51a966874e",
  "win32:x64": "3a834de37e870bfe0ab14217ddafbefd990442982a0c4c07965d5cd4e9089e32",
};
const statusMode = process.argv[2] === "--status";
const [binary, root, database, project, projectsFile, malahorHome] = process.argv.slice(statusMode ? 3 : 2);

function contained(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function verify() {
  if ([binary, root, database, project, projectsFile, malahorHome].some((value) => !value)) throw new Error("argumentos incompletos");
  const home = fs.realpathSync(malahorHome);
  if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) throw new Error("raiz no canonica");
  if (contained(home, root) || contained(root, home)) throw new Error("indice dentro del proyecto");
  const registry = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
  if (!registry[project]?.roots?.some((entry) => fs.realpathSync(entry) === root)) throw new Error("proyecto no registrado");
  for (const record of Object.values(registry)) {
    for (const entry of record?.roots ?? []) {
      if (contained(home, fs.realpathSync(entry))) throw new Error("MALAHOR_HOME dentro de un proyecto registrado");
    }
  }
  const indexDir = path.join(home, "codegraph", "indexes", createHash("sha256").update(root).digest("hex"));
  if (database !== path.join(indexDir, "index.db")) throw new Error("ubicacion de indice inesperada");
  for (const target of [path.join(home, "codegraph"), path.join(home, "codegraph", "bin"), indexDir]) {
    if (fs.realpathSync(target) !== target) throw new Error("directorio gestionado redirigido");
  }
  if (!fs.lstatSync(database).isFile() || fs.realpathSync(database) !== database) throw new Error("base no gestionada");
  const ownership = path.join(indexDir, "ownership.json");
  if (!fs.lstatSync(ownership).isFile()) throw new Error("propiedad de indice no regular");
  const state = JSON.parse(fs.readFileSync(ownership, "utf8"));
  if (state.provider !== "symgraph" || state.version !== "2026.10.18" || state.ready !== true || state.project !== project || state.root !== root || state.database !== database) {
    throw new Error("indice sin propiedad valida");
  }
  if (binary !== path.join(home, "codegraph", "bin", process.platform === "win32" ? "symgraph.exe" : "symgraph") || !fs.lstatSync(binary).isFile()) {
    throw new Error("binario no gestionado");
  }
  const binaryState = path.join(path.dirname(binary), "managed.json");
  if (!fs.lstatSync(binaryState).isFile()) throw new Error("propiedad de binario no regular");
  const managed = JSON.parse(fs.readFileSync(binaryState, "utf8"));
  const binaryHash = createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  if (managed.provider !== "symgraph" || managed.version !== "2026.10.18" || binaryHash !== managed.sha256
    || binaryHash !== PINNED_BINARY_SHA256[`${process.platform}:${process.arch}`]) {
    throw new Error("integridad del binario invalida");
  }
}

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);
}

function validFileHint(args) {
  for (const key of ["file", "path"]) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => part === ".." || part === ".")) return false;
  }
  return true;
}

// symgraph opens every SQLite database read/write and runs schema initialization
// on serve startup. A consistent private snapshot keeps that side effect and
// any future vendor migration away from the consented, managed index.
async function snapshotIndex() {
  if (fs.statSync(database).size > 512 * 1024 * 1024) throw new Error("indice supera 512 MiB; MCP degradado sin copiarlo");
  const parent = path.join(malahorHome, "codegraph", "snapshots");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(parent) !== parent || contained(parent, root)) throw new Error("ruta de snapshot redirigida");
  const directory = fs.mkdtempSync(path.join(parent, "session-"));
  const target = path.join(directory, "index.db");
  try {
    fs.chmodSync(directory, 0o700);
    const source = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
    try { await backup(source, target); } finally { source.close(); }
    fs.chmodSync(target, 0o600);
    verify(); // An invalidated index must never be exposed through the snapshot.
    return { directory, target };
  } catch (error) {
    disposeSnapshot(directory);
    throw error;
  }
}

function disposeSnapshot(directory) {
  try {
    const parent = path.join(malahorHome, "codegraph", "snapshots");
    if (path.dirname(directory) !== parent || fs.realpathSync(parent) !== parent || fs.realpathSync(directory) !== directory) return;
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.error(`CodeGraph MCP: snapshot temporal pendiente de limpieza (${error.message})`);
  }
}

try {
  verify();
  const snapshot = await snapshotIndex();
  if (statusMode) {
    try {
      process.stdout.write(execFileSync(binary, ["status", root, "--db", snapshot.target, "--format", "json"], {
        cwd: root, env: providerEnvironment(snapshot.target), encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
      }));
    } finally {
      disposeSnapshot(snapshot.directory);
    }
  } else {
    startMcp(snapshot);
  }
} catch (error) {
  console.error(`CodeGraph MCP no disponible: ${error.message}`);
  process.exitCode = 1;
}

function providerEnvironment(snapshotDatabase) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: malahorHome,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP } : {}),
    SYMGRAPH_ROOT: root,
    SYMGRAPH_DB: snapshotDatabase,
  };
}

function startMcp(snapshot) {
  const child = spawn(binary, ["serve", "--db", snapshot.target], {
    cwd: root,
    stdio: ["pipe", "pipe", "inherit"],
    env: providerEnvironment(snapshot.target),
  });
  const pending = new Map();
  child.on("error", (error) => { console.error(`CodeGraph MCP degradado: ${error.message}`); process.exitCode = 1; });
  child.on("close", (code) => { disposeSnapshot(snapshot.directory); process.exitCode = code || process.exitCode || 0; });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  const upstream = createInterface({ input: child.stdout });
  upstream.on("line", (line) => {
    try {
      if (line.length > 8_000_000) throw new Error("respuesta demasiado grande");
      const message = JSON.parse(line);
      const key = JSON.stringify(message.id);
      const method = pending.get(key);
      if (!method) return; // Never expose unsolicited upstream requests or notifications.
      pending.delete(key);
      if (method === "tools/list" && Array.isArray(message.result?.tools)) {
        message.result.tools = message.result.tools.filter((tool) => SAFE_TOOLS.has(tool.name));
      }
      if (method === "initialize" && message.result) {
        delete message.result.instructions; // Upstream advertises reindexing here.
        message.result.capabilities = { tools: message.result.capabilities?.tools ?? {} };
      }
      process.stdout.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      console.error(`CodeGraph MCP: respuesta invalida (${error.message})`);
      child.kill();
    }
  });
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.length > 2_000_000) { reply(null, undefined, { code: -32600, message: "Solicitud demasiado grande" }); return; }
    let request;
    try { request = JSON.parse(line); } catch { reply(null, undefined, { code: -32700, message: "JSON invalido" }); return; }
    const id = request?.id;
    const method = request?.method;
    if (method === "notifications/initialized" && id === undefined) { child.stdin.write(`${line}\n`); return; }
    if ((typeof id !== "string" && typeof id !== "number") || !Number.isFinite(id) && typeof id === "number") return;
    if (["resources/list", "resources/templates/list", "prompts/list"].includes(method)) {
      const key = method.startsWith("prompts") ? "prompts" : method.includes("templates") ? "resourceTemplates" : "resources";
      reply(id, { [key]: [] });
      return;
    }
    if (!["initialize", "ping", "tools/list", "tools/call"].includes(method)) {
      reply(id, undefined, { code: -32601, message: "Metodo no disponible en CodeGraph gestionado" });
      return;
    }
    if (method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments;
      if (!SAFE_TOOLS.has(name) || !args || typeof args !== "object" || Array.isArray(args) || !validFileHint(args)) {
        reply(id, undefined, { code: -32601, message: "Herramienta o ruta no permitida" });
        return;
      }
    }
    if (method === "tools/call") {
      try { verify(); } catch (error) {
        reply(id, undefined, { code: -32000, message: `Indice CodeGraph no disponible: ${error.message}` });
        input.close();
        child.kill();
        return;
      }
    }
    const key = JSON.stringify(id);
    if (pending.has(key)) { reply(id, undefined, { code: -32600, message: "ID duplicado" }); return; }
    pending.set(key, method);
    child.stdin.write(`${line}\n`);
  });
  input.on("close", () => child.stdin.end());
}
