import { createHash } from "node:crypto";
import type {
  HookPolicy,
  HookPolicySource,
  HookProfile,
  SecurityControls,
  SecurityLayer,
} from "./types";

type ControlType = "boolean" | "stringArray" | "integer" | "string" | "const";
type ArrayMode = "intersect" | "union";
type IntegerMode = "min" | "max";

const CONTROL_SCHEMA: Record<keyof SecurityControls, Record<string, ControlType>> = {
  files: {
    enforceRoots: "boolean",
    allowedReadRoots: "stringArray",
    allowedWriteRoots: "stringArray",
    deniedPathGlobs: "stringArray",
    resolveSymlinks: "boolean",
    excludeSecretsFromContext: "boolean",
    excludeSecretsFromIndex: "boolean",
    requireApprovalOutsideRoots: "boolean",
  },
  shell: {
    enforceCommandAllowlist: "boolean",
    allowedCommands: "stringArray",
    deniedCommands: "stringArray",
    minimizeEnvironment: "boolean",
    denyCredentialEnv: "boolean",
    enforceTimeout: "boolean",
    timeoutSeconds: "integer",
    inspectIndirectExecution: "boolean",
    blockUnapprovedScripts: "boolean",
  },
  git: {
    requireStageConsent: "boolean",
    requireCommitConsent: "boolean",
    requirePushApproval: "boolean",
    scanStagedContent: "boolean",
    scanOutgoingCommits: "boolean",
    requireChecksBeforePush: "boolean",
    bindChecksToRevision: "boolean",
    blockDestructive: "boolean",
  },
  memory: {
    requireClientOnEveryOperation: "boolean",
    requireProjectOnEveryOperation: "boolean",
    enforceClientIsolation: "boolean",
    denyCrossClientRelated: "boolean",
    restrictSearchToAuthorizedScopes: "boolean",
    allowedClients: "stringArray",
    allowedProjects: "stringArray",
    allowedRoots: "stringArray",
    adminRequiresApproval: "boolean",
    requireGlobalScopeApproval: "boolean",
  },
  persistence: {
    requireClassificationBeforePersist: "boolean",
    blockSecrets: "boolean",
    blockPersonalData: "boolean",
    redactSensitiveData: "boolean",
    blockUnclassifiedContext: "boolean",
    captureSubagentsOptIn: "boolean",
    exportRequiresApproval: "boolean",
    logsExcludePayloads: "boolean",
  },
  destructive: {
    requirePreview: "boolean",
    requireBackup: "boolean",
    requireApproval: "boolean",
    revalidateBeforeApply: "boolean",
    bindApprovalToVersion: "boolean",
    requireConditionalWrites: "boolean",
    blockSilentDelete: "boolean",
  },
  egress: {
    enforceProviderAllowlist: "boolean",
    allowedProviders: "stringArray",
    allowedEndpoints: "stringArray",
    allowedProtocols: "stringArray",
    requireTls: "boolean",
    requireIdentityVerification: "boolean",
    coverPromptAttachments: "boolean",
    coverContinuationsTitlesCompaction: "boolean",
    coverMcpShellFetch: "boolean",
    blockUnmeasurableChannels: "boolean",
    blockAutoModelSelection: "boolean",
  },
  integrations: {
    enforceMcpToolAllowlist: "boolean",
    allowedMcpTools: "stringArray",
    requireMcpIntegrity: "boolean",
    allowedSkills: "stringArray",
    allowedPlugins: "stringArray",
    requirePluginIntegrity: "boolean",
    subagentsSameFloor: "boolean",
    treatRepoTextAsUntrusted: "boolean",
    blockUnapprovedIntegrations: "boolean",
  },
  approval: {
    requireHumanChannel: "boolean",
    allowedChannels: "stringArray",
    askWithoutChannel: "const",
    oneTime: "boolean",
    maxTtlSeconds: "integer",
    bindOperation: "boolean",
    bindResources: "boolean",
    bindClient: "boolean",
    bindPolicyHash: "boolean",
    bindContractVersion: "boolean",
    invalidateOnStateChange: "boolean",
  },
  audit: {
    required: "boolean",
    path: "string",
    fileMode: "string",
    directoryMode: "string",
    appendOnly: "boolean",
    includeDecision: "boolean",
    includeRuleIds: "boolean",
    includeResourceRefs: "boolean",
    includePayloads: "const",
    retentionDays: "integer",
    maxFiles: "integer",
    failClosedIfUnavailable: "boolean",
    corporateOverridePath: "string",
  },
  host: {
    requiredControls: "stringArray",
    doctorMayCertify: "const",
    declaredLimits: "stringArray",
  },
};

