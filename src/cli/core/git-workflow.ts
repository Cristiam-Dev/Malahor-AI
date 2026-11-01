import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadConfig } from "./config";
import { auditHookResult, hookExitCode, runHooks } from "./hooks/engine";
import { loadHookPolicy, parseHookProfile } from "./hooks/policy-loader";
import type { HookContext, HookEvent, HookResult } from "./hooks/types";
import { isSandbox } from "./paths";
import { resolveCanonicalProjectKey, resolveProject } from "./project";
import { composeCommitMessage } from "./git-commit-message";
import {
  createExternalCommitFallback,
  type CommitExecutionBlock,
  type ExternalCommitFallback,
} from "./git-commit-fallback";

export interface GitWorkflowOptions {
  action: string;
  args: string[];
  profile: string | undefined;
  project: string | undefined;
  confirm: string | undefined;
  message: string | undefined;
  body?: string | undefined;
  paths?: string | undefined;
  blockedBy?: string | undefined;
  fingerprint?: string | undefined;
  type: string | undefined;
  scope: string | undefined;
  icon: string | undefined;
  breaking?: boolean;
}

export interface GitWorkflowResult {
  action: "precommit" | "commit-message" | "commit-fallback";
  project: string;
  projectRoot: string;
  profile: string;
  policySources: string[];
  sandbox: boolean;
  targetPaths: string[];
  message?: string;
  command?: string;
  stagedFingerprint?: string;
  fallback?: ExternalCommitFallback;
  hookResult?: HookResult;
  approvalDeferred: boolean;
  notes: string[];
}

const VALIDATION_ONLY_APPROVALS = new Set(["MAL-HOOK-INFRA-APPROVAL"]);

export { composeCommitMessage };

export function isDeferredValidationApproval(
  action: GitWorkflowResult["action"],
  hookResult: HookResult | undefined,
): boolean {
  if (!hookResult || hookResult.decision !== "ask") return false;
  if (action !== "precommit" && action !== "commit-message") return false;
  const asks = hookResult.violations.filter((violation) => violation.decision === "ask");
  return asks.length > 0 && asks.every((violation) => VALIDATION_ONLY_APPROVALS.has(violation.id));
}

export function gitWorkflowExitCode(
  result: Pick<GitWorkflowResult, "action" | "hookResult">,
): number {
  if (!result.hookResult) return 0;
  if (isDeferredValidationApproval(result.action, result.hookResult)) return 0;
  return hookExitCode(result.hookResult.decision);
}

export function runGitWorkflow(options: GitWorkflowOptions): GitWorkflowResult {
  switch (options.action) {
    case "precommit":
      return runPrecommit(options);
    case "commit-message":
      return runCommitMessage(options);
    case "commit-fallback":
      return runCommitFallback(options);
    default:
      throw new Error(`Comando git invalido: ${options.action}. Usa precommit, commit-message o commit-fallback.`);
  }
}

function runPrecommit(options: GitWorkflowOptions): GitWorkflowResult {
  const context = resolveWorkflowContext(options);
  const targetPaths = stagedFiles(context.project.root, false);
  if (targetPaths.length === 0) {
    throw new Error("precommit requiere un staged no vacio y previamente revisado.");
  }
  const message = options.message?.trim() || summaryFromArgs(options.args);
  const command = message ? `git commit -m ${quoteShell(message)}` : undefined;
  const hookResult = evaluateWorkflowHook(context, {
    event: "git.commit.before",
    command,
    targetPaths,
    metadata: { validationOnly: true },
  });

  const notes = [`${targetPaths.length} archivo(s) staged revisado(s).`];
  if (!message) notes.push("Pasa --message o usa `malahor-ai git commit-message` para generar uno.");

  return {
    ...workflowResult(context, "precommit", targetPaths, notes, hookResult, message, command),
    stagedFingerprint: stagedFingerprint(context.project.root),
  };
}

function runCommitMessage(options: GitWorkflowOptions): GitWorkflowResult {
  const context = resolveWorkflowContext(options);
  const targetPaths = stagedFiles(context.project.root, true);
  const message = composeCommitMessage({
    summary: options.message ?? summaryFromArgs(options.args),
    type: options.type,
    scope: options.scope,
    icon: options.icon,
    paths: targetPaths,
    breaking: options.breaking,
  });
  const command = `git commit -m ${quoteShell(message)}`;
  const hookResult = evaluateWorkflowHook(context, {
    event: "git.commit.before",
    command,
    targetPaths,
    metadata: { validationOnly: true },
  });

  return workflowResult(context, "commit-message", targetPaths, ["Este subcomando solo genera y valida el mensaje; el flujo gestionado ejecuta el commit por separado."], hookResult, message, command);
}

