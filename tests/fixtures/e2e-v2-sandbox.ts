import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runCodegraph } from "../../src/cli/commands/codegraph";
import { runMemory } from "../../src/cli/commands/memory";
import { indexCodegraph, statusCodegraph } from "../../src/cli/core/codegraph-index";
import {
  CODEGRAPH_RELEASE,
  codegraphBinary,
  codegraphEnvironment,
  codegraphIndex,
  codegraphProxy,
  codegraphRuntime,
  verifiedCodegraphBinary,
  verifiedCodegraphProxy,
} from "../../src/cli/core/codegraph-runtime";
import { archiveFor } from "../../src/cli/core/codegraph-setup";
import { OPENCODE_SDK_PACKAGE, OPENCODE_SDK_PIN } from "../../src/cli/core/opencode-sdk";
import { resolvePaths } from "../../src/cli/core/paths";
import { contextForProject } from "../../src/mnemo/context";
import { dbPath, getObservation, saveDb, saveObservation, type MnemoDb } from "../../src/mnemo/db";
import { MemoryEngine } from "../../src/mnemo/engine";
import { applyMemoryMigration, previewMemoryMigration } from "../../src/mnemo/migration";
import { memoryLocation, memoryV2Paths } from "../../src/mnemo/storage";
import { callTool } from "../../src/mnemo/tools";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const TEMP_ROOT = "/tmp/opencode";
const CODEGRAPH_ARCHIVE = path.join(TEMP_ROOT, "symgraph-spike.tar.gz");
const COMMIT_MESSAGE = "🧪 test(e2e): valida sandbox v2";
const MUTATED_ENV = [
  "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "MALAHOR_HOME", "MALAHOR_CONFIG", "MALAHOR_OPENCODE_DIR", "MALAHOR_OPENCODE_DETECT",
  "MALAHOR_OPENCODE_BIN", "OPENCODE_CONFIG_CONTENT", "NO_COLOR",
] as const;

interface SandboxOptions { root?: string; commit?: boolean; keep?: boolean }
interface AgentRule { action: string; resource: string; effect: string }
interface RuntimeAgent { id: string; mode: string; hidden: boolean }
interface PersistedPluginDiagnostics {
  host?: string;
  criticalGaps?: string[];
  capabilities?: Record<string, boolean>;
}
interface RuntimePlugin { id: string; status: string; failureReference: boolean }
interface HostHandle {
  child: ChildProcessWithoutNullStreams;
  url: string;
  secret: string;
  diagnostics(): string;
  stop(): Promise<void>;
}

export interface V2SandboxReport {
  sandbox: {
    root: string;
    workspace: string;
    realDataTouched: boolean;
    networkDownloads: number;
    persistedCredentials: string[];
    nodeModules: { before: string; after: string; unchanged: boolean };
  };
  host: { real: boolean; kind: string; version: string };
  plugin: {
    loaded: boolean;
    live: { present: boolean; status: string; failureReference: boolean };
    inventory: RuntimePlugin[];
    persisted: { host: string; criticalGaps: string[]; capabilities: Record<string, boolean> };
  };
  agents: {
    primary: { id: string; mode: string; visible: boolean; subagent: { denyAll: boolean; allowPatterns: string[] } };
    specialists: Array<{ id: string; mode: string; subagentDenied: boolean }>;
    testingPermission: {
      fixture: { resource: string; matchedEffects: string[]; effect: string };
      production: { resource: string; matchedEffects: string[]; effect: string };
    };
  };
  memory: {
    preview: { wrote: boolean };
    migration: { state: string; backend: string; jsonHashBefore: string; jsonHashAfter: string };
    before: { observations: number; ids: number[]; sessions: string[] };
    after: { observations: number; ids: number[]; sessions: string[] };
    checks: { cli: boolean; context: boolean; mcp: boolean; fts: boolean };
    retry: { action: string; wrote: boolean };
    postMigrationWrite: { persisted: boolean; automaticRollbackBlocked: boolean };
  };
  codegraph: {
    setupManaged: boolean;
    indexManaged: boolean;
    indexPath: string;
    symbol: { synthetic: boolean; found: boolean; via: string; name: string };
    mcp: { readOnly: boolean; reindexWrites: number };
  };
  codeMode: {
    result: { fileCount: number; matchCount: number; hasSymbol: boolean };
    internalCalls: Array<{ tool: string; status: string }>;
    permissionCalls: number;
    permissionsPersisted: boolean;
    auditedCalls: number;
  };
  economy: {
    baseline: { modelRounds: number; outerCalls: number; schemaBytes: number; intermediateBytes: number; estimatedTokens: number };
    codeMode: { modelRounds: number; outerCalls: number; schemaBytes: number; intermediateBytes: number; estimatedTokens: number };
    intermediateReductionPercent: number;
    equivalentResult: boolean;
    realTokens: { available: boolean; baseline: number | null; codeMode: number | null; savingsClaimed: boolean };
  };
  git: { performed: boolean; repository: string; pushes: number; message?: string; head?: string; clean?: boolean };
  doctor: { ready: boolean; fails: number; warnings: number };
  reportPath: string;
  cleanup: { processesRemaining: number; environmentRestored: boolean; rootPreserved: boolean };
}

