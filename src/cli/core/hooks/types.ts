export type HookDecision = "allow" | "warn" | "ask" | "deny";

export type HookProfile = "off" | "light" | "standard" | "strict" | "release";

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
  "obsidian.write.before",
  "graphify.generate.before",
  "install.preflight",
  "install.beforePolicy",
  "update.preflight",
  "uninstall.beforeRemove",
  "git.commit.before",
  "git.push.before",
  "git.reset.before",
  "git.checkout.before",
  "git.rebase.before",
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
// media dentro de ese sandbox: se bloquea el punto de entrada hasta T-5.5.5.
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
  targetPaths?: string[];
  memoryScope?: string;
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

export interface HookViolation {
  id: string;
  decision: HookDecision;
  message: string;
  fix: string;
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
