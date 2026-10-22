import { formatHookResult } from "../core/hooks/engine";
import type { HookResult } from "../core/hooks/types";
import { runGitWorkflow, type GitWorkflowResult } from "../core/git-workflow";

export interface GitOptions {
  action: string;
  args: string[];
  profile: string | undefined;
  project: string | undefined;
  confirm: string | undefined;
  message: string | undefined;
  type: string | undefined;
  scope: string | undefined;
  icon: string | undefined;
  json: boolean;
}

export function runGitCommand(options: GitOptions): void {
  const action = options.action || "help";

  switch (action) {
    case "precommit":
    case "prepush":
    case "commit-message":
      printWorkflowResult(runGitWorkflow({ ...options, action }), options.json);
      return;
    case "help":
    case "--help":
    case "-h":
      printGitHelp();
      return;
    default:
      throw new Error(`Comando git invalido: ${action}. Usa precommit, prepush, commit-message o help.`);
  }
}

function printWorkflowResult(result: GitWorkflowResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    applyExitCode(result.hookResult);
    return;
  }

  process.stdout.write(`\nmalahor-ai git ${result.action}\n`);
  process.stdout.write(`${"=".repeat(16 + result.action.length)}\n`);
  process.stdout.write(`Project: ${result.project}\n`);
  process.stdout.write(`Project root: ${result.projectRoot}\n`);
  process.stdout.write(`Profile: ${result.profile}\n`);
  process.stdout.write(`Policy sources: ${result.policySources.length > 0 ? result.policySources.join(", ") : "defaults"}\n`);
  process.stdout.write(`Sandbox: ${result.sandbox ? "yes" : "no"}\n`);
  process.stdout.write(`Files: ${result.targetPaths.length > 0 ? result.targetPaths.join(", ") : "none"}\n`);
  if (result.message) process.stdout.write(`Message: ${result.message}\n`);
  if (result.command) process.stdout.write(`Suggested command: ${result.command}\n`);
  if (result.hookResult) process.stdout.write(`${formatHookResult(result.hookResult)}\n`);
  if (result.notes.length > 0) process.stdout.write(`Notas:\n- ${result.notes.join("\n- ")}\n`);

  applyExitCode(result.hookResult);
}

function applyExitCode(result: HookResult | undefined): void {
  if (!result) return;
  if (result.decision === "deny") process.exitCode = 2;
  if (result.decision === "ask") process.exitCode = 3;
}

function printGitHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai git precommit [--message <mensaje>] [--profile standard|strict|release] [--json]
  malahor-ai git prepush [--profile release] [--json]
  malahor-ai git commit-message [resumen...] [--type feat|fix|docs|test|chore] [--scope <scope>] [--icon <emoji>] [--json]

Ejemplos:
  malahor-ai git commit-message agrega flujo git asistido --type feat --scope hooks
  malahor-ai git precommit --message "✨ feat(hooks): agrega flujo git asistido"
  malahor-ai git prepush --profile release

Notas:
  - No ejecuta git add, git commit ni git push.
  - DENY devuelve exit 2; ASK devuelve exit 3 y requiere aprobacion verificable.
  - CHECKS_OK no autoriza por si solo una operacion ASK.
`);
}
