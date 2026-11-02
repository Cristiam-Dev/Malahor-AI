import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { HorielCore } from "../../src/horiel/core";
import { createHorielCore } from "../../src/horiel/core";
import {
  FakeHorielStore,
  deterministicClock,
  deterministicIdFactory,
} from "./horiel-store";

export const HORIEL_P4_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const HORIEL_P4_SANDBOX_ROOT = path.join(
  HORIEL_P4_REPOSITORY_ROOT,
  ".sandbox",
  "horiel-p4",
);

export const SYNTHETIC_MEMORY_ID = `mem_${"1".repeat(32)}`;
export const SYNTHETIC_SECOND_MEMORY_ID = `mem_${"2".repeat(32)}`;
export const SYNTHETIC_PREVIEW_ID = `prv_${"3".repeat(32)}`;
export const SYNTHETIC_SNAPSHOT_ID = `snp_${"4".repeat(32)}`;
export const SYNTHETIC_STORE_ID = `store_${"5".repeat(32)}`;
export const SYNTHETIC_SECRET = "synthetic-secret-value-123456789";

export const HORIEL_TOOL_NAMES = [
  "memory_backup",
  "memory_brief",
  "memory_context",
  "memory_delete_project",
  "memory_delete_project_preview",
  "memory_get",
  "memory_inspect_project",
  "memory_link",
  "memory_list_projects",
  "memory_move",
  "memory_move_preview",
  "memory_pin",
  "memory_promote",
  "memory_promote_preview",
  "memory_restore",
  "memory_restore_preview",
  "memory_save",
  "memory_search",
  "memory_session_summary",
  "memory_tree",
  "memory_unlink",
  "memory_unpin",
  "memory_update",
] as const;

export type HorielToolName = typeof HORIEL_TOOL_NAMES[number];

export interface HorielP4Sandbox {
  suite: string;
  caseName: string;
  root: string;
  home: string;
  opencode: string;
  projectRoot: string;
  databasePath: string;
  snapshotDirectory: string;
  bundleDirectory: string;
  reportPath: string;
}

function safeSegment(value: string): string {
  const normalized = value.normalize("NFC").replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("A non-empty synthetic Horiel P4 sandbox name is required.");
  }
  return normalized;
}

