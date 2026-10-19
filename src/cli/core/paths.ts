import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MalahorPaths {
  cwd: string;
  home: string;
  malahorHome: string;
  mnemoDir: string;
  mnemoDb: string;
  mnemoIndex: string;
  assetsDir: string;
  graphsDir: string;
  scriptsDir: string;
  secretsDir: string;
  projectsFile: string;
  vaultDir: string;
  configFile: string;
  opencodeDir: string;
  opencodeConfig: string;
  agentsMd: string;
  opencodeMd: string;
  opencodeSdkState: string;
  backupsDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): MalahorPaths {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const home = pathApi.resolve(resolveHome(env, platform));
  const malahorHome = pathApi.resolve(cwd, env.MALAHOR_HOME ?? pathApi.join(home, ".malahor"));
  const opencodeDir = pathApi.resolve(cwd, env.MALAHOR_OPENCODE_DIR ?? detectOpenCodeDir(env, cwd, pathApi, home));

  return {
    cwd,
    home,
    malahorHome,
    mnemoDir: pathApi.join(malahorHome, "mnemo"),
    mnemoDb: pathApi.join(malahorHome, "mnemo", "db.json"),
    mnemoIndex: pathApi.join(malahorHome, "mnemo", "index.js"),
    assetsDir: pathApi.join(malahorHome, "assets"),
    graphsDir: pathApi.join(malahorHome, "graphs"),
    scriptsDir: pathApi.join(malahorHome, "scripts"),
    secretsDir: pathApi.join(malahorHome, "secrets"),
    projectsFile: pathApi.join(malahorHome, "projects.json"),
    vaultDir: pathApi.join(malahorHome, "vault"),
    configFile: pathApi.resolve(cwd, env.MALAHOR_CONFIG ?? pathApi.join(malahorHome, "config.jsonc")),
    opencodeDir,
    opencodeConfig: pathApi.join(opencodeDir, "opencode.jsonc"),
    agentsMd: pathApi.join(opencodeDir, "AGENTS.md"),
    opencodeMd: pathApi.join(opencodeDir, "OPENCODE.md"),
    opencodeSdkState: pathApi.join(malahorHome, "opencode-sdk.json"),
    backupsDir: pathApi.join(malahorHome, "backups"),
  };
}

export function isSandbox(paths: MalahorPaths): boolean {
  return includesSandbox(paths.malahorHome) || includesSandbox(paths.opencodeDir);
}

function includesSandbox(value: string): boolean {
  return value.replaceAll("\\", "/").includes("/.sandbox/");
}

function resolveWindowsHome(env: NodeJS.ProcessEnv): string | undefined {
  if (env.HOMEDRIVE && env.HOMEPATH) {
    return `${env.HOMEDRIVE}${env.HOMEPATH}`;
  }

  return undefined;
}

function resolveHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return env.USERPROFILE ?? resolveWindowsHome(env) ?? env.HOME ?? os.homedir();
  }

  return env.HOME ?? os.homedir();
}

function detectOpenCodeDir(env: NodeJS.ProcessEnv, cwd: string, pathApi: typeof path.posix | typeof path.win32, home: string): string {
  const fallbackCandidates = fallbackOpenCodeCandidates(env, pathApi, home);
  const detected = env.MALAHOR_OPENCODE_DETECT === "0" ? undefined : detectOpenCodeDirFromApi(env, cwd, pathApi, home, fallbackCandidates);
  return detected ?? bestOpenCodeDir(fallbackCandidates, pathApi, home) ?? defaultOpenCodeDir(env, pathApi, home);
}

function detectOpenCodeDirFromApi(env: NodeJS.ProcessEnv, cwd: string, pathApi: typeof path.posix | typeof path.win32, home: string, fallbackCandidates: string[]): string | undefined {
  try {
    const output = execFileSync(env.MALAHOR_OPENCODE_BIN ?? "opencode", ["api", "get", "/api/config"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return opencodeDirFromConfigApi(output, pathApi, home, fallbackCandidates);
  } catch {
    return undefined;
  }
}

function opencodeDirFromConfigApi(output: string, pathApi: typeof path.posix | typeof path.win32, home: string, fallbackCandidates: string[]): string | undefined {
  const parsed = JSON.parse(output) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];

  const documentDirs = entries
    .flatMap((entry) => collectConfigPaths(entry))
    .filter((entry) => /opencode\.jsonc?$/i.test(pathApi.basename(entry)))
    .map((entry) => pathApi.dirname(entry));
  const directoryDirs = entries
    .flatMap((entry) => collectConfigPaths(entry))
    .filter((entry) => pathApi.basename(entry).toLowerCase() === "opencode");

  return bestOpenCodeDir([...documentDirs, ...directoryDirs, ...fallbackCandidates], pathApi, home);
}

function collectConfigPaths(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") return looksLikeOpenCodePath(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectConfigPaths(item, depth + 1));
  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const ownPath = typeof record.path === "string" && record.path.trim() ? [record.path] : [];
  return [...ownPath, ...Object.values(record).flatMap((item) => collectConfigPaths(item, depth + 1))]
    .filter(looksLikeOpenCodePath);
}

function bestOpenCodeDir(candidates: string[], pathApi: typeof path.posix | typeof path.win32, home: string): string | undefined {
  if (candidates.length === 0) return undefined;

  return unique(candidates)
    .sort((left, right) => scoreOpenCodeDir(right, pathApi, home) - scoreOpenCodeDir(left, pathApi, home))[0];
}

function scoreOpenCodeDir(candidate: string, pathApi: typeof path.posix | typeof path.win32, home: string): number {
  let score = 0;
  const normalized = normalizeForCompare(candidate);
  const preferred = normalizeForCompare(pathApi.join(home, ".config", "opencode"));

  if (normalized === preferred) score += 50;
  if (pathApi.basename(candidate).toLowerCase() === "opencode") score += 20;
  if (fs.existsSync(candidate)) score += 10;
  if (fs.existsSync(pathApi.join(candidate, "opencode.jsonc"))) score += 8;
  if (fs.existsSync(pathApi.join(candidate, "opencode.json"))) score += 8;
  if (fs.existsSync(pathApi.join(candidate, "commands"))) score += 4;
  if (fs.existsSync(pathApi.join(candidate, "AGENTS.md"))) score += 2;
  if (fs.existsSync(pathApi.join(candidate, "OPENCODE.md"))) score += 2; // legado
  return score;
}

function fallbackOpenCodeCandidates(env: NodeJS.ProcessEnv, pathApi: typeof path.posix | typeof path.win32, home: string): string[] {
  const xdgConfigHome = pathApi.resolve(env.XDG_CONFIG_HOME ?? pathApi.join(home, ".config"));
  const candidates = [pathApi.join(xdgConfigHome, "opencode"), pathApi.join(home, ".config", "opencode")];
  if (env.APPDATA) candidates.push(pathApi.join(pathApi.resolve(env.APPDATA), "opencode"));
  return unique(candidates);
}

function defaultOpenCodeDir(env: NodeJS.ProcessEnv, pathApi: typeof path.posix | typeof path.win32, home: string): string {
  return pathApi.join(pathApi.resolve(env.XDG_CONFIG_HOME ?? pathApi.join(home, ".config")), "opencode");
}

function looksLikeOpenCodePath(value: string): boolean {
  const normalized = normalizeForCompare(value);
  return /(^|\/)opencode(\/opencode\.jsonc?)?$/.test(normalized);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeForCompare(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeForCompare(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/g, "").toLowerCase();
}
