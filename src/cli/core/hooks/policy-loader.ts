import fs from "node:fs";
import path from "node:path";
import { stripJsonComments } from "../injector";
import type { MalahorPaths } from "../paths";
import { projectLookupKey } from "../project";
import {
  BUILT_IN_SECURITY_CONTROLS,
  applyLegacySecurityFloor,
  mergeSecurityLayers,
  securityControlsHash,
  sha256,
  unenforcedControlPaths,
  validateSecurityLayer,
} from "./security-policy";
import type {
  CorporatePolicyStatus,
  HookPolicy,
  HookPolicyMeta,
  HookPolicySource,
  HookProfile,
  SecurityControls,
  SecurityLayer,
} from "./types";

export interface HookPolicyLoadResult {
  policy: HookPolicy;
  security: SecurityControls;
  policyMeta: HookPolicyMeta;
  policyHash: string;
  defaultPath: string;
  projectPath: string | null;
  corporatePath: string | null;
  sources: string[];
  warnings: string[];
}

export interface HookPolicyLoadOptions {
  corporatePath?: string | null;
  corporateRequired?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

type HookPolicyFile = Partial<{
  profile: unknown;
  git: Partial<Record<keyof HookPolicy["git"], unknown>>;
  secrets: Partial<Record<keyof HookPolicy["secrets"], unknown>>;
  memory: Partial<Record<keyof HookPolicy["memory"], unknown>>;
  policy: Partial<Record<keyof HookPolicy["policy"], unknown>>;
  quality: Partial<Record<keyof HookPolicy["quality"], unknown>>;
}>;

type PolicyFileRead =
  | { kind: "security"; layer: SecurityLayer; rawHash: string }
  | { kind: "legacy"; file: HookPolicyFile; rawHash: string }
  | { kind: "invalid"; message: string; rawHash?: string };

export const HOOK_PROFILES: readonly HookProfile[] = ["off", "light", "standard", "strict", "release"];

const PROFILE_RANK: Record<HookProfile, number> = {
  off: 0,
  light: 1,
  standard: 2,
  strict: 3,
  release: 4,
};

export function loadHookPolicy(
  paths: MalahorPaths,
  project?: string,
  profileOverride?: HookProfile,
  options: HookPolicyLoadOptions = {},
): HookPolicyLoadResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const defaultPath = hookDefaultPolicyPath(paths);
  const projectPath = project ? hookProjectPolicyPath(paths, project) : null;
  const sources: string[] = [];
  const warnings: string[] = [];
  const layerInputs: Array<{ layer: SecurityLayer; source: HookPolicySource }> = [];
  const sourceMeta: HookPolicySource[] = [builtInSource()];
  const criticalGaps: string[] = [];
  const corp = resolveCorporatePolicyPath(options, env, platform);
  const explicitCorporate = (options.corporatePath !== undefined && options.corporatePath !== null)
    || Boolean(env.MALAHOR_CORPORATE_POLICY);
  const corporateRequired = options.corporateRequired
    ?? (explicitCorporate || env.MALAHOR_CORPORATE_POLICY_REQUIRED === "1");
  let corporateStatus: CorporatePolicyStatus = "absent";
  let corporateLayer: SecurityLayer | undefined;
  let corporateProfileFloor: HookProfile | undefined;

  let merged = defaultPolicy(profileOverride ?? "standard");