export function assertHorielP4SandboxPath(target: string, allowRoot = false): string {
  const resolved = path.resolve(target);
  const relative = path.relative(HORIEL_P4_SANDBOX_ROOT, resolved);
  if ((!allowRoot && !relative) || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Synthetic Horiel P4 path escaped its sandbox: ${target}`);
  }
  return resolved;
}

export function createHorielP4Sandbox(suite: string, caseName: string): HorielP4Sandbox {
  const safeSuite = safeSegment(suite);
  const safeCase = safeSegment(caseName);
  const root = assertHorielP4SandboxPath(path.join(HORIEL_P4_SANDBOX_ROOT, safeSuite, safeCase));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = assertHorielP4SandboxPath(path.join(root, "home", ".malahor"));
  const opencode = assertHorielP4SandboxPath(path.join(root, "home", ".config", "opencode"));
  const projectRoot = assertHorielP4SandboxPath(path.join(root, "project"));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(opencode, { recursive: true, mode: 0o700 });
  fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "horiel-p4-synthetic" }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    suite: safeSuite,
    caseName: safeCase,
    root,
    home,
    opencode,
    projectRoot,
    databasePath: assertHorielP4SandboxPath(path.join(root, "store", "horiel.sqlite")),
    snapshotDirectory: assertHorielP4SandboxPath(path.join(root, "snapshots")),
    bundleDirectory: assertHorielP4SandboxPath(path.join(root, "bundle")),
    reportPath: assertHorielP4SandboxPath(path.join(root, "report.json")),
  };
}

export function cleanupHorielP4Suite(suite: string): void {
  const suiteRoot = assertHorielP4SandboxPath(path.join(HORIEL_P4_SANDBOX_ROOT, safeSegment(suite)));
  fs.rmSync(suiteRoot, { recursive: true, force: true });
  try {
    const root = assertHorielP4SandboxPath(HORIEL_P4_SANDBOX_ROOT, true);
    if (fs.existsSync(root) && fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  } catch {
    // Other focused P4 files may still be using their own suite directory.
  }
}

export async function importP4Module<T extends Record<string, unknown>>(relativePath: string): Promise<T> {
  const target = path.resolve(HORIEL_P4_REPOSITORY_ROOT, relativePath);
  const relative = path.relative(HORIEL_P4_REPOSITORY_ROOT, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`P4 module escaped the repository: ${relativePath}`);
  }
  return await import(pathToFileURL(target).href) as T;
}

export function createSyntheticCore(): {
  core: HorielCore;
  store: FakeHorielStore;
} {
  const store = new FakeHorielStore(SYNTHETIC_STORE_ID);
  return {
    core: createHorielCore({
      store,
      clock: deterministicClock(),
      idFactory: deterministicIdFactory(),
    }),
    store,
  };
}

export const HORIEL_CORE_METHODS = [
  "saveMemory",
  "updateMemory",
  "getMemory",
  "searchMemory",
  "getContext",
  "getBrief",
  "saveSessionCheckpoint",
  "listTree",
  "inspectScope",
  "pinMemory",
  "unpinMemory",
  "linkMemory",
  "unlinkMemory",
  "previewMove",
  "moveMemory",
  "previewPromote",
  "promoteMemory",
  "createBackup",
  "previewDeleteScope",
  "deleteScope",
  "previewRestore",
  "restore",
] as const satisfies readonly (keyof HorielCore)[];

export type HorielCoreMethod = typeof HORIEL_CORE_METHODS[number];

export interface HorielCoreCall {
  method: HorielCoreMethod;
  input: unknown;
}

type CoreOverride = unknown | Error | ((input: unknown) => unknown | Promise<unknown>);

export function createHorielCoreSpy(
  overrides: Partial<Record<HorielCoreMethod, CoreOverride>> = {},
): {
  core: HorielCore;
  calls: HorielCoreCall[];
} {
  const calls: HorielCoreCall[] = [];
  const core: Record<string, (input?: unknown) => Promise<unknown>> = {};
  for (const method of HORIEL_CORE_METHODS) {
    core[method] = async (input?: unknown) => {
      calls.push({ method, input });
      const override = overrides[method];
      if (override instanceof Error) throw override;
      if (typeof override === "function") return await override(input);
      if (override !== undefined) return structuredClone(override);
      if (method === "listTree") {
        return {
          nodes: [
            { scope: "alpha", memoryCount: 1, checkpointCount: 0 },
            { scope: "alpha/task", memoryCount: 2, checkpointCount: 1 },
            { scope: "beta/feature", memoryCount: 3, checkpointCount: 0 },
            { scope: "@global", memoryCount: 1, checkpointCount: 0 },
          ],
          storeId: SYNTHETIC_STORE_ID,
          sequence: 37,
        };
      }
      return {
        method,
        id: SYNTHETIC_MEMORY_ID,
        version: 7,
        storeId: SYNTHETIC_STORE_ID,
        sequence: 37,
      };
    };
  }
  return { core: core as unknown as HorielCore, calls };
}

export async function dispatchHorielTool(
  dispatcher: unknown,
  name: string,
  args: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
): Promise<unknown> {
  if (typeof dispatcher === "function") {
    return await (dispatcher as (
      name: string,
      args: Record<string, unknown>,
      envelope?: Record<string, unknown>,
    ) => Promise<unknown>)(name, args, envelope);
  }
  if (dispatcher && typeof dispatcher === "object") {
    const record = dispatcher as Record<string, unknown>;
    for (const member of ["dispatch", "call"] as const) {
      if (typeof record[member] === "function") {
        return await (record[member] as (
          name: string,
          args: Record<string, unknown>,
          envelope?: Record<string, unknown>,
        ) => Promise<unknown>)(name, args, envelope);
      }
    }
  }
  throw new TypeError("Horiel dispatcher must be an async function or expose dispatch/call.");
}

export interface GuardCall {
  event?: string;
  approval?: string;
  raw: unknown[];
}

export function createGuardSpy(
  decide: (call: GuardCall) => "allow" | "ask" | "deny" = () => "allow",
): {
  guard: unknown;
  calls: GuardCall[];
} {
  const calls: GuardCall[] = [];
  const authorize = async (...raw: unknown[]) => {
    const first = raw[0];
    const second = raw[1];
    const record = first && typeof first === "object" ? first as Record<string, unknown> : undefined;
    const context = second && typeof second === "object" ? second as Record<string, unknown> : undefined;
    const call: GuardCall = {
      event: typeof first === "string" ? first : typeof record?.event === "string" ? record.event : undefined,
      approval: typeof record?.approval === "string"
        ? record.approval
        : typeof context?.approval === "string"
        ? context.approval
        : undefined,
      raw,
    };
    calls.push(call);
    return { decision: decide(call) };
  };
  return {
    guard: Object.assign(authorize, { authorize, check: authorize }),
    calls,
  };
}

export async function captureStdout(operation: () => unknown | Promise<unknown>): Promise<{
  output: string;
  result: unknown;
}> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await operation();
    return { output, result };
  } finally {
    process.stdout.write = original;
  }
}

export function textFromCliResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.lines)) return record.lines.map((item) => String(item)).join("\n");
    if (typeof record.output === "string") return record.output;
  }
  return value === undefined ? "" : JSON.stringify(value);
}

interface BunBuildLog {
  message?: string;
}

export async function buildNodeBundle(
  entrypoint: string,
  outputDirectory: string,
  name: string,
): Promise<string> {
  const checkedOutput = assertHorielP4SandboxPath(outputDirectory);
  fs.rmSync(checkedOutput, { recursive: true, force: true });
  fs.mkdirSync(checkedOutput, { recursive: true, mode: 0o700 });
  const build = await Bun.build({
    entrypoints: [entrypoint],
    outdir: checkedOutput,
    target: "node",
    format: "esm",
    naming: `${safeSegment(name)}.mjs`,
    sourcemap: "inline",
    external: ["node:sqlite"],
    write: true,
  });
  if (!build.success) {
    const diagnostics = build.logs
      .map((log: BunBuildLog) => log.message ?? String(log))
      .join("\n");
    throw new Error(`Node-target Horiel P4 bundle failed:\n${diagnostics}`);
  }
  const output = build.outputs[0]?.path ?? path.join(checkedOutput, `${safeSegment(name)}.mjs`);
  return assertHorielP4SandboxPath(output);
}

export interface NodeProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function runNodeProcess(input: {
  bundle: string;
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}): Promise<NodeProcessResult> {
  const bundle = assertHorielP4SandboxPath(input.bundle);
  const cwd = assertHorielP4SandboxPath(input.cwd);
  return new Promise((resolve, reject) => {
    const child = spawn("node", [bundle, ...(input.args ?? [])], {
      cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, input.timeoutMs ?? 12_000);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input.stdin ?? "");
  });
}

export async function createExistingHorielSqliteStore(sandbox: HorielP4Sandbox): Promise<void> {
  const source = assertHorielP4SandboxPath(path.join(sandbox.root, "store-creator.ts"));
  const adapter = path.join(
    HORIEL_P4_REPOSITORY_ROOT,
    "src",
    "horiel",
    "sqlite",
    "index.ts",
  );
  fs.writeFileSync(source, [
    `import { openHorielSqliteStore } from ${JSON.stringify(adapter)};`,
    `if (process.versions.node !== "22.18.0") throw new Error(\`Expected Node 22.18.0, received \${process.versions.node}\`);`,
    "const [databasePath, snapshotDirectory] = process.argv.slice(2);",
    "if (!databasePath || !snapshotDirectory) throw new Error('Synthetic store paths are required.');",
    "const store = await openHorielSqliteStore({ databasePath, snapshotDirectory, access: 'create' });",
    "await store.close();",
    "process.stdout.write(JSON.stringify({ nodeVersion: process.versions.node, created: true }) + '\\n');",
    "",
  ].join("\n"), { mode: 0o600 });
  const bundle = await buildNodeBundle(
    source,
    path.join(sandbox.bundleDirectory, "store-creator"),
    "store-creator",
  );
  const result = await runNodeProcess({
    bundle,
    cwd: sandbox.root,
    args: [sandbox.databasePath, sandbox.snapshotDirectory],
    env: sanitizedChildEnvironment(),
  });
  if (result.code !== 0) {
    throw new Error(`Synthetic Horiel store creation failed (${String(result.code)}): ${result.stderr || result.stdout}`);
  }
  const report = JSON.parse(result.stdout.trim()) as { nodeVersion?: string; created?: boolean };
  if (report.nodeVersion !== "22.18.0" || report.created !== true || !fs.existsSync(sandbox.databasePath)) {
    throw new Error(`Synthetic Horiel store was not created by Node 22.18.0: ${result.stdout}`);
  }
}

