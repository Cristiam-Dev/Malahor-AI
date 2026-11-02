import path from "node:path";

import { createHorielCore, HorielError, type HorielCore } from "../core";
import { openHorielSqliteStore, type HorielSqliteStore } from "../sqlite";
import { createHorielHookGuard, type HorielGuard } from "./guardrails";

export interface HorielRuntimeConfiguration {
  project: string;
  databasePath: string;
  snapshotDirectory: string;
}

export interface HorielRuntime {
  configuration: HorielRuntimeConfiguration;
  core: HorielCore;
  guard: HorielGuard;
  store: HorielSqliteStore;
  close(): Promise<void>;
}

export function resolveHorielRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): HorielRuntimeConfiguration {
  if (env.MALAHOR_HORIEL_ENABLED !== "1" || env.MALAHOR_HORIEL_BOUND !== "1") {
    throw new HorielError("unavailable", "Horiel runtime is not explicitly enabled and bound.");
  }

  const project = env.MALAHOR_HORIEL_PROJECT?.trim();
  if (!project || project === "global" || project === "@global"
    || project.length > 128 || /[\0-\x20\x7f/\\]/.test(project)) {
    throw new HorielError("invalid_input", "Horiel runtime project identity is invalid.");
  }

  const databasePath = absoluteRuntimePath(env.MALAHOR_HORIEL_DATABASE);
  const snapshotDirectory = absoluteRuntimePath(env.MALAHOR_HORIEL_SNAPSHOT_DIRECTORY);
  if (databasePath === snapshotDirectory) {
    throw new HorielError("unsafe_path", "Horiel runtime paths are invalid.");
  }
  return { project, databasePath, snapshotDirectory };
}

export async function createHorielRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HorielRuntime> {
  const configuration = resolveHorielRuntimeConfiguration(env);
  const store = await openHorielSqliteStore({
    databasePath: configuration.databasePath,
    snapshotDirectory: configuration.snapshotDirectory,
    access: "write",
  });
  const core = createHorielCore({ store });
  const guard = createHorielHookGuard({
    project: configuration.project,
    databasePath: configuration.databasePath,
    env,
  });
  return {
    configuration,
    core,
    guard,
    store,
    close: () => store.close(),
  };
}

function absoluteRuntimePath(value: string | undefined): string {
  if (!value || !path.isAbsolute(value) || value.includes("\0")) {
    throw new HorielError("unsafe_path", "Horiel runtime requires explicit absolute paths.");
  }
  return path.resolve(value);
}