  if (corp.path && fs.existsSync(corp.path)) {
    const trust = verifyCorporatePolicyTrust(corp.path, platform);
    if (!trust.ok) {
      corporateStatus = "untrusted";
      warnings.push(`${corp.path}: politica corporativa no confiable: ${trust.reason}`);
      sourceMeta.push(corporateSource(corp.path, "untrusted", trust.reason));
    } else {
      const read = readPolicyFile(corp.path, true, true, warnings);
      if (read?.kind === "security") {
        corporateStatus = "valid";
        corporateLayer = read.layer;
        corporateProfileFloor = read.layer.profile;
        if (read.layer.profile === "off") {
          warnings.push(`${corp.path}: perfil corporativo off no desactiva controles criticos.`);
        }
        for (const gap of unenforcedControlPaths(read.layer)) {
          criticalGaps.push(`corporate:${gap}`);
        }
        layerInputs.push({
          layer: read.layer,
          source: corporateSource(corp.path, "valid", undefined, read),
        });
        sourceMeta.push(corporateSource(corp.path, "valid", undefined, read));
        sources.push(corp.path);
      } else {
        corporateStatus = "invalid";
        const message = read?.kind === "invalid" ? read.message : "la politica corporativa debe ser v1";
        warnings.push(`${corp.path}: politica corporativa invalida: ${message}`);
        sourceMeta.push(corporateSource(corp.path, "invalid", message, read));
      }
    }
  } else if (corporateRequired) {
    corporateStatus = "required-missing";
    warnings.push("politica corporativa obligatoria ausente; las operaciones sensibles quedan bloqueadas.");
    sourceMeta.push(corporateSource(corp.path ?? "<required>", "invalid", "archivo obligatorio ausente"));
  }

  const defaultFile = readPolicyFile(defaultPath, false, false, warnings);
  if (defaultFile) {
    merged = mergePolicyFile("local", defaultPath, defaultFile, layerInputs, sourceMeta, sources, criticalGaps, warnings, merged);
  }

  if (projectPath) {
    const projectFile = readPolicyFile(projectPath, false, false, warnings);
    if (projectFile) {
      merged = mergePolicyFile("project", projectPath, projectFile, layerInputs, sourceMeta, sources, criticalGaps, warnings, merged);
    }
  }

  if (profileOverride) {
    if (profileOverride === "off") {
      warnings.push("perfil off no desactiva controles criticos; se conserva el suelo.");
    }
    merged = mergePolicy(merged, { profile: profileOverride });
  }

  if (corporateProfileFloor && PROFILE_RANK[merged.profile] < PROFILE_RANK[corporateProfileFloor]) {
    warnings.push(`perfil corporativo ${corporateProfileFloor}: no se permite bajarlo a ${merged.profile}.`);
    merged = mergePolicy(merged, { profile: corporateProfileFloor });
  }

  const securityMerge = mergeSecurityLayers(layerInputs);
  warnings.push(...securityMerge.warnings);
  merged = applyLegacySecurityFloor(merged, securityMerge.controls);

  const policyHash = securityControlsHash(securityMerge.controls, merged.profile);
  const policyMeta: HookPolicyMeta = {
    contractVersion: 1,
    schemaVersion: 1,
    policyVersion: corporateLayer?.policyVersion ?? latestSecurityLayer(layerInputs)?.policyVersion ?? "built-in",
    issuer: corporateLayer?.issuer ?? latestSecurityLayer(layerInputs)?.issuer ?? "malahor-built-in",
    issuedAt: corporateLayer?.issuedAt ?? latestSecurityLayer(layerInputs)?.issuedAt,
    policyHash,
    sources: sourceMeta,
    corporateStatus,
    corporateRequired,
    corporatePath: corp.path ?? undefined,
    criticalGaps: uniqueStrings(criticalGaps),
    warnings: uniqueStrings(warnings),
  };

  return {
    policy: merged,
    security: securityMerge.controls,
    policyMeta,
    policyHash,
    defaultPath,
    projectPath,
    corporatePath: corp.path ?? null,
    sources,
    warnings: policyMeta.warnings,
  };
}

export function hookDefaultPolicyPath(paths: MalahorPaths): string {
  return path.join(paths.malahorHome, "policies", "default.jsonc");
}

export function hookProjectPolicyPath(paths: MalahorPaths, project: string): string {
  return path.join(paths.malahorHome, "policies", "projects", `${projectLookupKey(project) || "project"}.jsonc`);
}

