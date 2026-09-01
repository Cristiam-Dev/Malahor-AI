import os from "node:os";
import path from "node:path";

export interface MalahorPaths {
  cwd: string;
  home: string;
  malahorHome: string;
  mnemoDir: string;
  mnemoDb: string;
  mnemoIndex: string;
  graphsDir: string;
  vaultDir: string;
  configFile: string;
  opencodeDir: string;
  opencodeConfig: string;
  opencodeMd: string;
  backupsDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): MalahorPaths {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const home = pathApi.resolve(env.HOME ?? env.USERPROFILE ?? resolveWindowsHome(env) ?? os.homedir());
  const malahorHome = pathApi.resolve(cwd, env.MALAHOR_HOME ?? pathApi.join(home, ".malahor"));
  const defaultConfigHome = platform === "win32" ? env.APPDATA ?? pathApi.join(home, "AppData", "Roaming") : pathApi.join(home, ".config");
  const xdgConfigHome = pathApi.resolve(cwd, env.XDG_CONFIG_HOME ?? defaultConfigHome);
  const opencodeDir = pathApi.resolve(cwd, env.MALAHOR_OPENCODE_DIR ?? pathApi.join(xdgConfigHome, "opencode"));

  return {
    cwd,
    home,
    malahorHome,
    mnemoDir: pathApi.join(malahorHome, "mnemo"),
    mnemoDb: pathApi.join(malahorHome, "mnemo", "db.json"),
    mnemoIndex: pathApi.join(malahorHome, "mnemo", "index.js"),
    graphsDir: pathApi.join(malahorHome, "graphs"),
    vaultDir: pathApi.join(malahorHome, "vault"),
    configFile: pathApi.resolve(cwd, env.MALAHOR_CONFIG ?? pathApi.join(malahorHome, "config.jsonc")),
    opencodeDir,
    opencodeConfig: pathApi.join(opencodeDir, "opencode.jsonc"),
    opencodeMd: pathApi.join(opencodeDir, "OPENCODE.md"),
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