export async function runV2SandboxE2E(options: SandboxOptions = {}): Promise<V2SandboxReport> {
  const keep = options.keep === true;
  const commit = options.commit === true;
  const root = prepareRoot(options.root);
  const workspace = path.join(root, "workspace");
  const malahorHome = path.join(root, "malahor-home");
  const xdgConfig = path.join(root, "xdg", "config");
  const opencodeDir = path.join(xdgConfig, "opencode");
  const previousEnv = snapshotEnvironment();
  const env = sandboxEnvironment(root, malahorHome, xdgConfig, opencodeDir);
  const nodeModulesBefore = fingerprintTree(path.join(REPO_ROOT, "node_modules"));
  let host: HostHandle | undefined;
  let report: V2SandboxReport | undefined;
  let failure: unknown;

  try {
    copyPackage(workspace);
    applyEnvironment(env);
    writeInitialConfig(malahorHome);
    seedOpenCodeSdk(opencodeDir);
    run("node", [path.join(workspace, "dist", "index.js"), "install", "--yes"], workspace, env);
    const project = enableCodegraphProject(malahorHome, workspace);
    const memory = await exerciseMemory(malahorHome);
    const codegraph = await exerciseCodegraph(root, workspace, malahorHome, project);
    const { codeMode, economy } = exerciseCodeMode(root, workspace, malahorHome, project, env);
    host = await startHost(workspace, env);
    const runtime = await inspectRuntime(host, workspace, opencodeDir, malahorHome);
    let doctor: V2SandboxReport["doctor"];
    try {
      doctor = exerciseDoctor(workspace, env);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nHost stderr:\n${host.diagnostics()}`);
    }
    const git = commit ? exerciseGit(workspace, env) : { performed: false, repository: workspace, pushes: 0 };
    const persistedCredentials = findSecret(root, host.secret);

    report = {
      sandbox: {
        root,
        workspace,
        realDataTouched: false,
        networkDownloads: 0,
        persistedCredentials,
        nodeModules: { before: nodeModulesBefore, after: "", unchanged: false },
      },
      host: runtime.host,
      plugin: runtime.plugin,
      agents: runtime.agents,
      memory,
      codegraph,
      codeMode,
      economy,
      git,
      doctor,
      reportPath: "",
      cleanup: { processesRemaining: 0, environmentRestored: false, rootPreserved: keep },
    };
  } catch (error) {
    failure = error;
  } finally {
    if (host) await host.stop();
    restoreEnvironment(previousEnv);
  }

  if (failure) {
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
    throw failure;
  }
  if (!report) throw new Error("El E2E no produjo reporte.");

  report.sandbox.nodeModules.after = fingerprintTree(path.join(REPO_ROOT, "node_modules"));
  report.sandbox.nodeModules.unchanged = report.sandbox.nodeModules.after === report.sandbox.nodeModules.before;
  report.cleanup.environmentRestored = environmentMatches(previousEnv);
  const reportPath = keep
    ? path.join(root, "report.json")
    : path.join(TEMP_ROOT, `${path.basename(root)}-report.json`);
  report.reportPath = reportPath;
  writeJson(reportPath, report, 0o600);
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  return report;
}

function prepareRoot(explicit: string | undefined): string {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  if (!explicit) return fs.mkdtempSync(path.join(TEMP_ROOT, "malahor-e2e-v2-"));
  const root = path.resolve(explicit);
  assertWithin(TEMP_ROOT, root);
  if (root === path.resolve(TEMP_ROOT)) throw new Error("La raiz E2E no puede ser /tmp/opencode.");
  if (fs.existsSync(root)) throw new Error(`La raiz E2E ya existe: ${root}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function copyPackage(workspace: string): void {
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true, mode: 0o700 });
  for (const directory of ["assets", "dist"]) {
    const source = path.join(REPO_ROOT, directory);
    if (!fs.existsSync(source)) throw new Error(`Falta ${directory}; ejecuta bun run build antes del E2E.`);
    fs.cpSync(source, path.join(workspace, directory), { recursive: true });
  }
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(workspace, "package.json"));
  const fixture = [
    "export function malahorE2ESyntheticSymbol() { return 552; }",
    ...Array.from({ length: 320 }, (_value, index) => `export const syntheticEconomyLine${index} = "fixture-${index.toString().padStart(3, "0")}";`),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(workspace, "src", "e2e-fixture.ts"), fixture, { mode: 0o600 });
}

function sandboxEnvironment(root: string, malahorHome: string, xdgConfig: string, opencodeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: path.join(root, "user"),
    USERPROFILE: path.join(root, "user"),
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: path.join(root, "xdg", "data"),
    XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
    XDG_STATE_HOME: path.join(root, "xdg", "state"),
    MALAHOR_HOME: malahorHome,
    MALAHOR_CONFIG: path.join(malahorHome, "config.jsonc"),
    MALAHOR_OPENCODE_DIR: opencodeDir,
    MALAHOR_OPENCODE_DETECT: "0",
    MALAHOR_OPENCODE_BIN: "opencode",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }),
    NO_COLOR: "1",
  };
  for (const directory of [env.HOME!, xdgConfig, env.XDG_DATA_HOME!, env.XDG_CACHE_HOME!, env.XDG_STATE_HOME!]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return env;
}