export function saveHookProfile(paths: MalahorPaths, profile: HookProfile, project?: string): string {
  const filePath = project ? hookProjectPolicyPath(paths, project) : hookDefaultPolicyPath(paths);
  const current = readRawObject(filePath) ?? {};
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

function mergePolicyFile(
  kind: "local" | "project",
  filePath: string,
  read: PolicyFileRead,
  layerInputs: Array<{ layer: SecurityLayer; source: HookPolicySource }>,
  sourceMeta: HookPolicySource[],
  sources: string[],
  criticalGaps: string[],
  warnings: string[],
  currentPolicy: HookPolicy,
): HookPolicy {
  if (read.kind === "invalid") {
    warnings.push(`${filePath}: ${read.message}; se ignora la capa.`);
    sourceMeta.push({
      kind,
      authority: kind === "project" ? 2 : 3,
      path: filePath,
      status: "invalid",
      sha256: read.rawHash,
      message: read.message,
    });
    return currentPolicy;
  }

  if (read.kind === "security") {
    const source = sourceForLayer(kind, filePath, read);
    layerInputs.push({ layer: read.layer, source });
    sourceMeta.push(source);
    sources.push(filePath);
    for (const gap of unenforcedControlPaths(read.layer)) {
      criticalGaps.push(`${kind}:${gap}`);
    }
    if (read.layer.profile) {
      if (read.layer.profile === "off") {
        warnings.push(`${filePath}: profile off no desactiva controles criticos; se conserva el suelo.`);
      }
      return mergePolicy(currentPolicy, { profile: read.layer.profile });
    }
    return currentPolicy;
  }

  warnLegacyLoosening(filePath, read.file, currentPolicy, warnings);
  sourceMeta.push({
    kind,
    authority: kind === "project" ? 2 : 3,
    path: filePath,
    status: "valid",
    schemaVersion: 0,
    contractVersion: 0,
    sha256: read.rawHash,
  });
  sources.push(filePath);
  return mergePolicy(currentPolicy, read.file);
}

function readPolicyFile(
  filePath: string,
  strictSecurity: boolean,
  requireSecurity: boolean,
  warnings: string[],
): PolicyFileRead | null {
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    return { kind: "invalid", message: (error as Error).message };
  }
  if (!raw) {
    return requireSecurity
      ? { kind: "invalid", message: "la politica corporativa esta vacia", rawHash: sha256("") }
      : { kind: "legacy", file: {}, rawHash: sha256("") };
  }

  const rawHash = sha256(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (error) {
    return { kind: "invalid", message: `JSON invalido: ${(error as Error).message}`, rawHash };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", message: "la raiz debe ser un objeto JSON", rawHash };
  }

  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== undefined) {
    const validated = validateSecurityLayer(parsed, { strict: strictSecurity });
    warnings.push(...validated.warnings.map((warning) => `${filePath}: ${warning}`));
    if (!validated.ok || !validated.layer) {
      return { kind: "invalid", message: validated.errors.join("; "), rawHash };
    }
    return { kind: "security", layer: validated.layer, rawHash };
  }

  if (requireSecurity) {
    return { kind: "invalid", message: "la politica corporativa debe declarar schemaVersion: 1", rawHash };
  }

  if (record.controls !== undefined || record.contractVersion !== undefined || record.issuer !== undefined || record.issuedAt !== undefined || record.policyVersion !== undefined) {
    return { kind: "invalid", message: "la politica declara campos v1 pero falta schemaVersion: 1", rawHash };
  }

  if (typeof record.profile === "string" && !HOOK_PROFILES.includes(record.profile as HookProfile)) {
    warnings.push(`${filePath}: profile invalido ${record.profile}; se ignora.`);
    delete record.profile;
  }

  return { kind: "legacy", file: record as HookPolicyFile, rawHash };
}

function readRawObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function resolveCorporatePolicyPath(
  options: HookPolicyLoadOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { path: string | null } {
  if (options.corporatePath === null) return { path: null };
  const configured = options.corporatePath ?? env.MALAHOR_CORPORATE_POLICY ?? defaultCorporatePolicyPath(platform, env);
  return { path: configured ? path.resolve(configured) : null };
}

export function defaultCorporatePolicyPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform === "win32") {
    return path.win32.join(env.ProgramData ?? "C:\\ProgramData", "Malahor", "security-policy.json");
  }
  if (platform === "darwin") {
    return "/Library/Application Support/Malahor/security-policy.json";
  }
  return "/etc/malahor/security-policy.json";
}

