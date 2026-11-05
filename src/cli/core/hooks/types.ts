import type { GitIntent } from "../git-intent";

export type HookDecision = "allow" | "warn" | "ask" | "deny";

export type HookProfile = "off" | "light" | "standard" | "strict" | "release";

export const HOOK_RESOURCE_KINDS = ["filesystem"] as const;

export type HookResourceKind = typeof HOOK_RESOURCE_KINDS[number];

export interface HookPolicy {
  profile: HookProfile;
  git: {
    blockDestructiveCommands: boolean;
    requireChecksBeforePush: boolean;
    validateCommitMessage: boolean;
  };
  secrets: {
    scanBeforeCommit: boolean;
  };
  memory: {
    destructiveRequiresPreview: boolean;
  };
  policy: {
    enforceDeferredPolicy: boolean;
    blockTotalBashDeny: boolean;
  };
  quality: {
    warnLargeFiles: boolean;
    warnGenericModules: boolean;
  };
}

export interface FilesControls {
  enforceRoots?: boolean;
  allowedReadRoots?: string[];
  allowedWriteRoots?: string[];
  deniedPathGlobs?: string[];
  resolveSymlinks?: boolean;
  excludeSecretsFromContext?: boolean;
  excludeSecretsFromIndex?: boolean;
  requireApprovalOutsideRoots?: boolean;
}

export interface ShellControls {
  enforceCommandAllowlist?: boolean;
  allowedCommands?: string[];
  deniedCommands?: string[];
  minimizeEnvironment?: boolean;
  denyCredentialEnv?: boolean;
  enforceTimeout?: boolean;
  timeoutSeconds?: number;
  inspectIndirectExecution?: boolean;
  blockUnapprovedScripts?: boolean;
}

export interface GitControls {
  requireStageConsent?: boolean;
  requireCommitConsent?: boolean;
  requirePushApproval?: boolean;
  scanStagedContent?: boolean;
  scanOutgoingCommits?: boolean;
  requireChecksBeforePush?: boolean;
  bindChecksToRevision?: boolean;
  blockDestructive?: boolean;
}

export interface MemoryControls {
  requireClientOnEveryOperation?: boolean;
  requireProjectOnEveryOperation?: boolean;
  enforceClientIsolation?: boolean;
  denyCrossClientRelated?: boolean;
  restrictSearchToAuthorizedScopes?: boolean;
  allowedClients?: string[];
  allowedProjects?: string[];
  allowedRoots?: string[];
  adminRequiresApproval?: boolean;
  requireGlobalScopeApproval?: boolean;
}

export interface PersistenceControls {
  requireClassificationBeforePersist?: boolean;
  blockSecrets?: boolean;
  blockPersonalData?: boolean;
  redactSensitiveData?: boolean;
  blockUnclassifiedContext?: boolean;
  captureSubagentsOptIn?: boolean;
  exportRequiresApproval?: boolean;
  logsExcludePayloads?: boolean;
}

export interface DestructiveControls {
  requirePreview?: boolean;
  requireBackup?: boolean;
  requireApproval?: boolean;
  revalidateBeforeApply?: boolean;
  bindApprovalToVersion?: boolean;
  requireConditionalWrites?: boolean;
  blockSilentDelete?: boolean;
}

export interface EgressControls {
  enforceProviderAllowlist?: boolean;
  allowedProviders?: string[];
  allowedEndpoints?: string[];
  allowedProtocols?: string[];
  requireTls?: boolean;
  requireIdentityVerification?: boolean;
  coverPromptAttachments?: boolean;
  coverContinuationsTitlesCompaction?: boolean;
  coverMcpShellFetch?: boolean;
  blockUnmeasurableChannels?: boolean;
  blockAutoModelSelection?: boolean;
}

export interface IntegrationControls {
  enforceMcpToolAllowlist?: boolean;
  allowedMcpTools?: string[];
  requireMcpIntegrity?: boolean;
  allowedSkills?: string[];
  allowedPlugins?: string[];
  requirePluginIntegrity?: boolean;
  subagentsSameFloor?: boolean;
  treatRepoTextAsUntrusted?: boolean;
  blockUnapprovedIntegrations?: boolean;
}

