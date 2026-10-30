import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { indexCodegraph, inspectSource, statusCodegraph } from "../src/cli/core/codegraph-index";
import {
  assertExternalIndex,
  CODEGRAPH_PROVIDER,
  CODEGRAPH_PROXY_SHA256,
  CODEGRAPH_VERSION,
  codegraphBinary,
  codegraphEnvironment,
  codegraphIndex,
  codegraphProxy,
  codegraphRoot,
  codegraphRuntime,
  verifiedCodegraphBinary,
  verifiedCodegraphProxy,
} from "../src/cli/core/codegraph-runtime";
import { archiveFor, setupCodegraph } from "../src/cli/core/codegraph-setup";
import { resolvePaths, type MalahorPaths } from "../src/cli/core/paths";
import { runCodegraph } from "../src/cli/commands/codegraph";
import { runContext } from "../src/cli/commands/context";
import { runDoctor } from "../src/cli/commands/doctor";
import { isMcpToolName } from "../src/cli/core/hooks/types";
import plugin from "../src/plugin/index";

const ASSET_PROXY = path.join(import.meta.dir, "..", "assets", "codegraph", "mcp-proxy.mjs");
const SANDBOX_BINARY = "/tmp/opencode/symgraph-spike/symgraph";
const SANDBOX_ARCHIVE = "/tmp/opencode/symgraph-spike.tar.gz";
const PROJECT = "demo";

let scratch: string;
let repo: string;
let home: string;
let outside: string;
let paths: MalahorPaths;

function writeRegistry(roots = [repo], defaultRoot = repo, context = "memory+codegraph"): void {
  fs.writeFileSync(paths.projectsFile, JSON.stringify({
    [PROJECT]: { context, roots, defaultRoot },
  }), "utf8");
}

function writeJson(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
}