export function sanitizedChildEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

export function horielRuntimeEnvironment(sandbox: HorielP4Sandbox): NodeJS.ProcessEnv {
  fs.mkdirSync(sandbox.snapshotDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sandbox.home, "projects.json"), `${JSON.stringify({
    malahor: {
      context: "memory",
      roots: [sandbox.projectRoot],
      defaultRoot: sandbox.projectRoot,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return sanitizedChildEnvironment({
    MALAHOR_HOME: sandbox.home,
    MALAHOR_OPENCODE_DIR: sandbox.opencode,
    MALAHOR_OPENCODE_DETECT: "0",
    MALAHOR_HORIEL_ENABLED: "1",
    MALAHOR_HORIEL_BOUND: "1",
    MALAHOR_HORIEL_PROJECT: "malahor",
    MALAHOR_HORIEL_DATABASE: sandbox.databasePath,
    MALAHOR_HORIEL_SNAPSHOT_DIRECTORY: sandbox.snapshotDirectory,
  });
}

export function jsonRpcLines(output: string): Array<Record<string, unknown>> {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`MCP stdout line is not a JSON-RPC object: ${line}`);
      }
      return parsed as Record<string, unknown>;
    });
}

export function jsonRpcResponse(
  responses: Array<Record<string, unknown>>,
  id: string | number,
): Record<string, unknown> {
  const response = responses.find((candidate) => candidate.id === id);
  if (!response) throw new Error(`Missing JSON-RPC response id ${String(id)}.`);
  return response;
}

export function mcpToolPayload(response: Record<string, unknown>): unknown {
  const result = response.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (record.structuredContent !== undefined) return record.structuredContent;
  if (record.content && Array.isArray(record.content)) {
    const text = record.content.find((entry) => (
      entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "text"
    )) as Record<string, unknown> | undefined;
    if (typeof text?.text === "string") {
      try {
        return JSON.parse(text.text);
      } catch {
        return text.text;
      }
    }
  }
  return result;
}