export interface ApprovalControls {
  requireHumanChannel?: boolean;
  allowedChannels?: string[];
  askWithoutChannel?: "deny";
  oneTime?: boolean;
  maxTtlSeconds?: number;
  bindOperation?: boolean;
  bindResources?: boolean;
  bindClient?: boolean;
  bindPolicyHash?: boolean;
  bindContractVersion?: boolean;
  invalidateOnStateChange?: boolean;
}

export interface AuditControls {
  required?: boolean;
  path?: string;
  fileMode?: string;
  directoryMode?: string;
  appendOnly?: boolean;
  includeDecision?: boolean;
  includeRuleIds?: boolean;
  includeResourceRefs?: boolean;
  includePayloads?: false;
  retentionDays?: number;
  maxFiles?: number;
  failClosedIfUnavailable?: boolean;
  corporateOverridePath?: string;
}

export interface HostControls {
  requiredControls?: string[];
  doctorMayCertify?: false;
  declaredLimits?: string[];
}

export interface SecurityControls {
  files?: FilesControls;
  shell?: ShellControls;
  git?: GitControls;
  memory?: MemoryControls;
  persistence?: PersistenceControls;
  destructive?: DestructiveControls;
  egress?: EgressControls;
  integrations?: IntegrationControls;
  approval?: ApprovalControls;
  audit?: AuditControls;
  host?: HostControls;
}

export interface SecurityLayer {
  schemaVersion: 1;
  contractVersion: 1;
  policyVersion: string;
  issuer: string;
  issuedAt: string;
  profile?: HookProfile;
  controls: SecurityControls;
}

export type HookPolicySourceKind = "built-in" | "corporate" | "project" | "local";

export interface HookPolicySource {
  kind: HookPolicySourceKind;
  /** 0 = built-in; a mayor numero, menor autoridad. */
  authority: number;
  path?: string;
  status: "valid" | "invalid" | "untrusted" | "ignored";
  schemaVersion?: number;
  contractVersion?: number;
  policyVersion?: string;
  issuer?: string;
  issuedAt?: string;
  sha256?: string;
  message?: string;
}

export type CorporatePolicyStatus = "absent" | "valid" | "invalid" | "untrusted" | "required-missing" | "unsupported";

export interface HookPolicyMeta {
  contractVersion: number;
  schemaVersion: number;
  policyVersion: string;
  issuer: string;
  issuedAt?: string;
  policyHash: string;
  sources: HookPolicySource[];
  corporateStatus: CorporatePolicyStatus;
  corporateRequired: boolean;
  corporatePath?: string;
  criticalGaps: string[];
  warnings: string[];
}

export const HOOK_EVENTS = [
  "project.resolve.before",
  "context.recover.before",
  "context.save.before",
  "memory.write.before",
  "memory.delete.preview",
  "memory.delete.apply",
  "memory.move.preview",
  "memory.move.apply",
  "memory.restore.preview",
  "memory.restore.apply",
  "codegraph.index.before",
  "install.preflight",
  "install.beforePolicy",
  "update.preflight",
  "uninstall.beforeRemove",
  "git.commit.before",
  "git.push.before",
  "git.remote.before",
  "git.reset.before",
  "git.checkout.before",
  "git.rebase.before",
  "git.cherry-pick.before",
  "git.merge.before",
  "git.branch.before",
  "file.stage.before",
  "shell.exec.before",
  "file.read.before",
  "file.write.before",
  "tool.execute.before",
  "session.prompt.before",
  "session.context.before",
  "session.compaction.before",
  "session.generate.before",
  "session.title.before",
  "session.model-request.before",
  "session.http-request.before",
  "session.http-response.after",
  "plugin.permission.before",
  "dependency.add.before",
  "api.change.before",
  "database.change.before",
  "quality.check.before",
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

// Code Mode/REPL puede invocar tools sin pasar por los hooks del host. No se
// media dentro de ese sandbox: el punto de entrada permanece bloqueado hasta
// que el host exponga una mediacion previa y verificable.
export const CODE_MODE_TOOL_NAMES = new Set([
  "code",
  "code_mode",
  "codemode",
  "repl",
  "eval",
  "execute",
  "javascript",
  "typescript",
  "python",
]);

/** Gateways first-party A4. No son aliases de los entrypoints genericos bloqueados. */
export const MALAHOR_CODE_MODE_TOOL_NAMES = new Set([
  "malahor_code_search",
  "malahor_code_execute",
]);

// OpenCode normaliza las tools MCP como `<servidor>_<tool>`. Los servidores
// gestionados por Malahor deben pasar por el mismo punto de mediacion que el
// prefijo legacy `mcp_`, sin convertirlos en permisos V2 desconocidos.
export const MCP_SERVER_TOOL_PREFIXES = ["mcp", "mnemo", "horiel", "docs", "codegraph"] as const;

export function isMcpToolName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return MCP_SERVER_TOOL_PREFIXES.some((prefix) => (
    normalized === prefix
    || normalized.startsWith(`${prefix}_`)
    || normalized.startsWith(`${prefix}.`)
    || normalized.startsWith(`${prefix}:`)
  ));
}