const CONTROL_CONSTRAINTS: Record<string, unknown> = {
  "approval.askWithoutChannel": "deny",
  "audit.includePayloads": false,
  "host.doctorMayCertify": false,
};

const ARRAY_MODES: Record<string, ArrayMode> = {
  "files.allowedReadRoots": "intersect",
  "files.allowedWriteRoots": "intersect",
  "files.deniedPathGlobs": "union",
  "shell.allowedCommands": "intersect",
  "shell.deniedCommands": "union",
  "memory.allowedClients": "intersect",
  "memory.allowedProjects": "intersect",
  "memory.allowedRoots": "intersect",
  "egress.allowedProviders": "intersect",
  "egress.allowedEndpoints": "intersect",
  "egress.allowedProtocols": "intersect",
  "integrations.allowedMcpTools": "intersect",
  "integrations.allowedSkills": "intersect",
  "integrations.allowedPlugins": "intersect",
  "approval.allowedChannels": "intersect",
  "host.requiredControls": "union",
  "host.declaredLimits": "union",
};

const INTEGER_MODES: Record<string, IntegerMode> = {
  "shell.timeoutSeconds": "min",
  "approval.maxTtlSeconds": "min",
  "audit.retentionDays": "max",
  "audit.maxFiles": "max",
};

/**
 * Un valor de configuracion solo exige mediacion si su control habilitador
 * esta activo. Sin esta tabla, un `audit.path` informativo bloquearia todo.
 */
const CONTROL_GATES: Record<string, string> = {
  "files.allowedReadRoots": "files.enforceRoots",
  "files.allowedWriteRoots": "files.enforceRoots",
  "shell.allowedCommands": "shell.enforceCommandAllowlist",
  "shell.timeoutSeconds": "shell.enforceTimeout",
  "egress.allowedProviders": "egress.enforceProviderAllowlist",
  "egress.allowedEndpoints": "egress.enforceProviderAllowlist",
  "integrations.allowedMcpTools": "integrations.enforceMcpToolAllowlist",
  "approval.allowedChannels": "approval.requireHumanChannel",
  "approval.maxTtlSeconds": "approval.requireHumanChannel",
  "audit.path": "audit.required",
  "audit.fileMode": "audit.required",
  "audit.directoryMode": "audit.required",
  "audit.retentionDays": "audit.required",
  "audit.maxFiles": "audit.required",
  "audit.corporateOverridePath": "audit.required",
};

const IGNORED_GAP_PATHS = new Set([
  "host.declaredLimits",
  "host.requiredControls",
  "host.doctorMayCertify",
  "approval.askWithoutChannel",
  "audit.includePayloads",
]);

/**
 * Controles que el motor actual ya evalúa antes del efecto.
 * Los demás se cargan y se reportan como brecha; no se presume cobertura.
 */
export const ENFORCED_CONTROL_PATHS = new Set([
  "git.blockDestructive",
  "git.requireStageConsent",
  "git.requireCommitConsent",
  "git.scanStagedContent",
  "git.requireChecksBeforePush",
  "destructive.requirePreview",
  "approval.requireHumanChannel",
  "approval.allowedChannels",
  "approval.oneTime",
  "approval.maxTtlSeconds",
  "approval.bindOperation",
  "approval.bindResources",
  "approval.bindClient",
  "approval.bindPolicyHash",
  "approval.bindContractVersion",
  "audit.required",
  "audit.path",
  "audit.fileMode",
  "audit.directoryMode",
  "audit.appendOnly",
  "audit.includeDecision",
  "audit.includeRuleIds",
  "audit.includeResourceRefs",
  "audit.retentionDays",
  "audit.maxFiles",
  "audit.failClosedIfUnavailable",
]);

export const BUILT_IN_SECURITY_CONTROLS: SecurityControls = {
  git: {
    blockDestructive: true,
    requireStageConsent: true,
    requireCommitConsent: true,
    scanStagedContent: true,
  },
  destructive: {
    requirePreview: true,
  },
};

export interface SecurityValidationOptions {
  strict: boolean;
}

export interface SecurityValidationResult {
  ok: boolean;
  layer?: SecurityLayer;
  errors: string[];
  warnings: string[];
}

