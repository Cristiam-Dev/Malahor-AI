import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { registeredProjectRoots, rootsForProject } from "./context";
import type { MalahorPaths } from "./paths";

// Provider selected after the external-storage spike (T-5.4.2). No mutable
// 'latest' URLs or unverified executables are ever used by the managed runtime.
export const CODEGRAPH_PROVIDER = "symgraph";
export const CODEGRAPH_VERSION = "2026.10.18";
export const CODEGRAPH_RELEASE = `v${CODEGRAPH_VERSION}`;
// Hash of the reviewed asset. A foreign/modified bridge is never registered.
export const CODEGRAPH_PROXY_SHA256 = "a4ca5c34ff82cfbf9bb8b49db0f667091a4471ba151f00fb16058fd5204f03ce";

export const CODEGRAPH_ARCHIVES: Record<string, { name: string; sha256: string }> = {
  "linux:x64": { name: "symgraph-v2026.10.18-x86_64-unknown-linux-gnu.tar.gz", sha256: "5e52d232f2bef2fac7ee2cc6b446b8ac5af68442c7b47f4f36209466eeb11077" },
  "linux:arm64": { name: "symgraph-v2026.10.18-aarch64-unknown-linux-gnu.tar.gz", sha256: "8b49f569f9c4a777fc0e82a2c3b07dfda5371735e0a429d74ba6d31d0856a698" },
  "darwin:x64": { name: "symgraph-v2026.10.18-x86_64-apple-darwin.tar.gz", sha256: "66bf8fef84cb0027bb94e33dcdcd97f1db190d73a07ac80fafbb5ea65cca11bd" },
  "darwin:arm64": { name: "symgraph-v2026.10.18-aarch64-apple-darwin.tar.gz", sha256: "6f4d3a7379c9396fbfa8dccb246201514baa8434afbf962044cd1c78f5caeae5" },
  "win32:x64": { name: "symgraph-v2026.10.18-x86_64-pc-windows-msvc.zip", sha256: "1e639af2ca4358ccf64b1238f38fc918eda2db40d2504c2eb3e19ac8089b4a30" },
};

// Extracted executable digests from the pinned archives. A writable managed.json
// is an ownership record, not a trust anchor; both must match independently.
export const CODEGRAPH_BINARIES: Record<string, string> = {
  "linux:x64": "0a20a58846850bfe5ceca9b8ea437b81f9069364543fd6a7c21f7081de67cfb3",
  "linux:arm64": "4d9ab74d52c5ba45654d05ababd569dd552e9a8280a19be17fc988b3b7508a30",
  "darwin:x64": "315ff7d65ac98073033b9c88869a48c44b3f19989b0bbe6214fade3683e5a873",
  "darwin:arm64": "4c15a88ad040902fd15be5507550a71d20fd8387293e18f32c586e51a966874e",
  "win32:x64": "3a834de37e870bfe0ab14217ddafbefd990442982a0c4c07965d5cd4e9089e32",
};

interface BinaryState {
  provider: string;
  version: string;
  sha256: string;
}

interface IndexState {
  provider: string;
  version: string;
  project: string;
  root: string;
  database: string;
  ready: boolean;
}

export interface CodegraphRuntime {
  binary: string;
  proxy: string;
  root: string;
  database: string;
}

export function codegraphDirectory(paths: MalahorPaths): string {
  return path.join(paths.malahorHome, "codegraph");
}

export function codegraphBinary(paths: MalahorPaths): string {
  return path.join(codegraphDirectory(paths), "bin", process.platform === "win32" ? "symgraph.exe" : "symgraph");
}

export function codegraphProxy(paths: MalahorPaths): string {
  return path.join(codegraphDirectory(paths), "bin", "mcp-proxy.mjs");
}

export function codegraphIndex(paths: MalahorPaths, root: string): { directory: string; database: string; state: string } {
  const key = createHash("sha256").update(root).digest("hex");
  const directory = path.join(codegraphDirectory(paths), "indexes", key);
  return { directory, database: path.join(directory, "index.db"), state: path.join(directory, "ownership.json") };
}

export function codegraphEnvironment(root: string, database: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Do not pass API keys, host credentials or inherited SYMGRAPH_* overrides.
  return {
    PATH: env.PATH ?? "",
    HOME: path.dirname(path.dirname(database)),
    ...(process.platform === "win32" ? { SystemRoot: env.SystemRoot, TEMP: env.TEMP } : {}),
    SYMGRAPH_DB: database,
    SYMGRAPH_ROOT: root,
  };
}

export function codegraphRoot(paths: MalahorPaths, project?: string): { project: string; root: string } {
  const candidates = registeredProjectRoots(paths.projectsFile);
  const selected = project
    ? candidates.filter((entry) => entry.canonicalKey === project)
    : candidates.filter((entry) => inside(fs.realpathSync(paths.cwd), fs.realpathSync(entry.root)));
  if (selected.length === 0) throw new Error("Registra primero la raiz del proyecto con `malahor-ai context register`.");
  const current = selected.filter((entry) => inside(fs.realpathSync(paths.cwd), fs.realpathSync(entry.root)))
    .sort((a, b) => b.root.length - a.root.length)[0];
  const preferred = project && rootsForProject(paths.projectsFile, project)[0];
  const chosen = current ?? (preferred ? selected.find((entry) => entry.root === preferred) : undefined) ?? (selected.length === 1 ? selected[0] : undefined);
  if (!chosen) throw new Error("El proyecto tiene varias raices; ejecuta el comando desde la raiz deseada.");
  const root = fs.realpathSync(chosen.root);
  if (root !== fs.realpathSync(paths.cwd) && !project && !inside(paths.cwd, root)) {
    throw new Error("No se pudo resolver una raiz registrada para el directorio actual.");
  }
  if (root === path.parse(root).root || root === paths.home) throw new Error("No se indexa la raiz del sistema ni HOME.");
  return { project: chosen.canonicalKey, root };
}

