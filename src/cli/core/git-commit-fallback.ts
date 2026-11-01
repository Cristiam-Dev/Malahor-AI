import type { HookDecision } from "./hooks/types";

export type CommitExecutionBlock =
  | "host-deny"
  | "host-ask"
  | "harness-unavailable"
  | "policy-deny";

export interface ExternalCommitFallbackInput {
  cwd: string;
  subject: string;
  body?: string;
  stagedPaths: string[];
  expectedPaths: string[];
  stagedFingerprint: string;
  expectedFingerprint: string;
  precommitDecision: HookDecision;
  blockedBy: CommitExecutionBlock;
  platform?: NodeJS.Platform;
}

export interface ExternalCommitFallback {
  executed: false;
  blockedBy: Exclude<CommitExecutionBlock, "policy-deny">;
  cwd: string;
  stagedPaths: string[];
  stagedFingerprint: string;
  command: string;
  verificationCommand: string;
}

const EXECUTION_BLOCKS = new Set<CommitExecutionBlock>([
  "host-deny",
  "host-ask",
  "harness-unavailable",
]);

export function createExternalCommitFallback(
  input: ExternalCommitFallbackInput,
): ExternalCommitFallback {
  if (input.precommitDecision !== "allow") {
    throw new Error(`Fallback bloqueado: precommit ${input.precommitDecision}; resuelve el guardrail antes.`);
  }
  if (!EXECUTION_BLOCKS.has(input.blockedBy)) {
    throw new Error("Fallback bloqueado: no sustituye un DENY de politica; solo una limitacion real del harness o permiso del host.");
  }

  const stagedPaths = normalizedPaths(input.stagedPaths);
  const expectedPaths = normalizedPaths(input.expectedPaths);
  if (stagedPaths.length === 0 || !samePaths(stagedPaths, expectedPaths)) {
    throw new Error("Fallback bloqueado: el conjunto staged no coincide exactamente con los archivos revisados.");
  }
  if (!input.stagedFingerprint || input.stagedFingerprint !== input.expectedFingerprint) {
    throw new Error("Fallback bloqueado: la huella/fingerprint del staged cambio despues de la verificacion.");
  }

  const subject = input.subject.trim();
  if (!subject || /[\r\n]/.test(subject)) {
    throw new Error("Fallback bloqueado: el subject debe ser una linea no vacia.");
  }
  const body = input.body?.trim() ? input.body : undefined;
  const cwd = input.cwd;
  const powershell = (input.platform ?? process.platform) === "win32";
  const quote = powershell ? quotePowerShellArgument : quoteShellArgument;
  const commit = ["git commit", "-m", quote(subject)];
  if (body) commit.push("-m", quote(body));
  const command = powershell
    ? `Set-Location -LiteralPath ${quotePowerShellArgument(cwd)} -ErrorAction Stop; ${commit.join(" ")}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`
    : `cd -- ${quoteShellArgument(cwd)} && ${commit.join(" ")}`;
  const verificationCommand = powershell
    ? `Set-Location -LiteralPath ${quotePowerShellArgument(cwd)} -ErrorAction Stop; git --no-pager log -1 --oneline; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git status --short --untracked-files=all`
    : `cd -- ${quoteShellArgument(cwd)} && git --no-pager log -1 --oneline && git status --short --untracked-files=all`;
  return {
    executed: false,
    blockedBy: input.blockedBy as ExternalCommitFallback["blockedBy"],
    cwd,
    stagedPaths,
    stagedFingerprint: input.stagedFingerprint,
    command,
    verificationCommand,
  };
}

export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function quotePowerShellArgument(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizedPaths(paths: string[]): string[] {
  return [...new Set(paths.filter((value) => value.length > 0))].sort();
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
