import fs from "node:fs";
import path from "node:path";
import { stripJsonComments } from "../injector";
import type { MalahorPaths } from "../paths";
import { projectLookupKey } from "../project";
import type { HookPolicy, HookProfile } from "./types";

export interface HookPolicyLoadResult {
  policy: HookPolicy;
  defaultPath: string;
  projectPath: string | null;
  sources: string[];
  warnings: string[];
}

type HookPolicyFile = Partial<{
  profile: unknown;
  git: Partial<Record<keyof HookPolicy["git"], unknown>>;
  secrets: Partial<Record<keyof HookPolicy["secrets"], unknown>>;
  memory: Partial<Record<keyof HookPolicy["memory"], unknown>>;
  policy: Partial<Record<keyof HookPolicy["policy"], unknown>>;
  quality: Partial<Record<keyof HookPolicy["quality"], unknown>>;
}>;

export const HOOK_PROFILES: readonly HookProfile[] = ["off", "light", "standard", "strict", "release"];

export function loadHookPolicy(paths: MalahorPaths, project?: string, profileOverride?: HookProfile): HookPolicyLoadResult {
  const defaultPath = hookDefaultPolicyPath(paths);
  const projectPath = project ? hookProjectPolicyPath(paths, project) : null;
  const sources: string[] = [];
  const warnings: string[] = [];
  const defaults = defaultPolicy(profileOverride ?? "standard");
  let merged = defaults;

  const defaultFile = readHookPolicyFile(defaultPath, warnings);
  if (defaultFile) {
    merged = mergePolicy(merged, defaultFile);
    sources.push(defaultPath);
  }

  if (projectPath) {
    const projectFile = readHookPolicyFile(projectPath, warnings);
    if (projectFile) {
      merged = mergePolicy(merged, projectFile);
      sources.push(projectPath);
    }
  }

  if (profileOverride) {
    merged = mergePolicy(merged, { profile: profileOverride });
  }

  return { policy: merged, defaultPath, projectPath, sources, warnings };
}

export function hookDefaultPolicyPath(paths: MalahorPaths): string {
  return path.join(paths.malahorHome, "policies", "default.jsonc");
}

export function hookProjectPolicyPath(paths: MalahorPaths, project: string): string {
  return path.join(paths.malahorHome, "policies", "projects", `${projectLookupKey(project) || "project"}.jsonc`);
}

export function saveHookProfile(paths: MalahorPaths, profile: HookProfile, project?: string): string {
  const filePath = project ? hookProjectPolicyPath(paths, project) : hookDefaultPolicyPath(paths);
  const current = readHookPolicyFile(filePath, []) ?? {};
  const next = { ...current, profile };

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  secureChmod(path.dirname(filePath), 0o700);
  secureChmod(filePath, 0o600);

  return filePath;
}

export function parseHookProfile(value: string): HookProfile {
  if (HOOK_PROFILES.includes(value as HookProfile)) return value as HookProfile;
  throw new Error(`Perfil hooks invalido: ${value}. Usa ${HOOK_PROFILES.join(", ")}.`);
}

function defaultPolicy(profile: HookProfile): HookPolicy {
  const enabled = profile !== "off";
  const standardOrHigher = profile === "standard" || profile === "strict" || profile === "release";
  const strictOrRelease = profile === "strict" || profile === "release";

  return {
    profile,
    git: {
      blockDestructiveCommands: enabled,
      requireChecksBeforePush: strictOrRelease,
      validateCommitMessage: standardOrHigher,
    },
    secrets: {
      scanBeforeCommit: enabled,
    },
    memory: {
      destructiveRequiresPreview: enabled,
    },
    policy: {
      enforceDeferredPolicy: enabled,
      blockTotalBashDeny: enabled,
    },
    quality: {
      warnLargeFiles: standardOrHigher,
      warnGenericModules: profile === "strict" || profile === "release",
    },
  };
}

function mergePolicy(base: HookPolicy, file: HookPolicyFile): HookPolicy {
  const profile = typeof file.profile === "string" ? parseHookProfile(file.profile) : base.profile;
  const withProfile = profile === base.profile ? base : defaultPolicy(profile);

  return {
    profile,
    git: {
      ...withProfile.git,
      ...booleanRecord(file.git, withProfile.git),
    },
    secrets: {
      ...withProfile.secrets,
      ...booleanRecord(file.secrets, withProfile.secrets),
    },
    memory: {
      ...withProfile.memory,
      ...booleanRecord(file.memory, withProfile.memory),
    },
    policy: {
      ...withProfile.policy,
      ...booleanRecord(file.policy, withProfile.policy),
    },
    quality: {
      ...withProfile.quality,
      ...booleanRecord(file.quality, withProfile.quality),
    },
  };
}

function readHookPolicyFile(filePath: string, warnings: string[]): HookPolicyFile | null {
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(stripJsonComments(raw));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.profile === "string" && !HOOK_PROFILES.includes(record.profile as HookProfile)) {
        warnings.push(`${filePath}: profile invalido ${record.profile}; se ignora.`);
        delete record.profile;
      }
      return parsed as HookPolicyFile;
    }
    warnings.push(`${filePath}: la raiz debe ser un objeto JSON.`);
  } catch (error) {
    warnings.push(`${filePath}: ${(error as Error).message}`);
  }

  return null;
}

function booleanRecord<T extends Record<string, boolean>>(value: unknown, shape: T): Partial<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Partial<T> = {};

  for (const key of Object.keys(shape) as Array<keyof T>) {
    const next = (value as Record<string, unknown>)[String(key)];
    if (typeof next === "boolean") {
      result[key] = next as T[keyof T];
    }
  }

  return result;
}

function secureChmod(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Windows no soporta permisos POSIX; se ignora.
  }
}