export function assertCodegraphProject(paths: MalahorPaths, project: string, root: string): void {
  if (root !== fs.realpathSync(root) || !registeredProjectRoots(paths.projectsFile)
    .some((entry) => entry.canonicalKey === project && fs.realpathSync(entry.root) === root)) {
    throw new Error("CodeGraph requiere la raiz fisica de un proyecto registrado.");
  }
}

export function assertExternalIndex(paths: MalahorPaths, root: string): void {
  const base = physicalTarget(paths.malahorHome);
  const physicalRoot = fs.realpathSync(root);
  if (inside(base, physicalRoot) || inside(physicalRoot, base)) {
    throw new Error("MALAHOR_HOME y el indice CodeGraph deben estar fuera del repositorio.");
  }
  const roots = registeredProjectRoots(paths.projectsFile).map((entry) => fs.realpathSync(entry.root));
  for (const registeredRoot of roots) {
    if (inside(base, registeredRoot)) {
      throw new Error("MALAHOR_HOME esta dentro de un proyecto registrado; indice rechazado.");
    }
  }
  // The hook checks lexical paths. Check their *physical* destinations too:
  // symlinked bin/index directories must never redirect writes into a repo.
  const index = codegraphIndex(paths, physicalRoot);
  for (const target of [codegraphDirectory(paths), path.dirname(codegraphBinary(paths)), codegraphBinary(paths), codegraphProxy(paths),
    path.dirname(index.directory), index.directory, index.database, index.state, path.join(codegraphDirectory(paths), "snapshots")]) {
    const expected = path.join(base, path.relative(paths.malahorHome, target));
    const actual = physicalTarget(target);
    if (actual !== expected || roots.some((registeredRoot) => inside(actual, registeredRoot))) {
      throw new Error(`Ruta CodeGraph redirigida o dentro de un repositorio: ${target}`);
    }
  }
}

export function verifiedCodegraphBinary(paths: MalahorPaths): string | undefined {
  const binary = codegraphBinary(paths);
  const state = readJson(path.join(codegraphDirectory(paths), "bin", "managed.json")) as Partial<BinaryState> | undefined;
  if (state?.provider !== CODEGRAPH_PROVIDER || state.version !== CODEGRAPH_VERSION || !/^[a-f0-9]{64}$/.test(state.sha256 ?? "")) return undefined;
  try {
    if (physicalTarget(binary) !== path.join(physicalTarget(paths.malahorHome), path.relative(paths.malahorHome, binary))) return undefined;
    if (!fs.lstatSync(binary).isFile()) return undefined;
    const digest = createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
    return digest === CODEGRAPH_BINARIES[`${process.platform}:${process.arch}`] && digest === state.sha256 ? binary : undefined;
  } catch {
    return undefined;
  }
}

export function verifiedCodegraphProxy(paths: MalahorPaths): string | undefined {
  const proxy = codegraphProxy(paths);
  try {
    if (physicalTarget(proxy) !== path.join(physicalTarget(paths.malahorHome), path.relative(paths.malahorHome, proxy))) return undefined;
    if (!fs.lstatSync(proxy).isFile()) return undefined;
    return createHash("sha256").update(fs.readFileSync(proxy)).digest("hex") === CODEGRAPH_PROXY_SHA256 ? proxy : undefined;
  } catch {
    return undefined;
  }
}

export function codegraphRuntime(paths: MalahorPaths, project: string, root: string): CodegraphRuntime | undefined {
  try {
    const physicalRoot = fs.realpathSync(root);
    if (!registeredProjectRoots(paths.projectsFile).some((entry) => entry.canonicalKey === project && fs.realpathSync(entry.root) === physicalRoot)) return undefined;
    assertExternalIndex(paths, physicalRoot);
    const binary = verifiedCodegraphBinary(paths);
    const proxy = verifiedCodegraphProxy(paths);
    const index = codegraphIndex(paths, physicalRoot);
    const state = readJson(index.state) as Partial<IndexState> | undefined;
    if (!binary || !proxy || state?.provider !== CODEGRAPH_PROVIDER || state.version !== CODEGRAPH_VERSION || state.ready !== true || state.project !== project || state.root !== physicalRoot || state.database !== index.database) return undefined;
    if (!fs.lstatSync(index.database).isFile() || fs.realpathSync(index.database) !== index.database) return undefined;
    return { binary, proxy, root: physicalRoot, database: index.database };
  } catch {
    return undefined;
  }
}

export function writeManagedJson(file: string, value: BinaryState | IndexState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    if (!fs.lstatSync(file).isFile()) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function physicalTarget(target: string): string {
  const parent = path.dirname(target);
  try {
    fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (parent === target) return path.resolve(target);
    return path.join(physicalTarget(parent), path.basename(target));
  }
  return fs.realpathSync(target); // Dangling symlinks fail closed.
}

function inside(value: string, root: string): boolean {
  const relative = path.relative(root, value);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
