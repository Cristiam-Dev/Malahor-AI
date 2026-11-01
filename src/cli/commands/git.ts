import { formatHookResult } from "../core/hooks/engine";
import { gitWorkflowExitCode, runGitWorkflow, type GitWorkflowResult } from "../core/git-workflow";

export interface GitOptions {
  action: string;
  args: string[];
  profile: string | undefined;
  project: string | undefined;
  confirm: string | undefined;
  message: string | undefined;
  body: string | undefined;
  paths: string | undefined;
  blockedBy: string | undefined;
  fingerprint: string | undefined;
  type: string | undefined;
  scope: string | undefined;
  icon: string | undefined;
  json: boolean;
}

export function runGitCommand(options: GitOptions): void {
  const action = options.action || "help";

  switch (action) {
    case "precommit":
    case "commit-message":
    case "commit-fallback":
      printWorkflowResult(runGitWorkflow({ ...options, action }), options.json);
      return;
    case "help":
    case "--help":
    case "-h":
      printGitHelp();
      return;
    default:
      throw new Error(`Comando git invalido: ${action}. Usa precommit, commit-message, commit-fallback o help.`);
  }
}

function printWorkflowResult(result: GitWorkflowResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    applyExitCode(result);
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
  if (result.stagedFingerprint) process.stdout.write(`Staged fingerprint: ${result.stagedFingerprint}\n`);
  if (result.hookResult) process.stdout.write(`${formatHookResult(result.hookResult)}\n`);
  if (result.approvalDeferred) process.stdout.write("Aprobacion: diferida al prompt nativo del efecto real\n");
  if (result.notes.length > 0) process.stdout.write(`Notas:\n- ${result.notes.join("\n- ")}\n`);

  applyExitCode(result);
}

function applyExitCode(result: GitWorkflowResult): void {
  const exitCode = gitWorkflowExitCode(result);
  if (exitCode !== 0) process.exitCode = exitCode;
}

function printGitHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai git precommit [--message <mensaje>] [--profile standard|strict|release] [--json]
  malahor-ai git commit-message [resumen...] [--type feat|fix|docs|test|chore] [--scope <scope>] [--icon <emoji>] [--json]
  malahor-ai git commit-fallback --message <subject> [--body <cuerpo>] --paths <json-array> --fingerprint <sha256:...> --blocked-by host-deny|host-ask|harness-unavailable [--json]

Ejemplos:
  malahor-ai git commit-message agrega flujo git asistido --type feat --scope hooks
  malahor-ai git precommit --message "✨ feat(hooks): agrega flujo git asistido"
  malahor-ai git commit-fallback --message "✨ feat(git): conserva staged" --paths '["src/a.ts","src/a,b.ts"]' --fingerprint sha256:... --blocked-by harness-unavailable

Notas:
  - Git remoto es hard DENY; no existe prepush ni aprobacion que lo habilite.
  - precommit y commit-message no mutan Git. commit-fallback solo imprime un comando tras validar staged y huella.
  - --paths es un array JSON exacto. El fallback usa sintaxis POSIX o PowerShell segun la plataforma.
  - DENY devuelve exit 2; ASK devuelve exit 3 y requiere aprobacion verificable.
  - En precommit/commit-message, solo MAL-HOOK-INFRA-APPROVAL puede diferirse al prompt nativo del efecto real y devolver exit 0.
`);
}
