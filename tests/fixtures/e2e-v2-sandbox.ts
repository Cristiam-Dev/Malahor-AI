import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runCodegraph } from "../../src/cli/commands/codegraph";
import { runMemory } from "../../src/cli/commands/memory";
import { indexCodegraph, statusCodegraph } from "../../src/cli/core/codegraph-index";
import {
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
interface HostHandle {
  child: ChildProcessWithoutNullStreams;
  url: string;
  secret: string;
  stop(): Promise<void>;
}

export interface V2SandboxReport {
  sandbox: {
    root: string;
    workspace: string;
    realDataTouched: boolean;
    networkDownloads: number;
    persistedCredentials: string[];
  };
  host: { real: boolean; kind: string; version: string };
  plugin: { loaded: boolean; criticalGaps: string[]; capabilities: Record<string, boolean> };
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
    host = await startHost(workspace, env);
    const runtime = await inspectRuntime(host, opencodeDir, malahorHome);
    const doctor = exerciseDoctor(workspace, env);
    const git = commit ? exerciseGit(workspace, env) : { performed: false, repository: workspace, pushes: 0 };
    const persistedCredentials = findSecret(root, host.secret);

    report = {
      sandbox: { root, workspace, realDataTouched: false, networkDownloads: 0, persistedCredentials },
      host: runtime.host,
      plugin: runtime.plugin,
      agents: runtime.agents,
      memory,
      codegraph,
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
  fs.writeFileSync(path.join(workspace, "src", "e2e-fixture.ts"),
    "export function malahorE2ESyntheticSymbol() { return 552; }\n", { mode: 0o600 });
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
    const expected = `https://github.com/grahambrooks/symgraph/releases/download/v${archive.version}/${archive.name}`;
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

async function inspectRuntime(host: HostHandle, opencodeDir: string, malahorHome: string): Promise<{
  host: V2SandboxReport["host"];
  plugin: V2SandboxReport["plugin"];
  agents: V2SandboxReport["agents"];
}> {
  const auth = `Basic ${Buffer.from(`opencode:${host.secret}`).toString("base64")}`;
  const headers = { Authorization: auth };
  const info = await fetchJson(new URL("/api/info", host.url), headers) as { version?: string };
  const endpoint = `/api/agent?location%5Bdirectory%5D=${encodeURIComponent(path.dirname(path.join(opencodeDir, "..")))}`;
  const payload = await fetchJson(new URL(endpoint, host.url), headers);
  const agents = normalizeAgents(payload);
  const stateFile = path.join(malahorHome, "plugin-state.json");
  await waitForFile(stateFile);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
    host?: string; criticalGaps?: string[]; capabilities?: Record<string, boolean>;
  };
  const primaryRuntime = requiredAgent(agents, "malahor");
  const diagnosticRuntime = requiredAgent(agents, "malahor-diagnostico");
  const testingRuntime = requiredAgent(agents, "malahor-testing");
  const primaryRules = parseAgentRules(path.join(opencodeDir, "agents", "malahor.md"));
  const diagnosticRules = parseAgentRules(path.join(opencodeDir, "agents", "malahor-diagnostico.md"));
  const testingRules = parseAgentRules(path.join(opencodeDir, "agents", "malahor-testing.md"));

  return {
    host: { real: true, kind: state.host ?? "unknown", version: String(info.version ?? "unknown") },
    plugin: { loaded: state.host === "v2", criticalGaps: state.criticalGaps ?? ["state-missing"], capabilities: state.capabilities ?? {} },
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

function normalizeAgents(payload: unknown): RuntimeAgent[] {
  const source = Array.isArray(payload)
    ? payload.map((item) => [undefined, item] as const)
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { agents?: unknown }).agents)
      ? ((payload as { agents: unknown[] }).agents.map((item) => [undefined, item] as const))
      : typeof payload === "object" && payload !== null
        ? Object.entries(payload)
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