function hasEntry(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function copySandboxBinary(): void {
  const binary = codegraphBinary(paths);
  fs.mkdirSync(path.dirname(binary), { recursive: true, mode: 0o700 });
  fs.copyFileSync(SANDBOX_BINARY, binary);
  fs.chmodSync(binary, 0o700);
  const digest = createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  writeJson(path.join(path.dirname(binary), "managed.json"), {
    provider: CODEGRAPH_PROVIDER, version: CODEGRAPH_VERSION, sha256: digest,
  });
  fs.copyFileSync(ASSET_PROXY, codegraphProxy(paths));
  expect(verifiedCodegraphBinary(paths)).toBe(binary);
  expect(verifiedCodegraphProxy(paths)).toBe(codegraphProxy(paths));
}

function writeReadyIndex(): void {
  const index = codegraphIndex(paths, repo);
  fs.mkdirSync(index.directory, { recursive: true });
  if (!hasEntry(index.database)) fs.writeFileSync(index.database, "synthetic DB placeholder");
  writeJson(index.state, {
    provider: CODEGRAPH_PROVIDER, version: CODEGRAPH_VERSION,
    project: PROJECT, root: repo, database: index.database, ready: true,
  });
}

async function withFixtureEnvironment<T>(callback: () => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const overrides: Record<string, string> = {
    HOME: path.join(scratch, "user"),
    XDG_CACHE_HOME: path.join(scratch, "cache"),
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    XDG_DATA_HOME: path.join(scratch, "data"),
    MALAHOR_HOME: home,
    MALAHOR_OPENCODE_DIR: path.join(scratch, "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
    MALAHOR_CONFIG: path.join(home, "config.jsonc"),
    ...extra,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try { return await callback(); } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

type RpcResponse = { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } };

function proxyRequests(requests: Array<Record<string, unknown>>): Map<number, RpcResponse> {
  const index = codegraphIndex(paths, repo);
  const result = spawnSync("node", [ASSET_PROXY, codegraphBinary(paths), repo, index.database, PROJECT, paths.projectsFile, home], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? "", HOME: path.join(scratch, "user"),
      XDG_CACHE_HOME: path.join(scratch, "cache"),
      XDG_CONFIG_HOME: path.join(scratch, "config"),
    },
    input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const responses = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RpcResponse);
  return new Map(responses.map((response) => [response.id, response]));
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-codegraph-test-"));
  repo = path.join(scratch, "repo");
  home = path.join(scratch, "malahor-home");
  outside = path.join(scratch, "outside");
  for (const directory of [repo, home, outside]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(scratch, "user"));
  paths = resolvePaths({
    HOME: path.join(scratch, "user"),
    MALAHOR_HOME: home,
    MALAHOR_OPENCODE_DIR: path.join(scratch, "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  }, repo);
  writeRegistry();
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("CodeGraph: registro, limites fisicos y preflight", () => {
  test("usa la raiz registrada y defaultRoot para un proyecto explicito desde fuera", () => {
    const second = path.join(scratch, "repo-second");
    fs.mkdirSync(second);
    writeRegistry([repo, second], second);
    expect(codegraphRoot({ ...paths, cwd: repo }, PROJECT)).toEqual({ project: PROJECT, root: repo });
    expect(codegraphRoot({ ...paths, cwd: outside }, PROJECT)).toEqual({ project: PROJECT, root: second });
    expect(() => codegraphRoot({ ...paths, cwd: outside })).toThrow(/Registra primero/);
  });

  test("rechaza MALAHOR_HOME y el directorio de indice redirigidos por symlink al repo", () => {
    const linkedHome = path.join(scratch, "linked-home");
    fs.symlinkSync(repo, linkedHome, "dir");
    expect(() => assertExternalIndex({ ...paths, malahorHome: linkedHome }, repo)).toThrow(/fuera del repositorio|redirigida/);

    const indexes = path.join(home, "codegraph", "indexes");
    fs.mkdirSync(path.dirname(indexes), { recursive: true });
    fs.symlinkSync(repo, indexes, "dir");
    expect(() => assertExternalIndex(paths, repo)).toThrow(/redirigida|repositorio/);
    expect(fs.readdirSync(repo)).not.toContain("index.db");
  });

  test("el entorno del proveedor descarta credenciales y overrides heredados", () => {
    expect(codegraphEnvironment(repo, codegraphIndex(paths, repo).database, {
      PATH: "/usr/bin", HOME: "/foreign", SYMGRAPH_DB: "/foreign/index.db",
      SYMGRAPH_ROOT: "/foreign", TEST_CREDENTIAL: "synthetic-only",
    })).toEqual({
      PATH: "/usr/bin", HOME: path.join(home, "codegraph", "indexes"),
      SYMGRAPH_DB: codegraphIndex(paths, repo).database, SYMGRAPH_ROOT: repo,
    });
  });

  test("rechaza secretos y symlinks visibles antes de indexar", () => {
    fs.writeFileSync(path.join(repo, ".env"), "synthetic fixture");
    expect(() => inspectSource(repo)).toThrow(/Ruta potencialmente sensible/);
    fs.rmSync(path.join(repo, ".env"));
    fs.symlinkSync(path.join(outside, "source.ts"), path.join(repo, "source.ts"));
    expect(() => inspectSource(repo)).toThrow(/Symlink/);
  });

  test("rechaza secretos tambien dentro de directorios ignorados", () => {
    fs.mkdirSync(path.join(repo, "node_modules", "dependency"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "dependency", "credential.pem"), "synthetic fixture");
    expect(() => inspectSource(repo)).toThrow(/Ruta potencialmente sensible/);
  });

  test("rechaza symlinks tambien dentro de directorios ignorados", () => {
    fs.mkdirSync(path.join(repo, "node_modules", "dependency"), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, "node_modules", "dependency", "linked"), "dir");
    expect(() => inspectSource(repo)).toThrow(/Symlink/);
  });

  test("rechaza archivos .git que pueden apuntar a un gitdir externo", () => {
    fs.writeFileSync(path.join(repo, ".git"), `gitdir: ${outside}\n`);
    expect(() => inspectSource(repo)).toThrow(/Metadatos Git fuera/);
  });

  test("setup no adopta binario ni proxy ajenos y no inicia descarga", async () => {
    const binary = codegraphBinary(paths);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "foreign executable");
    await expect(setupCodegraph(paths, PROJECT, repo)).rejects.toThrow(/Binario CodeGraph no gestionado/);
    expect(hasEntry(path.join(home, "codegraph", "indexes"))).toBe(false);
    fs.rmSync(binary);
    fs.writeFileSync(codegraphProxy(paths), "foreign bridge");
    await expect(setupCodegraph(paths, PROJECT, repo)).rejects.toThrow(/Puente MCP no gestionado/);
    expect(verifiedCodegraphProxy(paths)).toBeUndefined();
    expect(fs.readFileSync(codegraphProxy(paths), "utf8")).toBe("foreign bridge");
  });

  test("setup e index requieren confirmacion exacta; dry-run no crea indice ni binario", async () => {
    await withFixtureEnvironment(async () => {
      for (const action of ["setup", "index"]) {
        await runCodegraph({ action, project: PROJECT, dryRun: true });
        await expect(runCodegraph({ action, project: PROJECT, dryRun: false, confirm: "yes" }))
          .rejects.toThrow(/Confirmacion especifica requerida/);
      }
    });
    expect(hasEntry(path.join(home, "codegraph"))).toBe(false);
    expect(fs.readdirSync(repo)).toEqual([]);
  });
});

describe("CodeGraph: puente MCP read-only", () => {
  test("el nombre del servidor participa en la mediacion de herramientas MCP", () => {
    expect(isMcpToolName("codegraph_symgraph-search")).toBe(true);
    expect(isMcpToolName("codegraph_symgraph-reindex")).toBe(true); // Proxy lo rechaza aun si un permiso lo aprobara.
  });
  test("rechaza un ejecutable sustituido aunque se falsifique su marker", () => {
    const binary = codegraphBinary(paths);
    const index = codegraphIndex(paths, repo);
    const sentinel = path.join(scratch, "reindex-was-called");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, `#!/usr/bin/env node\nimport fs from "node:fs";\nimport { createInterface } from "node:readline";\nconst input = createInterface({ input: process.stdin });\ninput.on("line", (line) => {\n  const request = JSON.parse(line);\n  if (request.method === "tools/call" && request.params?.name === "symgraph-reindex") fs.writeFileSync(${JSON.stringify(sentinel)}, "called");\n  const result = request.method === "tools/list"\n    ? { tools: [{ name: "symgraph-reindex" }, { name: "symgraph-search" }, { name: "foreign-write" }] }\n    : request.method === "initialize" ? { capabilities: { tools: {} }, instructions: "run reindex" }\n    : { content: [{ type: "text", text: "fixture search result" }] };\n  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");\n});\n`, { mode: 0o700 });
    writeJson(path.join(path.dirname(binary), "managed.json"), {
      provider: CODEGRAPH_PROVIDER, version: CODEGRAPH_VERSION,
      sha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
    });
    fs.mkdirSync(index.directory, { recursive: true });
    const db = new Database(index.database, { create: true });
    db.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY)");
    db.close();
    writeReadyIndex();
    const before = createHash("sha256").update(fs.readFileSync(index.database)).digest("hex");
    const result = spawnSync("node", [ASSET_PROXY, binary, repo, index.database, PROJECT, paths.projectsFile, home], {
      input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
      ].map((request) => JSON.stringify(request)).join("\n") + "\n",
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("integridad del binario invalida");
    expect(result.stdout).toBe("");
    expect(hasEntry(sentinel)).toBe(false);
    expect(createHash("sha256").update(fs.readFileSync(index.database)).digest("hex")).toBe(before);
    expect(hasEntry(path.join(home, "codegraph", "snapshots"))).toBe(false);
  });
});

test("MCP CodeGraph solo se registra con nivel nuevo e indice gestionado; legacy nunca activa codigo", async () => {
  // Nunca sustituir el hash de confianza en memoria: usar solo un binario
  // fijado real de la sandbox para probar el camino positivo, si esta presente.
  const available = process.platform === "linux" && process.arch === "x64" && fs.existsSync(SANDBOX_BINARY);
  if (available) copySandboxBinary();
  writeReadyIndex();
  fs.mkdirSync(paths.mnemoDir, { recursive: true });
  fs.writeFileSync(paths.mnemoIndex, "// synthetic Mnemo fixture\n");
  expect(Boolean(codegraphRuntime(paths, PROJECT, repo))).toBe(available);
  await withFixtureEnvironment(async () => {
      for (const level of ["memory", "memory+codegraph", "memory+codegraph+obsidian",
        "mnemo", "mnemo+graphify", "mnemo+graphify+obsidian"]) {
        writeRegistry([repo], repo, level);
        const before = fs.readFileSync(paths.projectsFile, "utf8");
        const state: Record<string, Record<string, unknown>> = {
          codegraph: { type: "local", command: ["node", codegraphProxy(paths)], disabled: false },
          obsidian: { type: "remote", url: "http://127.0.0.1/fixture", disabled: true },
        };
        const editor = {
          get: (name: string) => state[name],
          set: (name: string, config: Record<string, unknown>) => { state[name] = config; },
        };
        const cleanup = await plugin.setup({
          location: { directory: outside, project: { canonical: repo } },
          mcp: { transform: (callback: (input: typeof editor) => void) => callback(editor) },
        });
        await cleanup?.();

        const codeEnabled = level === "memory+codegraph" || level === "memory+codegraph+obsidian";
        expect(state.codegraph.disabled).toBe(!codeEnabled || !available);
        if (codeEnabled && available) {
          expect(state.codegraph.command).toEqual([
            "node", codegraphProxy(paths), codegraphBinary(paths), repo, codegraphIndex(paths, repo).database,
            PROJECT, paths.projectsFile, home,
          ]);
        }
        expect(state.obsidian.disabled).toBe(!level.endsWith("+obsidian"));
        expect(fs.readFileSync(paths.projectsFile, "utf8")).toBe(before);
      }

      writeRegistry([repo], repo, "memory+codegraph");
      const originalWrite = process.stdout.write;
      let output = "";
      try {
        process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
        runContext({ action: "status", args: [], dryRun: false, limit: undefined, project: PROJECT });
      } finally {
        process.stdout.write = originalWrite;
      }
      // Una base sintética no es SQLite valida aunque el binario sea gestionado.
      expect(output).toMatch(/- Code context: .*degrad|\bCodeGraph: .*degrad/i);
      expect(output).not.toMatch(/- Code context: .*\b(?:enabled|available|ready|active)\b/i);
  });
});

test("un proxy directo rechaza nivel legacy antes de abrir snapshots", () => {
  writeRegistry([repo], repo, "mnemo+graphify+obsidian");
  const binary = codegraphBinary(paths);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "binario fixture sin confianza");
  writeReadyIndex();
  const index = codegraphIndex(paths, repo);
  const before = fs.readFileSync(index.database);
  const result = spawnSync("node", [ASSET_PROXY, binary, repo, index.database, PROJECT, paths.projectsFile, home], {
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
    encoding: "utf8", timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/nivel de contexto no habilita CodeGraph/);
  expect(result.stdout).toBe("");
  expect(fs.readFileSync(index.database)).toEqual(before);
  expect(hasEntry(path.join(home, "codegraph", "snapshots"))).toBe(false);
});

test("setup e index nunca preparan un proyecto legacy, aun con confirmacion exacta", async () => {
  writeRegistry([repo], repo, "mnemo+graphify+obsidian");
  const before = fs.readFileSync(paths.projectsFile, "utf8");
  await withFixtureEnvironment(async () => {
    await expect(runCodegraph({ action: "setup", project: PROJECT, dryRun: false, confirm: "INSTALL_SYMGRAPH" }))
      .rejects.toThrow(/nivel actual no habilita CodeGraph/);
    await expect(runCodegraph({ action: "index", project: PROJECT, dryRun: false, confirm: `INDEX_SYMGRAPH:${PROJECT}` }))
      .rejects.toThrow(/nivel actual no habilita CodeGraph/);
    await expect(setupCodegraph(paths, PROJECT, repo)).rejects.toThrow(/inactivo/);
    expect(() => indexCodegraph(paths, PROJECT, repo)).toThrow(/inactivo/);
  });
  expect(fs.readFileSync(paths.projectsFile, "utf8")).toBe(before);
  expect(hasEntry(path.join(home, "codegraph"))).toBe(false);
});

if (process.platform === "linux" && process.arch === "x64" && fs.existsSync(SANDBOX_BINARY)) {
  describe("CodeGraph: integracion opcional con binario sandbox", () => {
    test("no activa markers ajenos y solo registra MCP V2 para un indice gestionado, sin pisar conflictos", async () => {
      copySandboxBinary();
      const index = codegraphIndex(paths, repo);
      fs.mkdirSync(index.directory, { recursive: true });
      fs.writeFileSync(index.database, "synthetic DB placeholder");
      expect(codegraphRuntime(paths, PROJECT, repo)).toBeUndefined();
      expect(() => indexCodegraph(paths, PROJECT, repo)).toThrow(/Indice existente sin propiedad Malahor/);
      expect(fs.readFileSync(index.database, "utf8")).toBe("synthetic DB placeholder");
      writeJson(index.state, { provider: "foreign", version: CODEGRAPH_VERSION, project: PROJECT, root: repo, database: index.database, ready: true });
      expect(codegraphRuntime(paths, PROJECT, repo)).toBeUndefined();
      writeReadyIndex();
      expect(codegraphRuntime(paths, PROJECT, repo)?.database).toBe(index.database);
      fs.appendFileSync(codegraphBinary(paths), "\nfixture altered");
      expect(verifiedCodegraphBinary(paths)).toBeUndefined();
      expect(codegraphRuntime(paths, PROJECT, repo)).toBeUndefined();
      fs.copyFileSync(SANDBOX_BINARY, codegraphBinary(paths));
      expect(codegraphRuntime(paths, PROJECT, repo)?.database).toBe(index.database);

      await withFixtureEnvironment(async () => {
        const state: Record<string, Record<string, unknown>> = {};
        const sets: string[] = [];
        const editor = {
          get: (name: string) => state[name],
          set: (name: string, config: Record<string, unknown>) => { state[name] = config; sets.push(name); },
        };
        const register = async () => {
          const cleanup = await plugin.setup({
            location: { directory: outside, project: { canonical: repo } },
            mcp: { transform: (callback: (input: typeof editor) => void) => callback(editor) },
          });
          await cleanup?.();
        };

        fs.rmSync(index.state);
        await register();
        expect(state.codegraph).toBeUndefined();
        writeReadyIndex();
        await register();
        expect(state.codegraph).toMatchObject({
          type: "local", disabled: false, codemode: false, cwd: repo,
          command: ["node", codegraphProxy(paths), codegraphBinary(paths), repo, index.database, PROJECT, paths.projectsFile, home],
        });
        state.codegraph = { type: "local", command: ["node", path.join(scratch, "foreign-proxy.mjs")] };
        sets.length = 0;
        await register();
        expect(sets).not.toContain("codegraph");
        expect(state.codegraph.command).toEqual(["node", path.join(scratch, "foreign-proxy.mjs")]);

        state.codegraph = { type: "local", command: ["node", codegraphProxy(paths)], disabled: false };
        writeJson(index.state, { provider: CODEGRAPH_PROVIDER, version: CODEGRAPH_VERSION, project: PROJECT, root: repo, database: index.database, ready: false });
        sets.length = 0;
        await register();
        expect(sets).toContain("codegraph");
        expect(state.codegraph.disabled).toBe(true);
      });
    });

    test("indexa solo una fixture y permite buscar su simbolo por el MCP real", async () => {
      copySandboxBinary();
      fs.mkdirSync(path.join(repo, "src"));
      fs.writeFileSync(path.join(repo, "src", "fixture.ts"), "export function fixtureSearchSymbol() { return 42; }\n");
      const index = codegraphIndex(paths, repo);
      expect(indexCodegraph(paths, PROJECT, repo)).toContain(index.database);
      expect(codegraphRuntime(paths, PROJECT, repo)?.database).toBe(index.database);
      expect(hasEntry(path.join(repo, ".symgraph"))).toBe(false);
      await withFixtureEnvironment(async () => {
        const originalWrite = process.stdout.write;
        let output = "";
        try {
          process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
          runContext({ action: "status", args: [], dryRun: false, limit: undefined, project: PROJECT });
        } finally {
          process.stdout.write = originalWrite;
        }
        expect(output).toContain("- Code context: available");
      });
      const responses = proxyRequests([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "symgraph-search", arguments: { query: "fixtureSearchSymbol" } } },
      ]);
      expect((responses.get(2)?.result?.tools as Array<{ name: string }>).map((tool) => tool.name)).not.toContain("symgraph-reindex");
      expect((responses.get(1)?.result as { instructions?: string }).instructions).toBeUndefined();
      expect(responses.get(3)?.error).toBeUndefined();
      expect(JSON.stringify(responses.get(3)?.result)).toContain("fixtureSearchSymbol");
    });

    test("deniega en el proxy real reindex, rutas absolutas y traversal sin modificar el indice", () => {
      copySandboxBinary();
      fs.mkdirSync(path.join(repo, "src"));
      fs.writeFileSync(path.join(repo, "src", "fixture.ts"), "export function fixtureSearchSymbol() { return 42; }\n");
      const foreign = path.join(outside, "private.ts");
      fs.writeFileSync(foreign, "export const outsideFixture = 7;\n");
      const index = codegraphIndex(paths, repo);
      indexCodegraph(paths, PROJECT, repo);
      const ready = JSON.parse(statusCodegraph(paths, PROJECT, repo)) as { total_files: number; total_nodes: number };
      expect(ready.total_files).toBe(1);
      const warmup = proxyRequests([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "symgraph-search", arguments: { query: "fixtureSearchSymbol" } } },
      ]);
      expect((warmup.get(2)?.result?.tools as Array<{ name: string }>).map((tool) => tool.name)).not.toContain("symgraph-reindex");
      expect(JSON.stringify(warmup.get(3)?.result)).toContain("fixtureSearchSymbol");
      const digest = createHash("sha256").update(fs.readFileSync(index.database)).digest("hex");
      const marker = fs.readFileSync(index.state, "utf8");

      const responses = proxyRequests([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "symgraph-reindex", arguments: {} } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "symgraph-definition", arguments: { file: foreign, symbol: "outsideFixture" } } },
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "symgraph-context", arguments: { path: "../outside/private.ts", symbol: "outsideFixture" } } },
        { jsonrpc: "2.0", id: 6, method: "sampling/createMessage", params: {} },
      ]);
      for (const id of [3, 4, 5, 6]) expect(responses.get(id)?.error?.code).toBe(-32601);
      expect(JSON.stringify([...responses.values()])).not.toContain("outsideFixture = 7");
      fs.rmSync(path.join(repo, "src", "fixture.ts"));
      fs.symlinkSync(foreign, path.join(repo, "src", "fixture.ts"));
      const escaped = proxyRequests([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "symgraph-definition", arguments: { symbol: "fixtureSearchSymbol" } } },
      ]);
      expect(JSON.stringify(escaped.get(2))).not.toContain("outsideFixture = 7");
      expect(fs.readFileSync(index.state, "utf8")).toBe(marker);
      expect(fs.readFileSync(foreign, "utf8")).toBe("export const outsideFixture = 7;\n");
      expect(JSON.parse(statusCodegraph(paths, PROJECT, repo)).total_nodes).toBe(ready.total_nodes);
      // Neither rejected MCP calls nor status may rewrite the managed database.
      expect(createHash("sha256").update(fs.readFileSync(index.database)).digest("hex")).toBe(digest);
    });

    test("deniega en el hook antes de inspeccionar archivos sensibles", async () => {
      copySandboxBinary();
      fs.writeFileSync(path.join(repo, ".env"), "synthetic fixture\n");
      const index = codegraphIndex(paths, repo);
      await withFixtureEnvironment(async () => {
        expect(() => indexCodegraph(paths, PROJECT, repo)).toThrow(/MAL-HOOK-POLICY-CORPORATE/);
      }, { MALAHOR_CORPORATE_POLICY: path.join(scratch, "missing-corporate-policy.json") });
      expect(hasEntry(index.database)).toBe(false);
      expect(hasEntry(index.state)).toBe(false);
    });
  });
}