function writeInitialConfig(malahorHome: string): void {
  fs.mkdirSync(malahorHome, { recursive: true, mode: 0o700 });
  writeJson(path.join(malahorHome, "config.jsonc"), {
    execution: { intervention: "ejecutar", verification: true },
    projects: { aliases: { malahor: ["malahor-ai"], acme: ["Acme Legacy"] } },
  }, 0o600);
}

function seedOpenCodeSdk(opencodeDir: string): void {
  writeJson(path.join(opencodeDir, "opencode.jsonc"), { update: "disable" });
  writeJson(path.join(opencodeDir, "package.json"), { dependencies: { [OPENCODE_SDK_PACKAGE]: OPENCODE_SDK_PIN } });
  const packagePath = path.join(opencodeDir, "node_modules", ...OPENCODE_SDK_PACKAGE.split("/"), "package.json");
  writeJson(packagePath, { name: OPENCODE_SDK_PACKAGE, version: OPENCODE_SDK_PIN });
}

function enableCodegraphProject(malahorHome: string, workspace: string): string {
  const file = path.join(malahorHome, "projects.json");
  const registry = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, {
    context?: string; roots?: string[]; defaultRoot?: string;
  }>;
  const project = Object.entries(registry).find(([, value]) =>
    value.roots?.some((root) => path.resolve(root) === path.resolve(workspace)))?.[0] ?? Object.keys(registry)[0];
  if (!project) throw new Error("La instalacion no registro el proyecto sandbox.");
  registry[project] = { ...registry[project], context: "memory+codegraph", roots: [workspace], defaultRoot: workspace };
  writeJson(file, registry, 0o600);
  return project;
}

async function exerciseMemory(malahorHome: string): Promise<V2SandboxReport["memory"]> {
  const source = dbPath();
  const fixture = memoryFixture();
  saveDb(fixture);
  const jsonHashBefore = sha256(source);
  const paths = memoryV2Paths(source);
  const memoryExisted = fs.existsSync(paths.directory);
  const preview = previewMemoryMigration({ source, aliases: { acme: ["Acme Legacy"] } });
  const previewWrote = sha256(source) !== jsonHashBefore || fs.existsSync(paths.directory) !== memoryExisted;
  if (!preview.confirmation) throw new Error(`Preview de memoria bloqueado: ${preview.issue ?? preview.state}`);
  applyMemoryMigration(preview.confirmation, { source, aliases: { acme: ["Acme Legacy"] } });
  const jsonHashAfter = sha256(source);
  const before = memorySummary(fixture);
  const engine = MemoryEngine.open(paths.database);
  let after: ReturnType<typeof memorySummary>;
  let fts = false;
  try {
    const snapshot = engine.snapshot();
    after = memorySummary(snapshot);
    fts = engine.search({ scope: "acme/store", mode: "subtree", match: "fts", query: "Legacy" }).length > 0;
  } finally { engine.close(); }

  const cliOutput = (await captureStdout(() => runMemory({
    action: "search", args: ["Legacy"], all: false, confirm: undefined, dryRun: false, yes: false,
    project: "acme/store", subtree: true,
  }))).output;
  const context = contextForProject("acme/store", 20);
  const mcp = callTool({ name: "mem_context", arguments: { project: "acme/store", limit: 20 } }) as {
    observations: Array<{ id: number }>;
  };
  const saved = saveObservation({ project: "acme/store", type: "learning", title: "Posterior E2E",
    content: "Debe sobrevivir al intento de rollback", tags: "e2e" });
  const databaseHash = sha256(paths.database);
  const active = previewMemoryMigration({ source, aliases: { acme: ["Acme Legacy"] } });
  const retry = applyMemoryMigration("ignored", { source, aliases: { acme: ["Acme Legacy"] } });

  return {
    preview: { wrote: previewWrote },
    migration: { state: "active", backend: memoryLocation(source).backend, jsonHashBefore, jsonHashAfter },
    before,
    after,
    checks: {
      cli: cliOutput.includes("Legacy"),
      context: context.observations.some((item) => item.id === 9),
      mcp: mcp.observations.some((item) => item.id === 9),
      fts,
    },
    retry: { action: retry.applied || retry.resumed ? "write" : "no-op", wrote: sha256(paths.database) !== databaseHash },
    postMigrationWrite: {
      persisted: getObservation(saved.id)?.title === "Posterior E2E",
      automaticRollbackBlocked: active.state === "active" && active.postMigrationChanges === true
        && active.rollbackAutomatic === false,
    },
  };
}