export function validateSecurityLayer(value: unknown, options: SecurityValidationOptions): SecurityValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["la raiz debe ser un objeto JSON"], warnings };
  }

  const rootKeys = new Set(["schemaVersion", "contractVersion", "policyVersion", "issuer", "issuedAt", "profile", "controls"]);
  for (const key of Object.keys(value)) {
    if (!rootKeys.has(key)) {
      const message = `campo desconocido en politica v1: ${key}`;
      if (options.strict) errors.push(message);
      else warnings.push(`${message}; se ignora.`);
    }
  }

  if (value.schemaVersion !== 1) errors.push("schemaVersion debe ser 1");
  if (value.contractVersion !== 1) errors.push("contractVersion debe ser 1");
  if (typeof value.policyVersion !== "string" || !value.policyVersion.trim()) errors.push("policyVersion debe ser un string no vacio");
  if (typeof value.issuer !== "string" || !value.issuer.trim()) errors.push("issuer debe ser un string no vacio");
  if (!validIsoDateTime(value.issuedAt)) errors.push("issuedAt debe ser una fecha ISO 8601 valida");
  if (value.profile !== undefined && !isHookProfile(value.profile)) errors.push("profile invalido");

  const rawControls = value.controls;
  if (!isRecord(rawControls)) {
    errors.push("controls debe ser un objeto");
    return { ok: false, errors, warnings };
  }

  const controls: SecurityControls = {};
  for (const [groupName, rawGroup] of Object.entries(rawControls)) {
    if (!(groupName in CONTROL_SCHEMA)) {
      const message = `grupo de controles desconocido: ${groupName}`;
      if (options.strict) errors.push(message);
      else warnings.push(`${message}; se ignora.`);
      continue;
    }
    if (!isRecord(rawGroup)) {
      errors.push(`controls.${groupName} debe ser un objeto`);
      continue;
    }

    const groupSchema = CONTROL_SCHEMA[groupName as keyof SecurityControls];
    const group: Record<string, unknown> = {};
    for (const [controlName, controlValue] of Object.entries(rawGroup)) {
      const expected = groupSchema[controlName];
      const path = `${groupName}.${controlName}`;
      if (!expected) {
        const message = `control desconocido: ${path}`;
        if (options.strict) errors.push(message);
        else warnings.push(`${message}; se ignora.`);
        continue;
      }
      if (!validControlValue(path, controlValue, expected)) {
        errors.push(`control invalido: ${path}`);
        continue;
      }
      group[controlName] = controlValue;
    }
    (controls as Record<string, unknown>)[groupName] = group;
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    layer: {
      schemaVersion: 1,
      contractVersion: 1,
      policyVersion: value.policyVersion as string,
      issuer: value.issuer as string,
      issuedAt: value.issuedAt as string,
      profile: value.profile as HookProfile | undefined,
      controls,
    },
    errors,
    warnings,
  };
}

export interface SecurityLayerInput {
  layer: SecurityLayer;
  source: HookPolicySource;
}

export interface SecurityMergeResult {
  controls: SecurityControls;
  warnings: string[];
  enabledPaths: string[];
}

export function mergeSecurityLayers(layers: SecurityLayerInput[]): SecurityMergeResult {
  const controls = cloneJson(BUILT_IN_SECURITY_CONTROLS);
  const warnings: string[] = [];

  for (const { layer, source } of layers) {
    for (const [groupName, groupValue] of Object.entries(layer.controls)) {
      const groupSchema = CONTROL_SCHEMA[groupName as keyof SecurityControls];
      if (!groupSchema || !groupValue) continue;
      const target = ensureGroup(controls, groupName as keyof SecurityControls);

      for (const [controlName, value] of Object.entries(groupValue)) {
        const expected = groupSchema[controlName];
        if (!expected) continue;
        const path = `${groupName}.${controlName}`;
        const current = (target as Record<string, unknown>)[controlName];

        if (expected === "const") continue;

        if (expected === "boolean") {
          if (current === true && value === false) {
            warnings.push(`${sourceLabel(source)} intenta aflojar ${path}; se conserva true.`);
          }
          (target as Record<string, unknown>)[controlName] = current === true || value === true;
          continue;
        }

        if (expected === "stringArray") {
          const next = mergeArray(current as string[] | undefined, value as string[], ARRAY_MODES[path] ?? "intersect", path, source, warnings);
          (target as Record<string, unknown>)[controlName] = next;
          continue;
        }

        if (expected === "integer") {
          const mode = INTEGER_MODES[path] ?? "min";
          if (current === undefined) {
            (target as Record<string, unknown>)[controlName] = value;
          } else {
            const next = mode === "min"
              ? Math.min(current as number, value as number)
              : Math.max(current as number, value as number);
            if (next !== value) warnings.push(`${sourceLabel(source)} intenta aflojar ${path}; se conserva ${next}.`);
            (target as Record<string, unknown>)[controlName] = next;
          }
          continue;
        }

        if (current === undefined) {
          (target as Record<string, unknown>)[controlName] = value;
        } else if (current !== value) {
          warnings.push(`${sourceLabel(source)} intenta cambiar ${path}; se conserva ${String(current)}.`);
        }
      }
    }
  }

  return { controls, warnings, enabledPaths: enabledControlPaths(controls) };
}

