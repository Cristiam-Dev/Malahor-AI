import { execFileSync } from "node:child_process";
import { loadConfig } from "./config";
import { runHooks } from "./hooks/engine";
import { loadHookPolicy, parseHookProfile } from "./hooks/policy-loader";
import type { HookResult } from "./hooks/types";
import { isSandbox } from "./paths";
import { resolveCanonicalProjectKey, resolveProject } from "./project";
import { composeCommitMessage } from "./git-commit-message";

export interface GitWorkflowOptions {
  action: string;
  args: string[];
  profile: string | undefined;
  project: string | undefined;
  confirm: string | undefined;
  message: string | undefined;
  type: string | undefined;
  scope: string | undefined;
  icon: string | undefined;
}

export interface GitWorkflowResult {
  action: "precommit" | "prepush" | "commit-message";
  project: string;
  projectRoot: string;
  profile: string;
  policySources: string[];
  sandbox: boolean;
  targetPaths: string[];
  message?: string;
  command?: string;
  hookResult?: HookResult;
  notes: string[];
}

export { composeCommitMessage };

export function runGitWorkflow(options: GitWorkflowOptions): GitWorkflowResult {
  switch (options.action) {
    case "precommit":
      return runPrecommit(options);
    case "prepush":
      return runPrepush(options);
    case "commit-message":
      return runCommitMessage(options);
    default:
      throw new Error(`Comando git invalido: ${options.action}. Usa precommit, prepush o commit-message.`);
  }
}

function runPrecommit(options: GitWorkflowOptions): GitWorkflowResult {
  const context = resolveWorkflowContext(options);
  const targetPaths = stagedFiles(context.project.root, true);
  const message = options.message?.trim() || summaryFromArgs(options.args);
  const command = message ? `git commit -m ${quoteShell(message)}` : undefined;
  const hookResult = runHooks({
    event: "git.commit.before",
    harness: "cli",
    profile: context.policy.profile,
    cwd: context.config.paths.cwd,
    projectRoot: context.project.root,
    malahorHome: context.config.paths.malahorHome,
    project: context.projectKey,
    policy: context.policy,
    command,
    targetPaths,
  });

  const notes = [targetPaths.length > 0 ? `${targetPaths.length} archivo(s) revisado(s).` : "No hay archivos staged; se revisaron cambios de trabajo si existian."];
  if (!message) notes.push("Pasa --message o usa `malahor-ai git commit-message` para generar uno.");

  return workflowResult(context, "precommit", targetPaths, notes, hookResult, message, command);
}

function runPrepush(options: GitWorkflowOptions): GitWorkflowResult {
  const context = resolveWorkflowContext(options, "release");
  const targetPaths = filesToPush(context.project.root);
  const hookResult = runHooks({
    event: "git.push.before",
    harness: "cli",
    profile: context.policy.profile,
    cwd: context.config.paths.cwd,
    projectRoot: context.project.root,
    malahorHome: context.config.paths.malahorHome,
    project: context.projectKey,
    policy: context.policy,
    command: "git push",
    targetPaths,
    confirmation: options.confirm,
  });
  const notes = [
    "Usa --confirm CHECKS_OK solo despues de correr tests/build relevantes.",
    targetPaths.length > 0 ? `${targetPaths.length} archivo(s) detectado(s) entre HEAD y upstream.` : "No se detectaron archivos pendientes contra upstream; si ya validaste, confirma segun politica.",
  ];

  return workflowResult(context, "prepush", targetPaths, notes, hookResult, undefined, "git push");
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
  });
  const command = `git commit -m ${quoteShell(message)}`;
  const hookResult = runHooks({
    event: "git.commit.before",
    harness: "cli",
    profile: context.policy.profile,
    cwd: context.config.paths.cwd,
    projectRoot: context.project.root,
    malahorHome: context.config.paths.malahorHome,
    project: context.projectKey,
    policy: context.policy,
    command,
    targetPaths,
  });

  return workflowResult(context, "commit-message", targetPaths, ["Mensaje generado; Malahor no ejecuta git commit por ti."], hookResult, message, command);
}

function resolveWorkflowContext(options: GitWorkflowOptions, fallbackProfile?: string) {
  const config = loadConfig();
  const project = resolveProject(config.paths.cwd, config.projects.aliases);
  const projectKey = options.project ? resolveCanonicalProjectKey(options.project, config.projects.aliases) : project.canonicalKey;
  const profileOverride = options.profile ? parseHookProfile(options.profile) : fallbackProfile ? parseHookProfile(fallbackProfile) : undefined;
  const policyLoad = loadHookPolicy(config.paths, projectKey, profileOverride);

  return { config, project, projectKey, policy: policyLoad.policy, sources: policyLoad.sources };
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
    notes,
  };
}

function stagedFiles(cwd: string, fallbackToChanged: boolean): string[] {
  const staged = gitLines(cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  if (staged.length > 0 || !fallbackToChanged) return staged;
  return changedFiles(cwd);
}

function filesToPush(cwd: string): string[] {
  const upstreamFiles = gitLines(cwd, ["diff", "--name-only", "@{u}...HEAD"]);
  if (upstreamFiles.length > 0) return upstreamFiles;
  return stagedFiles(cwd, true);
}

function changedFiles(cwd: string): string[] {
  return gitRawLines(cwd, ["status", "--short"])
    .map((line) => line.slice(3).trim())
    .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1) ?? line : line)
    .filter(Boolean);
}

function gitLines(cwd: string, args: string[]): string[] {
  return gitRawLines(cwd, args).map((line) => line.trim()).filter(Boolean);
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

function summaryFromArgs(args: string[]): string | undefined {
  const summary = args.join(" ").trim();
  return summary || undefined;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