async function exerciseCodegraph(root: string, workspace: string, malahorHome: string,
  project: string): Promise<V2SandboxReport["codegraph"]> {
  const archive = archiveFor();
  if (!archive || !fs.existsSync(CODEGRAPH_ARCHIVE)) throw new Error("Archive CodeGraph sandbox no disponible.");
  const bytes = fs.readFileSync(CODEGRAPH_ARCHIVE);
  if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256) {
    throw new Error("Hash del archive CodeGraph sandbox invalido.");
  }
  const paths = resolvePaths(process.env, workspace);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const expected = `https://github.com/grahambrooks/symgraph/releases/download/${CODEGRAPH_RELEASE}/${archive.name}`;
    if (String(input) !== expected) throw new Error(`Acceso de red no autorizado: ${String(input)}`);
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
  try {
    await captureStdout(() => runCodegraph({ action: "setup", project, dryRun: false, confirm: "INSTALL_SYMGRAPH" }));
    await captureStdout(() => runCodegraph({ action: "index", project, dryRun: false, confirm: `INDEX_SYMGRAPH:${project}` }));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const index = codegraphIndex(paths, workspace);
  const status = JSON.parse(statusCodegraph(paths, project, workspace)) as { total_files?: number; total_nodes?: number };
  const digest = sha256(index.database);
  const responses = proxyRequests(paths, project, workspace, malahorHome, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "symgraph-search", arguments: { query: "malahorE2ESyntheticSymbol" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "symgraph-reindex", arguments: {} } },
  ]);
  const tools = ((responses.get(2)?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((tool) => tool.name);
  const searchText = JSON.stringify(responses.get(3)?.result ?? responses.get(3)?.error ?? {});
  const reindexDenied = responses.get(4)?.error !== undefined;
  const runtime = codegraphRuntime(paths, project, workspace);
  assertWithin(root, index.database);
  if (isWithin(workspace, index.database)) throw new Error("CodeGraph escribio el indice dentro del workspace.");

  return {
    setupManaged: Boolean(verifiedCodegraphBinary(paths) && verifiedCodegraphProxy(paths)),
    indexManaged: Boolean(runtime && (status.total_files ?? 0) > 0 && (status.total_nodes ?? 0) > 0),
    indexPath: index.database,
    symbol: { synthetic: true, found: searchText.includes("malahorE2ESyntheticSymbol"), via: "mcp", name: "malahorE2ESyntheticSymbol" },
    mcp: { readOnly: !tools.includes("symgraph-reindex") && reindexDenied, reindexWrites: sha256(index.database) === digest ? 0 : 1 },
  };
}

function exerciseCodeMode(
  root: string,
  workspace: string,
  malahorHome: string,
  project: string,
  env: NodeJS.ProcessEnv,
): Pick<V2SandboxReport, "codeMode" | "economy"> {
  const bundle = path.join(workspace, "assets", "opencode", "plugins", "malahor", "index.ts");
  const instrumented = path.join(root, "code-mode", "malahor-bundle-api.mjs");
  const runner = path.join(root, "code-mode", "exercise.mjs");
  fs.mkdirSync(path.dirname(instrumented), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    instrumented,
    `${fs.readFileSync(bundle, "utf8")}\nexport { registerReadOnlyCodeModeTools };\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.writeFileSync(runner, codeModeE2ESource(pathToFileURL(instrumented).href), { encoding: "utf8", mode: 0o600 });
  const execution = spawnSync("node", ["--no-warnings", runner, workspace, malahorHome, project], {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (execution.error) throw execution.error;
  if (execution.status !== 0) throw new Error(`Code Mode E2E fallo (${execution.status}): ${execution.stderr}`);
  return JSON.parse(execution.stdout) as Pick<V2SandboxReport, "codeMode" | "economy">;
}

function codeModeE2ESource(moduleURL: string): string {
  return `
    import fs from "node:fs";
    import path from "node:path";
    const { registerReadOnlyCodeModeTools } = await import(${JSON.stringify(moduleURL)});
    const [workspace, malahorHome, project] = process.argv.slice(2);
    const fixturePath = path.join(workspace, "src", "e2e-fixture.ts");
    const fixtureContent = fs.readFileSync(fixturePath, "utf8");
    const definitions = new Map();
    const added = new Map();
    const permissions = [];
    const input = (name) => ({
      type: "object",
      properties: name === "read"
        ? { path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 2000 } }
        : name === "glob"
          ? { pattern: { type: "string" }, path: { type: "string" }, hidden: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 100 } }
          : { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" }, literal: { type: "boolean" }, caseSensitive: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 100 } },
      required: [name === "read" ? "path" : "pattern"],
      additionalProperties: false,
    });
    const grepOutput = {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, preview: { type: "string" } },
        required: ["path", "line", "preview"],
        additionalProperties: false,
      },
    };
    for (const name of ["read", "glob", "grep"]) {
      definitions.set(name, {
        id: name,
        name,
        description: \`Host \${name} E2E sintético\`,
        input: input(name),
        output: name === "read" ? { type: "string" }
          : name === "glob" ? { type: "array", items: { type: "string" } } : grepOutput,
        options: { permission: name, codemode: false },
        execute: () => name === "read" ? fixtureContent
          : name === "glob" ? [fixturePath]
            : [{ path: fixturePath, line: 1, preview: "malahorE2ESyntheticSymbol" }],
      });
    }
    const projectDefinition = (definition) => {
      const execute = definition.execute;
      return {
        ...definition,
        options: { ...definition.options },
        execute: (input, call) => execute(input, call),
      };
    };
    const listDefinitions = () => [...definitions.values()].map(projectDefinition);
    const getDefinition = (name) => {
      const definition = definitions.get(name);
      return definition ? projectDefinition(definition) : undefined;
    };
    const domain = {
      list: async () => listDefinitions(),
      transform: async (callback) => {
        callback({
          list: listDefinitions,
          get: getDefinition,
          namespace: () => undefined,
          add: (value) => added.set(String(value.name), value),
        });
        return { dispose: () => undefined };
      },
    };
    let ref = 0;
    const registration = await registerReadOnlyCodeModeTools(
      domain,
      { assert: async (request) => { permissions.push(structuredClone(request)); } },
      {},
      {
        cwd: workspace,
        env: process.env,
        permissionRegistered: true,
        toolRegistered: true,
        resolveSessionProject: async () => ({ canonicalKey: project, root: workspace }),
      },
      {
        moduleURL: ${JSON.stringify(moduleURL)},
        randomRef: (prefix) => \`\${prefix}_\${String(++ref).padStart(20, "0")}\`,
      },
    );
    try {
      const call = { sessionID: "ses_e2e_a4", agent: "malahor", messageID: "msg_e2e_a4", id: "call_search" };
      const search = await added.get("code_search").execute({ query: "read glob grep" }, call);
      const discovered = JSON.parse(search.content);
      const code = [
        "const files = await tools.repo.glob({ pattern: 'src/*.ts', path: '.', limit: 10 });",
        "const matches = await tools.repo.grep({ pattern: 'malahorE2ESyntheticSymbol', path: 'src', include: '*.ts', literal: true, caseSensitive: true, limit: 10 });",
        "const content = await tools.repo.read({ path: 'src/e2e-fixture.ts', offset: 0, limit: 2000 });",
        "return { fileCount: files.length, matchCount: matches.length, hasSymbol: content.includes('malahorE2ESyntheticSymbol') };",
      ].join(" ");
      const execute = await added.get("code_execute").execute(
        { catalogRef: discovered.catalogRef, code },
        { ...call, id: "call_execute" },
      );
      const parsed = JSON.parse(execute.content);
      if (parsed.ok !== true) throw new Error(\`Code Mode E2E denegado: \${execute.content}\`);

      const baselineOutputs = [
        ["src/e2e-fixture.ts"],
        [{ path: "src/e2e-fixture.ts", line: 1, preview: "malahorE2ESyntheticSymbol" }],
        fixtureContent,
      ];
      const expected = { fileCount: 1, matchCount: 1, hasSymbol: true };
      const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
      const baselineSchema = [...definitions.values()].map(({ execute: _execute, ...definition }) => definition);
      const codeModeSchema = [...added.values()].map(({ execute: _execute, ...definition }) => definition);
      const baseline = {
        modelRounds: 3,
        outerCalls: 3,
        schemaBytes: bytes(baselineSchema),
        intermediateBytes: baselineOutputs.reduce((total, value) => total + bytes(value), 0),
      };
      const composed = {
        modelRounds: 2,
        outerCalls: 2,
        schemaBytes: bytes(codeModeSchema),
        intermediateBytes: bytes(search.content) + bytes(execute.content),
      };
      const auditFile = path.join(malahorHome, "audit", "security.jsonl");
      const audit = fs.readFileSync(auditFile, "utf8").trim().split("\\n").filter(Boolean)
        .map((line) => JSON.parse(line)).filter((entry) => entry.kind === "code-mode" && entry.phase === "call.after");
      const equivalentResult = JSON.stringify(parsed.value) === JSON.stringify(expected);
      process.stdout.write(JSON.stringify({
        codeMode: {
          result: parsed.value,
          internalCalls: parsed.calls,
          permissionCalls: permissions.length,
          permissionsPersisted: permissions.some((request) => Array.isArray(request.save) && request.save.length > 0),
          auditedCalls: audit.length,
        },
        economy: {
          baseline: { ...baseline, estimatedTokens: Math.ceil((baseline.schemaBytes + baseline.intermediateBytes) / 4) },
          codeMode: { ...composed, estimatedTokens: Math.ceil((composed.schemaBytes + composed.intermediateBytes) / 4) },
          intermediateReductionPercent: Math.round((1 - composed.intermediateBytes / baseline.intermediateBytes) * 10000) / 100,
          equivalentResult,
          realTokens: { available: false, baseline: null, codeMode: null, savingsClaimed: false },
        },
      }));
    } finally {
      await registration.dispose?.();
    }
  `;
}

async function startHost(workspace: string, env: NodeJS.ProcessEnv): Promise<HostHandle> {
  const secret = randomBytes(32).toString("hex");
  const child = spawn("opencode", ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workspace,
    env: { ...env, OPENCODE_SERVER_PASSWORD: secret },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout al iniciar OpenCode: ${stderr}`)), 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`OpenCode termino antes de iniciar: ${stderr}`)); });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  let stopped = false;
  return {
    child,
    url,
    secret,
    diagnostics: () => stderr,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      child.stdin.end();
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

async function inspectRuntime(host: HostHandle, workspace: string, opencodeDir: string, malahorHome: string): Promise<{
  host: V2SandboxReport["host"];
  plugin: V2SandboxReport["plugin"];
  agents: V2SandboxReport["agents"];
}> {
  const auth = `Basic ${Buffer.from(`opencode:${host.secret}`).toString("base64")}`;
  const headers = { Authorization: auth };
  const info = await fetchJson(new URL("/api/info", host.url), headers) as { version?: string };
  const version = String(info.version ?? "unknown");
  const location = `location%5Bdirectory%5D=${encodeURIComponent(workspace)}`;
  const endpoint = `/api/agent?${location}`;
  const payload = await fetchJson(new URL(endpoint, host.url), headers);
  const agents = normalizeAgents(payload);
  const stateFile = path.join(malahorHome, "plugin-state.json");
  await waitForFile(stateFile);
  const plugin = await waitForStablePluginEvidence(
    new URL(`/api/plugin?${location}`, host.url),
    stateFile,
    headers,
  );
  const primaryRuntime = requiredAgent(agents, "malahor");
  const diagnosticRuntime = requiredAgent(agents, "malahor-diagnostico");
  const testingRuntime = requiredAgent(agents, "malahor-testing");
  const primaryRules = parseAgentRules(path.join(opencodeDir, "agents", "malahor.md"));
  const diagnosticRules = parseAgentRules(path.join(opencodeDir, "agents", "malahor-diagnostico.md"));
  const testingRules = parseAgentRules(path.join(opencodeDir, "agents", "malahor-testing.md"));

  return {
    host: { real: true, kind: hostKindFromVersion(version), version },
    plugin,
    agents: {
      primary: {
        id: primaryRuntime.id,
        mode: primaryRuntime.mode,
        visible: !primaryRuntime.hidden,
        subagent: {
          denyAll: primaryRules.some((rule) => rule.action === "subagent" && rule.resource === "*" && rule.effect === "deny"),
          allowPatterns: primaryRules.filter((rule) => rule.action === "subagent" && rule.effect === "allow").map((rule) => rule.resource),
        },
      },
      specialists: [diagnosticRuntime, testingRuntime].map((agent) => ({
        id: agent.id,
        mode: agent.mode,
        subagentDenied: (agent.id === "malahor-testing" ? testingRules : diagnosticRules)
          .some((rule) => rule.action === "subagent" && rule.resource === "*" && rule.effect === "deny"),
      })),
      testingPermission: {
        fixture: permissionDecision(testingRules, "edit", "tests/fixtures/e2e-probe.ts"),
        production: permissionDecision(testingRules, "edit", "src/e2e-probe.ts"),
      },
    },
  };
}

function exerciseDoctor(workspace: string, env: NodeJS.ProcessEnv): V2SandboxReport["doctor"] {
  const output = run("node", [path.join(workspace, "dist", "index.js"), "doctor"], workspace, env);
  const fails = output.match(/^FAIL /gm)?.length ?? 0;
  const warnings = output.match(/^WARN /gm)?.length ?? 0;
  return { ready: output.includes("Status: ready") && fails === 0 && warnings === 0, fails, warnings };
}

function exerciseGit(workspace: string, env: NodeJS.ProcessEnv): V2SandboxReport["git"] {
  run("git", ["init"], workspace, env);
  fs.appendFileSync(path.join(workspace, ".git", "info", "exclude"), "\nassets/\ndist/\nsrc/\npackage.json\n", "utf8");
  run("git", ["config", "user.name", "Malahor E2E"], workspace, env);
  run("git", ["config", "user.email", "e2e@invalid.local"], workspace, env);
  const target = path.join(workspace, "CHANGELOG.e2e.md");
  fs.writeFileSync(target, "# T-5.5.2\n\nValidacion sintetica V2.\n", { mode: 0o600 });
  run("node", [path.join(workspace, "dist", "index.js"), "hooks", "check", "file.stage.before",
    "--command", "git add CHANGELOG.e2e.md", "--paths", target, "--confirm", "USER_REQUESTED_STAGE", "--json"], workspace, env);
  run("git", ["add", "CHANGELOG.e2e.md"], workspace, env);
  const precommit = run("node", [path.join(workspace, "dist", "index.js"), "git", "precommit",
    "--message", COMMIT_MESSAGE, "--profile", "release", "--json"], workspace, env);
  if (!precommit.includes('"decision": "allow"')) throw new Error(`Precommit sandbox no permitido: ${precommit}`);
  const command = `git commit -m "${COMMIT_MESSAGE}" -m "- Verifica el flujo Git aislado de T-5.5.2."`;
  run("node", [path.join(workspace, "dist", "index.js"), "hooks", "check", "git.commit.before",
    "--command", command, "--paths", target, "--confirm", "USER_REQUESTED_COMMIT", "--profile", "release", "--json"], workspace, env);
  run("git", ["commit", "-m", COMMIT_MESSAGE, "-m", "- Verifica el flujo Git aislado de T-5.5.2."], workspace, env);
  const head = run("git", ["rev-parse", "HEAD"], workspace, env).trim();
  const message = run("git", ["log", "-1", "--format=%s"], workspace, env).trim();
  const clean = run("git", ["status", "--short"], workspace, env).trim() === "";
  const pushes = run("git", ["remote"], workspace, env).trim() === "" ? 0 : 1;
  return { performed: true, repository: workspace, pushes, message, head, clean };
}

function memoryFixture(): MnemoDb {
  return {
    observations: [
      { id: 9, project: "Acme Legacy/Store", type: "decision", title: "Legacy E2E", content: "Preservar", tags: "e2e", created_at: "2026-10-01T10:00:00.000Z" },
      { id: 2, project: "global", type: "general", title: "Global E2E", content: "Herencia", tags: "e2e", created_at: "2026-10-01T10:00:00.000Z" },
      { id: 15, project: "acme/store", type: "general", title: "Canonico E2E", content: "FTS Legacy", tags: "e2e", created_at: "2026-10-01T10:00:00.000Z" },
    ],
    sessions: [
      { project: "Acme Legacy/Store", summary: "Sesion repetida", created_at: "2026-10-01T10:00:00.000Z" },
      { project: "Acme Legacy/Store", summary: "Sesion repetida", created_at: "2026-10-01T10:00:00.000Z" },
      { project: "acme/store", summary: "Sesion canonica", created_at: "2026-10-01T10:00:00.000Z" },
    ],
    nextId: 40,
  };
}

function memorySummary(db: MnemoDb): { observations: number; ids: number[]; sessions: string[] } {
  return {
    observations: db.observations.length,
    ids: db.observations.map((item) => item.id),
    sessions: db.sessions.map((item) => item.summary),
  };
}

function parseAgentRules(file: string): AgentRule[] {
  const content = fs.readFileSync(file, "utf8");
  const rules: AgentRule[] = [];
  const pattern = /- action:\s*([^\n]+)\n\s+resource:\s*"([^"]+)"\n\s+effect:\s*([^\n]+)/g;
  for (const match of content.matchAll(pattern)) {
    rules.push({ action: match[1]!.trim(), resource: match[2]!, effect: match[3]!.trim() });
  }
  return rules;
}

function permissionDecision(rules: AgentRule[], action: string, resource: string) {
  const matched = rules.filter((rule) => wildcard(rule.action, action) && wildcard(rule.resource, resource));
  return { resource, matchedEffects: matched.map((rule) => rule.effect), effect: matched.at(-1)?.effect ?? "ask" };
}

function wildcard(pattern: string, value: string): boolean {
  const expression = [...pattern].map((character) => {
    if (character === "*") return ".*";
    if (character === "?") return ".";
    return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
  }).join("");
  return new RegExp(`^${expression}$`).test(value);
}

export function pluginReportFromEvidence(
  inventoryPayload: unknown,
  state: PersistedPluginDiagnostics,
): V2SandboxReport["plugin"] {
  const inventory = normalizePluginInventory(inventoryPayload);
  const matching = inventory.filter((plugin) => plugin.id === "malahor");
  const runtime = matching.length === 1 ? matching[0] : undefined;
  const live = {
    present: matching.length > 0,
    status: matching.length > 1 ? "duplicate" : runtime?.status ?? "missing",
    failureReference: matching.length > 1 || runtime?.failureReference === true,
  };
  return {
    loaded: live.present && live.status === "active" && !live.failureReference,
    live,
    inventory: matching,
    persisted: {
      host: state.host ?? "unknown",
      criticalGaps: state.criticalGaps ?? ["state-missing"],
      capabilities: state.capabilities ?? {},
    },
  };
}

function normalizePluginInventory(payload: unknown): RuntimePlugin[] {
  let normalized = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isObjectRecord(normalized)) break;
    if (Object.hasOwn(normalized, "data")) {
      normalized = normalized.data;
      continue;
    }
    if (Object.hasOwn(normalized, "plugins")) {
      normalized = normalized.plugins;
      continue;
    }
    break;
  }
  const source: Array<readonly [string | undefined, unknown]> = Array.isArray(normalized)
    ? normalized.map((item) => [undefined, item] as const)
    : isObjectRecord(normalized) && looksLikePluginEntry(normalized)
      ? [[undefined, normalized] as const]
      : isObjectRecord(normalized)
        ? Object.entries(normalized)
        : [];
  return source.flatMap(([key, value]) => {
    if (!isObjectRecord(value)) return [];
    const embedded = isObjectRecord(value.plugin) ? value.plugin : undefined;
    const candidate = value.id ?? value.name ?? embedded?.id ?? embedded?.name
      ?? (typeof value.plugin === "string" ? value.plugin : key);
    if (typeof candidate !== "string" || !candidate || candidate.length > 256
      || /[\u0000-\u001f\u007f-\u009f]/.test(candidate)) return [];
    const id = candidate;
    const state = isObjectRecord(value.state) ? value.state : undefined;
    const status = state?.status === "active" || state?.status === "failed" ? state.status : "invalid";
    const failureReference = [
      state?.failure,
      state?.error,
      state?.reason,
      state?.ref,
      state?.failureRef,
      state?.failureReference,
      value.failure,
      value.error,
      value.reason,
      value.ref,
      value.failureRef,
      value.failureReference,
    ].some(hasMeaningfulFailureReference) || status === "invalid";
    return [{ id, status, failureReference }];
  });
}

async function waitForStablePluginEvidence(
  endpoint: URL,
  stateFile: string,
  headers: Record<string, string>,
): Promise<V2SandboxReport["plugin"]> {
  const deadline = Date.now() + 10_000;
  let previous = "";
  let stableObservations = 0;
  let latest: V2SandboxReport["plugin"] | undefined;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as PersistedPluginDiagnostics;
      const inventory = await fetchJson(endpoint, headers);
      latest = pluginReportFromEvidence(inventory, state);
      const evidence = JSON.stringify(latest);
      stableObservations = evidence === previous ? stableObservations + 1 : 1;
      previous = evidence;
      if (latest.live.present && stableObservations >= 5) return latest;
    } catch {
      stableObservations = 0;
      previous = "";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const finalState = latest?.live.status ?? "sin-evidencia";
  throw new Error(`No se obtuvo evidencia estable del inventario vivo de plugins (estado final: ${finalState}).`);
}

function looksLikePluginEntry(value: Record<string, unknown>): boolean {
  return ["id", "name", "plugin", "state", "status"].some((key) => Object.hasOwn(value, key));
}

function hasMeaningfulFailureReference(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostKindFromVersion(version: string): string {
  if (/^2\./.test(version)) return "v2";
  if (/^1\./.test(version)) return "v1";
  return "unknown";
}

function normalizeAgents(payload: unknown): RuntimeAgent[] {
  const normalized = typeof payload === "object" && payload !== null
    && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : payload;
  const source = Array.isArray(normalized)
    ? normalized.map((item) => [undefined, item] as const)
    : typeof normalized === "object" && normalized !== null && Array.isArray((normalized as { agents?: unknown }).agents)
      ? ((normalized as { agents: unknown[] }).agents.map((item) => [undefined, item] as const))
      : typeof normalized === "object" && normalized !== null
        ? Object.entries(normalized)
        : [];
  return source.flatMap(([key, value]) => {
    if (typeof value !== "object" || value === null) return [];
    const item = value as Record<string, unknown>;
    const id = String(item.id ?? item.name ?? key ?? "");
    if (!id) return [];
    return [{ id, mode: String(item.mode ?? "unknown"), hidden: item.hidden === true }];
  });
}

function requiredAgent(agents: RuntimeAgent[], id: string): RuntimeAgent {
  const found = agents.find((agent) => agent.id === id);
  if (!found) throw new Error(`El host V2 no expuso el agente ${id}: ${agents.map((agent) => agent.id).join(", ")}`);
  return found;
}

function proxyRequests(paths: ReturnType<typeof resolvePaths>, project: string, workspace: string, malahorHome: string,
  requests: Array<Record<string, unknown>>): Map<number, { id: number; result?: unknown; error?: unknown }> {
  const index = codegraphIndex(paths, workspace);
  const result = spawnSync("node", [codegraphProxy(paths), codegraphBinary(paths), workspace, index.database,
    project, paths.projectsFile, malahorHome], {
    cwd: workspace,
    env: codegraphEnvironment(workspace, index.database, { PATH: process.env.PATH }),
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Proxy CodeGraph fallo: ${result.stderr}`);
  const responses = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return new Map(responses.map((response) => [response.id, response]));
}

async function fetchJson(url: URL, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Host HTTP ${response.status}: ${url.pathname}`);
  return response.json();
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout esperando ${file}`);
}

async function captureStdout<T>(callback: () => T | Promise<T>): Promise<{ value: T; output: string }> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
  try { return { value: await callback(), output }; } finally { process.stdout.write = original; }
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} fallo (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function writeJson(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fingerprintTree(directory: string): string {
  if (!fs.existsSync(directory)) throw new Error(`No existe el árbol a verificar: ${directory}`);
  const digest = createHash("sha256");
  const visit = (current: string): void => {
    const relative = path.relative(directory, current).replaceAll("\\", "/") || ".";
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      digest.update(`L\0${relative}\0${fs.readlinkSync(current)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      digest.update(`D\0${relative}\0`);
      for (const entry of fs.readdirSync(current).sort()) visit(path.join(current, entry));
      return;
    }
    if (stat.isFile()) {
      digest.update(`F\0${relative}\0${stat.size}\0`);
      digest.update(fs.readFileSync(current));
      return;
    }
    digest.update(`O\0${relative}\0${stat.mode}\0`);
  };
  visit(directory);
  return digest.digest("hex");
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertWithin(parent: string, candidate: string): void {
  if (!isWithin(parent, candidate)) throw new Error(`Ruta fuera del sandbox: ${candidate}`);
}

function findSecret(root: string, secret: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && fs.statSync(target).size <= 5 * 1024 * 1024
        && fs.readFileSync(target).includes(Buffer.from(secret))) found.push(path.relative(root, target));
    }
  };
  visit(root);
  return found;
}

function snapshotEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(MUTATED_ENV.map((key) => [key, process.env[key]]));
}

function applyEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of MUTATED_ENV) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const key of MUTATED_ENV) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function environmentMatches(snapshot: Record<string, string | undefined>): boolean {
  return MUTATED_ENV.every((key) => process.env[key] === snapshot[key]);
}