if (process.platform === "linux" && process.arch === "x64" && fs.existsSync(SANDBOX_ARCHIVE)) {
  test("setup usa solo un archive verificado en sandbox, where/status son externos y repetir no descarga", async () => {
    const archive = archiveFor();
    expect(archive).toBeDefined();
    const bytes = fs.readFileSync(SANDBOX_ARCHIVE);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(archive!.sha256);
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "fixture.ts"), "export function archiveFixtureSymbol() { return 1; }\n");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async (input) => {
      fetchCalls++;
      expect(String(input)).toBe(`https://github.com/grahambrooks/symgraph/releases/download/v${CODEGRAPH_VERSION}/${archive!.name}`);
      if (fetchCalls !== 1) throw new Error("setup repetido no debe descargar");
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    };
    try {
      await withFixtureEnvironment(async () => {
        expect(await setupCodegraph(paths, PROJECT, repo)).toContain("instalados y verificados");
        expect(verifiedCodegraphBinary(paths)).toBe(codegraphBinary(paths));
        expect(verifiedCodegraphProxy(paths)).toBe(codegraphProxy(paths));
        const index = codegraphIndex(paths, repo);
        expect(indexCodegraph(paths, PROJECT, repo)).toContain(index.database);
        const where = execFileSync(codegraphBinary(paths), ["where"], {
          cwd: repo,
          env: codegraphEnvironment(repo, index.database, { PATH: process.env.PATH }),
          encoding: "utf8", timeout: 10_000,
        });
        expect(where).toContain(index.database);
        expect(where).toContain("SYMGRAPH_DB");
        const status = JSON.parse(statusCodegraph(paths, PROJECT, repo)) as { total_files: number; total_nodes: number };
        expect(status.total_files).toBe(1);
        expect(status.total_nodes).toBeGreaterThan(0);
        expect(await setupCodegraph(paths, PROJECT, repo)).toContain("verificados en");
        expect(fetchCalls).toBe(1);
        expect(hasEntry(path.join(repo, ".symgraph"))).toBe(false);
        expect(index.database.startsWith(`${home}${path.sep}`)).toBe(true);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("doctor sin self-heal avisa CodeGraph ausente sin bloquear un host V2 aislado", async () => {
  const fakeHost = path.join(scratch, "opencode-fixture");
  fs.writeFileSync(fakeHost, "#!/bin/sh\nprintf '2.1.2\\n'\n", { mode: 0o700 });
  writeJson(path.join(repo, "package.json"), { name: "malahor-ai" });
  fs.mkdirSync(path.join(repo, "assets"));
  writeJson(paths.projectsFile, { malahor: { context: "memory+codegraph", roots: [repo], defaultRoot: repo } });
  fs.mkdirSync(paths.mnemoDir);
  fs.writeFileSync(paths.mnemoIndex, "// synthetic Mnemo stub\n");
  fs.mkdirSync(paths.assetsDir);
  fs.mkdirSync(paths.opencodeDir, { recursive: true });
  fs.writeFileSync(paths.agentsMd, "Synthetic user-owned instructions\n");
  writeJson(paths.opencodeConfig, {
    mcp: { mnemo: { type: "local", command: ["node", paths.mnemoIndex], enabled: true } },
    compaction: { auto: true },
  });
  writeJson(path.join(paths.opencodeDir, "package.json"), { dependencies: { "@opencode/plugin": "2.0.4" } });
  writeJson(path.join(paths.opencodeDir, "node_modules", "@opencode", "plugin", "package.json"), { version: "2.0.4" });
  fs.mkdirSync(paths.malahorPluginDir, { recursive: true });
  fs.writeFileSync(path.join(paths.malahorPluginDir, "index.ts"), "// malahor-managed\nconst PLUGIN_VERSION = \"0.4.0\";\n");
  const before = fs.readdirSync(home).sort();
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  let output = "";
  try {
    await withFixtureEnvironment(async () => {
      process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
      runDoctor({ dryRun: false, selfHeal: false });
    }, { MALAHOR_OPENCODE_BIN: fakeHost });
    expect(output).toMatch(/Project context: .*memory\+codegraph/);
    expect(output).toMatch(/^WARN CodeGraph: /m);
    expect(output).not.toMatch(/^FAIL /m);
    expect(output).toMatch(/Status: ready with \d+ warning\(s\)/);
    expect(process.exitCode).not.toBe(1);
    expect(fs.readdirSync(home).sort()).toEqual(before);
    expect(hasEntry(path.join(home, "codegraph"))).toBe(false);

    for (const disabledLevel of ["memory", "mnemo", "mnemo+graphify", "mnemo+graphify+obsidian"]) {
      writeJson(paths.projectsFile, { malahor: { context: disabledLevel, roots: [repo], defaultRoot: repo } });
      const registry = fs.readFileSync(paths.projectsFile, "utf8");
      output = "";
      await withFixtureEnvironment(async () => {
        runDoctor({ dryRun: false, selfHeal: false });
      }, { MALAHOR_OPENCODE_BIN: fakeHost });
      expect(output).not.toMatch(/^WARN CodeGraph: /m);
      expect(output).toMatch(/Project context: /);
      expect(fs.readFileSync(paths.projectsFile, "utf8")).toBe(registry);
      expect(hasEntry(path.join(home, "codegraph"))).toBe(false);
    }
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  }
});

test("el asset MCP coincide con el hash fijado y falla cerrado si el proxy gestionado cambia", () => {
  expect(createHash("sha256").update(fs.readFileSync(ASSET_PROXY)).digest("hex")).toBe(CODEGRAPH_PROXY_SHA256);
  fs.mkdirSync(path.dirname(codegraphProxy(paths)), { recursive: true });
  fs.copyFileSync(ASSET_PROXY, codegraphProxy(paths));
  expect(verifiedCodegraphProxy(paths)).toBe(codegraphProxy(paths));
  fs.appendFileSync(codegraphProxy(paths), "\n// altered fixture\n");
  expect(verifiedCodegraphProxy(paths)).toBeUndefined();
});