function runCommitFallback(options: GitWorkflowOptions): GitWorkflowResult {
  const context = resolveWorkflowContext(options);
  const targetPaths = stagedFiles(context.project.root, false);
  const expectedPaths = parseExpectedPaths(options.paths);
  const message = options.message?.trim();
  if (!message) throw new Error("commit-fallback requiere --message con el subject aprobado.");
  if (expectedPaths.length === 0) throw new Error("commit-fallback requiere --paths con el staged revisado.");
  if (!options.fingerprint) throw new Error("commit-fallback requiere --fingerprint emitido por precommit.");
  const blockedBy = parseCommitBlock(options.blockedBy);
  const body = options.body?.trim() ? options.body : undefined;
  const command = `git commit -m ${quoteShell(message)}${body ? ` -m ${quoteShell(body)}` : ""}`;
  const hookResult = evaluateWorkflowHook(context, {
    event: "git.commit.before",
    command,
    targetPaths,
    metadata: { validationOnly: true },
  });
  const currentFingerprint = stagedFingerprint(context.project.root);
  const fallback = createExternalCommitFallback({
    cwd: context.project.root,
    subject: message,
    body,
    stagedPaths: targetPaths,
    expectedPaths,
    stagedFingerprint: currentFingerprint,
    expectedFingerprint: options.fingerprint,
    precommitDecision: hookResult.decision,
    blockedBy,
  });
  const notes = [
    "Malahor no ejecuto el commit; usa el comando externo solo por el bloqueo real ya observado.",
    `Revalida despues con: ${fallback.verificationCommand}`,
  ];
  return {
    ...workflowResult(context, "commit-fallback", targetPaths, notes, hookResult, message, fallback.command),
    stagedFingerprint: currentFingerprint,
    fallback,
  };
}

function evaluateWorkflowHook(
  context: ReturnType<typeof resolveWorkflowContext>,
  values: {
    event: HookEvent;
    command?: string;
    targetPaths: string[];
    confirmation?: string;
    metadata?: Record<string, unknown>;
  },
): HookResult {
  const hookContext: HookContext = {
    event: values.event,
    harness: "cli",
    profile: context.policy.profile,
    cwd: context.config.paths.cwd,
    projectRoot: context.project.root,
    malahorHome: context.config.paths.malahorHome,
    project: context.projectKey,
    policy: context.policy,
    security: context.security,
    policyMeta: context.policyMeta,
    command: values.command,
    targetPaths: values.targetPaths,
    confirmation: values.confirmation,
    metadata: values.metadata,
  };

  return auditHookResult(hookContext, runHooks(hookContext));
}

function resolveWorkflowContext(options: GitWorkflowOptions, fallbackProfile?: string) {
  const config = loadConfig();
  const project = resolveProject(config.paths.cwd, config.projects.aliases);
  const projectKey = options.project ? resolveCanonicalProjectKey(options.project, config.projects.aliases) : project.canonicalKey;
  const profileOverride = options.profile ? parseHookProfile(options.profile) : fallbackProfile ? parseHookProfile(fallbackProfile) : undefined;
  const policyLoad = loadHookPolicy(config.paths, projectKey, profileOverride);

  return {
    config,
    project,
    projectKey,
    policy: policyLoad.policy,
    security: policyLoad.security,
    policyMeta: policyLoad.policyMeta,
    policyHash: policyLoad.policyHash,
    sources: policyLoad.sources,
  };
}

function workflowResult(
  context: ReturnType<typeof resolveWorkflowContext>,
  action: GitWorkflowResult["action"],
  targetPaths: string[],
  notes: string[],
  hookResult?: HookResult,
  message?: string,
  command?: string,
): GitWorkflowResult {
  const approvalDeferred = isDeferredValidationApproval(action, hookResult);
  const effectiveNotes = approvalDeferred
    ? [...notes, "Aprobacion de infraestructura diferida al efecto real; este preflight no autoriza stage ni commit."]
    : notes;
  return {
    action,
    project: context.projectKey,
    projectRoot: context.project.root,
    profile: context.policy.profile,
    policySources: context.sources,
    sandbox: isSandbox(context.config.paths),
    targetPaths,
    message: message || undefined,
    command,
    hookResult,
    approvalDeferred,
    notes: effectiveNotes,
  };
}

function stagedFiles(cwd: string, fallbackToChanged: boolean): string[] {
  const staged = gitNullPaths(cwd, ["diff", "--cached", "--name-only", "-z"]);
  if (staged.length > 0 || !fallbackToChanged) return staged;
  return changedFiles(cwd);
}

function changedFiles(cwd: string): string[] {
  return gitRawLines(cwd, ["status", "--short"])
    .map((line) => line.slice(3).trim())
    .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1) ?? line : line)
    .filter(Boolean);
}

function gitRawLines(cwd: string, args: string[]): string[] {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

function gitNullPaths(cwd: string, args: string[]): string[] {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

function summaryFromArgs(args: string[]): string | undefined {
  const summary = args.join(" ").trim();
  return summary || undefined;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stagedFingerprint(cwd: string): string {
  try {
    const diff = execFileSync("git", ["diff", "--cached", "--binary", "--no-ext-diff"], {
      cwd,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return `sha256:${createHash("sha256").update(diff).digest("hex")}`;
  } catch {
    return "";
  }
}

function parseExpectedPaths(value: string | undefined): string[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("commit-fallback requiere --paths como array JSON de strings.");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("commit-fallback requiere --paths como array JSON no vacio de strings no vacios.");
  }
  const paths = parsed as string[];
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error("commit-fallback requiere --paths como array JSON no vacio y sin duplicados.");
  }
  return [...paths].sort();
}

function parseCommitBlock(value: string | undefined): CommitExecutionBlock {
  if (["host-deny", "host-ask", "harness-unavailable", "policy-deny"].includes(value ?? "")) {
    return value as CommitExecutionBlock;
  }
  throw new Error("commit-fallback requiere --blocked-by host-deny|host-ask|harness-unavailable.");
}