export interface HookContext {
  event: HookEvent;
  harness: "cli" | "mcp" | "opencode" | "unknown";
  profile: HookProfile;
  cwd: string;
  projectRoot: string;
  malahorHome: string;
  project?: string;
  client?: string;
  policy?: HookPolicy;
  security?: SecurityControls;
  policyMeta?: HookPolicyMeta;
  command?: string;
  /** Tipo de todos los recursos de targetPaths; filesystem es el default legacy. */
  resourceKind?: HookResourceKind;
  targetPaths?: string[];
  memoryScope?: string;
  gitIntent?: GitIntent;
  /** Evidencia interna vinculada y consumida por el adaptador; nunca viene de metadata del caller. */
  gitIntentVerified?: boolean;
  confirmation?: string;
  approval?: string;
  audit?: {
    enabled?: boolean;
    required?: boolean;
  };
  dryRun?: boolean;
  destructive?: boolean;
  metadata?: Record<string, unknown>;
}

export interface HookReplacementRemediation {
  version: 1;
  kind: "replace-block";
  reason: "synthetic-test-fixture";
  path: string;
  startLine: number;
  endLine: number;
  anchor: string;
  /** Referencia saneada: nunca contiene el valor detectado. */
  before: string[];
  /** Bloque completo con datos sinteticos first-party. */
  replacement: string[];
  revalidate: true;
}

export type HookRemovalReason =
  | "unsupported-file-type"
  | "line-too-long"
  | "multiple-findings"
  | "value-not-demonstrably-synthetic"
  | "unsupported-syntax";

export interface HookRemovalRemediation {
  version: 1;
  kind: "remove-secret";
  /** Clasificacion cerrada y no sensible cuando el scanner puede determinarla. */
  reason?: HookRemovalReason;
  path: string;
  startLine: number;
  endLine: number;
  finding: string;
  revalidate: true;
}

export type HookRemediation = HookReplacementRemediation | HookRemovalRemediation;

export type HookBlockClass = "approval-required" | "remediable-deny" | "control-unavailable" | "hard-deny" | "advisory";

export interface HookViolation {
  id: string;
  decision: HookDecision;
  message: string;
  fix: string;
  /** Clase cerrada de bloqueo; informativa y nunca concede autoridad. */
  blockClass?: HookBlockClass;
  /** Motivo cerrado, sin payload ni rutas externas; la UI nunca lo interpreta como permiso. */
  diagnostic?: {
    code: "PATCH_NOT_EVALUABLE" | "SECRET_PRESENT" | "SECURITY_CONTROL_UNAVAILABLE";
    reason: "invalid-structure" | "unsupported-operation" | "invalid-path" | "duplicate-target"
      | "file-unavailable" | "context-mismatch" | "ambiguous-context" | "missing-evidence"
      | "secret-in-result";
    operation?: "add" | "update" | "delete";
    path?: string;
    hunk?: number;
  };
  /** Evidencia producida por el hook; metadata del caller nunca puede crearla. */
  remediations?: HookRemediation[];
}

export interface HookResult {
  event: HookEvent;
  profile: HookProfile;
  decision: HookDecision;
  violations: HookViolation[];
  policy?: HookPolicyMeta;
  approvalRef?: string;
}

export interface HookRule {
  id: string;
  critical?: boolean;
  run: (context: HookContext) => HookViolation[];
}