function verifyCorporatePolicyTrust(filePath: string, platform: NodeJS.Platform): { ok: boolean; reason?: string } {
  if (platform === "win32") {
    return { ok: false, reason: "verificacion de ACL de Windows pendiente; se aplica fail-closed" };
  }

  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return { ok: false, reason: "el archivo no puede ser un symlink" };
    if (!stat.isFile()) return { ok: false, reason: "no es un archivo regular" };
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid === undefined) return { ok: false, reason: "no se puede verificar el propietario" };
    if (stat.uid !== 0) return { ok: false, reason: "debe ser propiedad de root/administrador" };
    if ((stat.mode & 0o022) !== 0) return { ok: false, reason: "no debe ser escribible por grupo/otros" };

    const parent = fs.lstatSync(path.dirname(filePath));
    if (parent.uid !== 0) return { ok: false, reason: "el directorio contenedor debe ser propiedad de root/administrador" };
    if ((parent.mode & 0o022) !== 0) return { ok: false, reason: "el directorio contenedor no debe ser escribible por grupo/otros" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

function builtInSource(): HookPolicySource {
  return {
    kind: "built-in",
    authority: 0,
    status: "valid",
    schemaVersion: 1,
    contractVersion: 1,
    policyVersion: "built-in",
    issuer: "malahor",
    sha256: securityControlsHash(BUILT_IN_SECURITY_CONTROLS),
  };
}

function corporateSource(
  filePath: string,
  status: HookPolicySource["status"],
  message?: string,
  read?: PolicyFileRead | null,
): HookPolicySource {
  return {
    kind: "corporate",
    authority: 1,
    path: filePath,
    status,
    schemaVersion: read?.kind === "security" ? 1 : undefined,
    contractVersion: read?.kind === "security" ? 1 : undefined,
    policyVersion: read?.kind === "security" ? read.layer.policyVersion : undefined,
    issuer: read?.kind === "security" ? read.layer.issuer : undefined,
    issuedAt: read?.kind === "security" ? read.layer.issuedAt : undefined,
    sha256: read?.rawHash,
    message,
  };
}

function sourceForLayer(kind: "local" | "project", filePath: string, read: { layer: SecurityLayer; rawHash: string }): HookPolicySource {
  return {
    kind,
    authority: kind === "project" ? 2 : 3,
    path: filePath,
    status: "valid",
    schemaVersion: 1,
    contractVersion: 1,
    policyVersion: read.layer.policyVersion,
    issuer: read.layer.issuer,
    issuedAt: read.layer.issuedAt,
    sha256: read.rawHash,
  };
}

function latestSecurityLayer(layers: Array<{ layer: SecurityLayer; source: HookPolicySource }>): SecurityLayer | undefined {
  return layers.at(-1)?.layer;
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

function warnLegacyLoosening(filePath: string, file: HookPolicyFile, current: HookPolicy, warnings: string[]): void {
  if (file.profile === "off" && current.profile !== "off") {
    warnings.push(`${filePath}: profile off no desactiva controles criticos; se conserva el suelo.`);
  }

  const critical: Array<[string, unknown, boolean]> = [
    ["git.blockDestructiveCommands", file.git?.blockDestructiveCommands, current.git.blockDestructiveCommands],
    ["secrets.scanBeforeCommit", file.secrets?.scanBeforeCommit, current.secrets.scanBeforeCommit],
    ["memory.destructiveRequiresPreview", file.memory?.destructiveRequiresPreview, current.memory.destructiveRequiresPreview],
    ["policy.enforceDeferredPolicy", file.policy?.enforceDeferredPolicy, current.policy.enforceDeferredPolicy],
    ["policy.blockTotalBashDeny", file.policy?.blockTotalBashDeny, current.policy.blockTotalBashDeny],
  ];

  for (const [key, value, previous] of critical) {
    if (value === false && previous) {
      warnings.push(`${filePath}: intento de aflojar ${key}; se conserva el suelo.`);
    }
  }
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