export function unenforcedControlPaths(layer: SecurityLayer): string[] {
  const paths = enabledControlPaths(layer.controls).filter((path) => !ENFORCED_CONTROL_PATHS.has(path));

  for (const required of layer.controls.host?.requiredControls ?? []) {
    if (!ENFORCED_CONTROL_PATHS.has(required)) {
      paths.push(`host.required[${required}]`);
    }
  }

  return paths;
}

export function enabledControlPaths(controls: SecurityControls): string[] {
  const result: string[] = [];
  for (const [groupName, groupSchema] of Object.entries(CONTROL_SCHEMA)) {
    const group = controls[groupName as keyof SecurityControls];
    if (!group) continue;
    for (const [controlName, expected] of Object.entries(groupSchema)) {
      const path = `${groupName}.${controlName}`;
      if (IGNORED_GAP_PATHS.has(path)) continue;
      const value = (group as Record<string, unknown>)[controlName];
      if (value === undefined || value === false) continue;

      const gate = CONTROL_GATES[path];
      if (gate) {
        const [gateGroup, gateControl] = gate.split(".");
        const gateValue = (controls[gateGroup as keyof SecurityControls] as Record<string, unknown> | undefined)?.[gateControl];
        if (gateValue !== true) continue;
      }

      if (expected === "boolean") {
        result.push(path);
        continue;
      }
      if (expected === "stringArray") {
        if (Array.isArray(value) && value.length > 0) result.push(path);
        continue;
      }
      result.push(path);
    }
  }
  return result;
}

export function applyLegacySecurityFloor(policy: HookPolicy, security: SecurityControls): HookPolicy {
  return {
    ...policy,
    git: {
      ...policy.git,
      blockDestructiveCommands: true,
      requireChecksBeforePush: policy.git.requireChecksBeforePush || security.git?.requireChecksBeforePush === true,
    },
    secrets: {
      ...policy.secrets,
      scanBeforeCommit: true,
    },
    memory: {
      ...policy.memory,
      destructiveRequiresPreview: true,
    },
    policy: {
      ...policy.policy,
      enforceDeferredPolicy: true,
      blockTotalBashDeny: true,
    },
  };
}

export function securityControlsHash(controls: SecurityControls, profile?: HookProfile): string {
  return sha256(canonicalJson({
    contractVersion: 1,
    schemaVersion: 1,
    profile: profile ?? null,
    controls,
  }));
}

export function securityLayerHash(layer: SecurityLayer): string {
  return sha256(canonicalJson(layer));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mergeArray(
  current: string[] | undefined,
  next: string[],
  mode: ArrayMode,
  path: string,
  source: HookPolicySource,
  warnings: string[],
): string[] {
  if (current === undefined) return uniqueStrings(next);

  if (mode === "intersect") {
    const allowed = new Set(next);
    const result = current.filter((value) => allowed.has(value));
    if (next.some((value) => !current.includes(value))) {
      warnings.push(`${sourceLabel(source)} intenta ampliar ${path}; se conserva la interseccion.`);
    }
    return result;
  }

  return uniqueStrings([...current, ...next]);
}

function validControlValue(path: string, value: unknown, expected: ControlType): boolean {
  if (expected === "const") return Object.is(value, CONTROL_CONSTRAINTS[path]);
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value) && value > 0;
  if (expected === "string") return typeof value === "string" && value.trim().length > 0;
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.trim().length > 0)
    && new Set(value).size === value.length;
}

function validIsoDateTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function ensureGroup(controls: SecurityControls, group: keyof SecurityControls): Record<string, unknown> {
  if (!controls[group]) {
    (controls as Record<string, unknown>)[group] = {};
  }
  return controls[group] as Record<string, unknown>;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(normalizeJson);
    const allStrings = items.every((item) => typeof item === "string");
    return allStrings ? (items as string[]).sort() : items;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizeJson(value[key])]),
    );
  }
  return value;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sourceLabel(source: HookPolicySource): string {
  return source.path ?? source.kind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookProfile(value: unknown): value is HookProfile {
  return value === "off" || value === "light" || value === "standard" || value === "strict" || value === "release";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
