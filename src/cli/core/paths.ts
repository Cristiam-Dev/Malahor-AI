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

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): MalahorPaths {
  const home = path.resolve(env.HOME ?? os.homedir());
  const malahorHome = path.resolve(cwd, env.MALAHOR_HOME ?? path.join(home, ".malahor"));
  const xdgConfigHome = path.resolve(cwd, env.XDG_CONFIG_HOME ?? path.join(home, ".config"));
  const opencodeDir = path.resolve(cwd, env.MALAHOR_OPENCODE_DIR ?? path.join(xdgConfigHome, "opencode"));

  return {
    cwd,
    home,
    malahorHome,
    mnemoDir: path.join(malahorHome, "mnemo"),
    mnemoDb: path.join(malahorHome, "mnemo", "db.json"),
    mnemoIndex: path.join(malahorHome, "mnemo", "index.js"),
    graphsDir: path.join(malahorHome, "graphs"),
    vaultDir: path.join(malahorHome, "vault"),
    configFile: path.resolve(cwd, env.MALAHOR_CONFIG ?? path.join(malahorHome, "config.jsonc")),
    opencodeDir,
    opencodeConfig: path.join(opencodeDir, "opencode.jsonc"),
    opencodeMd: path.join(opencodeDir, "OPENCODE.md"),
    backupsDir: path.join(malahorHome, "backups"),
  };
}

export function isSandbox(paths: MalahorPaths): boolean {
  return paths.malahorHome.includes(`${path.sep}.sandbox${path.sep}`) || paths.opencodeDir.includes(`${path.sep}.sandbox${path.sep}`);
}
