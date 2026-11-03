import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { classifyGitCommand, loadGitAliases } from "../cli/core/git-command-policy";
import { isValidCommitSubject } from "../cli/core/git-commit-message";
import { detectPayloadSecretKinds } from "../cli/core/hooks/secret-scan";
import { classifyInfrastructureCommand, classifyInfrastructurePath } from "../cli/core/infrastructure-boundary";
import { classifyReadOnlyShellCommand } from "../cli/core/read-only-shell-policy";

export type CommitWorkflowMode = "advisor" | "assistant" | "executor";
export const COMMIT_COMMAND_MARKER = "<!-- malahor-commit-request:v1 -->";
export const COMMIT_MANIFEST_APPROVAL = "malahor_commit_manifest";
export const COMMIT_GRANT_MISMATCH = "COMMIT_GRANT_MISMATCH" as const;

export interface CommitWorkflowScope {
  sessionID: string;
  project: string;
  policyRevision: string;
  mode: CommitWorkflowMode;
  root: string;
}

export interface CommitWorkflowCall {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
}

export interface CommitWorkflowApprovalPort {
  assert(input: {
    sessionID: string;
    agent: string;
    source: { type: "tool"; messageID: string; id: string };
    action: string;
    resources: string[];
    save: string[];
  }): Promise<unknown>;
}

export interface CommitPreparationInput {
  paths: string[];
  subject: string;
  commands: {
    diagnostics: string[];
    tests: string[];
    build: string[];
    stage: string;
    precommit: string;
    commit: string;
    verify: string[];
  };
}

export interface CommitPromptObservation {
  explicit: boolean;
  project?: string;
}

export interface CommitShellAuthorization extends CommitWorkflowScope {
  cwd: string;
  command: string;
  messageID: string;
  toolCallID: string;
  valid: boolean;
  boundary: "permission" | "tool";
}

export type CommitShellAuthorizationDecision =
  | { effect: "absent" }
  | { effect: "allow" }
  | { effect: "deny"; code: typeof COMMIT_GRANT_MISMATCH };

export interface CommitWorkflowRegistry {
  observePrompt(
    input: Record<string, unknown>,
    resolveScope: (sessionID: string) => Promise<CommitWorkflowScope | undefined>,
  ): Promise<CommitPromptObservation>;
  observePreparationPermission(input: {
    scope: CommitWorkflowScope;
    action: string;
    effect: unknown;
    source: unknown;
  }): boolean;
  evaluateApprovalPermission(input: Record<string, unknown>, scope: CommitWorkflowScope | undefined): boolean;
  prepare(
    input: unknown,
    call: CommitWorkflowCall,
    scope: CommitWorkflowScope,
    approval: CommitWorkflowApprovalPort,
    resolveScope: () => Promise<CommitWorkflowScope | undefined>,
  ): Promise<{
    paths: string[];
    subject: string;
    commands: number;
  }>;
  authorizeShell(input: CommitShellAuthorization): CommitShellAuthorizationDecision;
  invalidate(sessionID: string): void;
}

interface CommitRequest {
  scope: CommitWorkflowScope;
}

interface CommitGrant {
  scope: CommitWorkflowScope;
  commands: string[];
  cursor: number;
  inFlight?: CommitGrantStep;
  consumedCallKeys: Set<string>;
}

interface CommitGrantStep {
  index: number;
  command: string;
  messageID: string;
  toolCallID: string;
  permissionSeen: boolean;
  toolSeen: boolean;
}

interface CommitApprovalEvidence {
  scope: CommitWorkflowScope;
  callKey: string;
  resources: string[];
  paths: string[];
  subject: string;
}

interface ToolCall {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
}

interface ToolEditor {
  namespace(input: { name: string; description: string }): void;
  add(input: Record<string, unknown>): void;
}

export interface CommitWorkflowTools {
  transform(callback: (editor: ToolEditor) => void): Promise<{ dispose?: () => Promise<void> | void } | void>;
}

const PREPARE_TOOL_NAMES = new Set([
  "commit_prepare",
  "malahor_commit_prepare",
  "malahor.commit_prepare",
  "malahor:commit_prepare",
  "malahor-commit-prepare",
]);
const SAFE_SCRIPT_NAME = /^(?:typecheck|type-check|lint|check|verify|diagnostic|test|tests|coverage|build|compile|sonar)(?::[a-z0-9._-]+)?$/i;
const DIRECT_CHECK_EXECUTABLES = new Set([
  "biome", "cargo", "dotnet", "eslint", "go", "gradle", "gradlew", "jest", "make", "mvn", "mvnw",
  "node", "prettier", "pytest", "python", "python3", "ruff", "tsc", "vitest",
]);
const NETWORK_EXECUTABLES = new Set([
  "curl", "ftp", "gh", "glab", "nc", "netcat", "scp", "sftp", "ssh", "telnet", "wget",
]);

export function createCommitWorkflowRegistry(): CommitWorkflowRegistry {
  const requests = new Map<string, CommitRequest>();
  const grants = new Map<string, CommitGrant>();
  const hostAsks = new Map<string, CommitWorkflowScope>();
  const pending = new Map<string, CommitApprovalEvidence>();

  const invalidate = (sessionID: string): void => {
    requests.delete(sessionID);
    grants.delete(sessionID);
    for (const [key, scope] of hostAsks) {
      if (scope.sessionID === sessionID) hostAsks.delete(key);
    }
    for (const [key, evidence] of pending) {
      if (evidence.scope.sessionID === sessionID) pending.delete(key);
    }
  };

  return {
    async observePrompt(input, resolveScope) {
      const sessionID = stringValue(input.sessionID);
      if (!sessionID) return { explicit: false };
      invalidate(sessionID);
      if (!explicitCommitRequest(promptText(input))) return { explicit: false };
      const scope = await resolveScope(sessionID);
      if (!scope || scope.sessionID !== sessionID || scope.mode === "advisor") return { explicit: false };
      const normalized = normalizeScope(scope);
      requests.set(sessionID, { scope: normalized });
      return { explicit: true, project: normalized.project };
    },

    observePreparationPermission(input) {
      if (!isCommitPreparationTool(input.action) || input.scope.mode === "advisor") return false;
      const call = commitPermissionCall(input.scope.sessionID, input.source);
      if (!call) return false;
      if (input.effect === "ask") {
        hostAsks.set(commitCallKey(call), normalizeScope(input.scope));
      } else if (input.effect !== "allow") {
        return false;
      }
      return true;
    },

    evaluateApprovalPermission(input, currentScope) {
      const call = commitPermissionCall(stringValue(input.sessionID), input.source);
      const resources = Array.isArray(input.resources) ? input.resources : [];
      if (!call || !currentScope || resources.some((item) => typeof item !== "string")) return false;
      const evidence = pending.get(commitCallKey(call));
      if (!evidence || !sameScope(evidence.scope, currentScope)
        || !sameStringArray(evidence.resources, resources as string[])) return false;
      input.effect = "ask";
      input.message = `Autoriza un commit local ordinario de ${evidence.paths.length} ruta(s) con subject «${evidence.subject}». La aprobación cubre únicamente el manifest exacto, sus gates, stage y commit local; no autoriza red ni operaciones de historia.`;
      return true;
    },

    async prepare(value, call, currentScope, approval, resolveScope) {
      if (call.agent !== "malahor") throw new Error("Solo el primario puede preparar un commit estructural.");
      const request = requests.get(call.sessionID);
      if (!request) throw new Error("No hay una orden explícita de commit vigente para esta sesión.");
      const scope = normalizeScope(currentScope);
      if (!sameScope(request.scope, scope) || call.sessionID !== scope.sessionID || scope.mode === "advisor") {
        requests.delete(call.sessionID);
        grants.delete(call.sessionID);
        throw new Error("La solicitud de commit ya no coincide con la sesión, proyecto, modo o política vigente.");
      }
      grants.delete(call.sessionID);
      // La validación estructural no consume autoridad: la orden sigue vigente
      // para una corrección del mismo turno y scope. Solo un manifest válido
      // consume la solicitud, justo antes de la aprobación nativa.
      const prepared = validatePreparation(value, scope.root);
      requests.delete(call.sessionID);
      const key = commitCallKey(call);
      const evidence = commitApprovalEvidence(scope, call, prepared);
      const hostScope = hostAsks.get(key);
      hostAsks.delete(key);
      if (hostScope) {
        if (!sameScope(hostScope, scope)) {
          throw new Error("La aprobación nativa previa del manifest pertenece a otro scope.");
        }
      } else {
        if (pending.has(key)) throw new Error("Ya existe una aprobación de commit pendiente para esta llamada.");
        pending.set(key, evidence);
        try {
          await approval.assert({
            sessionID: call.sessionID,
            agent: call.agent,
            source: { type: "tool", messageID: call.messageID, id: call.id },
            action: COMMIT_MANIFEST_APPROVAL,
            resources: evidence.resources,
            save: [],
          });
          if (!pending.has(key)) throw new Error("La aprobación del manifest fue invalidada antes de preparar el commit.");
        } finally {
          pending.delete(key);
        }
      }
      const freshScope = await resolveScope();
      if (!freshScope || !sameScope(scope, freshScope)) {
        throw new Error("El proyecto, modo o política cambió durante la aprobación del manifest.");
      }
      const freshPrepared = validatePreparation(value, normalizeScope(freshScope).root);
      if (!sameStringArray(evidence.resources, commitApprovalEvidence(scope, call, freshPrepared).resources)) {
        throw new Error("El manifest de commit cambió durante la aprobación nativa.");
      }
      grants.set(call.sessionID, {
        scope,
        commands: freshPrepared.sequence,
        cursor: 0,
        consumedCallKeys: new Set(),
      });
      return {
        paths: [...freshPrepared.paths],
        subject: freshPrepared.subject,
        commands: freshPrepared.sequence.length,
      };
    },

    authorizeShell(input) {
      const grant = grants.get(input.sessionID);
      if (!grant) return { effect: "absent" };
      const denyMismatch = (): CommitShellAuthorizationDecision => {
        invalidate(input.sessionID);
        return { effect: "deny", code: COMMIT_GRANT_MISMATCH };
      };
      let scope: CommitWorkflowScope;
      let cwd: string;
      try {
        scope = normalizeScope(input);
        cwd = canonicalDirectory(input.cwd);
      } catch {
        return denyMismatch();
      }
      const expected = grant.commands[grant.cursor];
      if (!input.valid || !expected || !sameScope(grant.scope, scope)
        || cwd !== grant.scope.root || input.command !== expected
        || !input.messageID.trim() || !input.toolCallID.trim()) {
        return denyMismatch();
      }

      const callKey = commitShellCallKey(input.messageID, input.toolCallID);
      let step = grant.inFlight;
      if (!step) {
        if (grant.consumedCallKeys.has(callKey)) return denyMismatch();
        step = {
          index: grant.cursor,
          command: input.command,
          messageID: input.messageID,
          toolCallID: input.toolCallID,
          permissionSeen: false,
          toolSeen: false,
        };
        grant.inFlight = step;
      } else if (step.index !== grant.cursor || step.command !== input.command
        || step.messageID !== input.messageID || step.toolCallID !== input.toolCallID) {
        return denyMismatch();
      }

      if (input.boundary === "permission") step.permissionSeen = true;
      else step.toolSeen = true;

      if (step.permissionSeen && step.toolSeen) {
        grant.consumedCallKeys.add(callKey);
        grant.cursor += 1;
        grant.inFlight = undefined;
        if (grant.cursor >= grant.commands.length) grants.delete(input.sessionID);
      }
      return { effect: "allow" };
    },

    invalidate,
  };
}

export async function registerCommitWorkflowTool(
  tools: CommitWorkflowTools,
  registry: CommitWorkflowRegistry,
  resolveScope: (sessionID: string) => Promise<CommitWorkflowScope | undefined>,
  approval: CommitWorkflowApprovalPort,
): Promise<{ dispose?: () => Promise<void> | void } | void> {
  return tools.transform((editor) => {
    editor.namespace({ name: "malahor", description: "Flujos estructurales de Malahor" });
    editor.add({
      name: "commit_prepare",
      description: "Consume una orden explícita de commit, valida el manifest exacto y solicita una única aprobación nativa antes de habilitar sus gates. No crea un plan ni usa go.",
      input: {
        type: "object",
        properties: {
          paths: { type: "array", minItems: 1, maxItems: 200, uniqueItems: true, items: { type: "string" } },
          subject: { type: "string" },
          commands: {
            type: "object",
            properties: {
              diagnostics: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } },
              tests: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } },
              build: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } },
              stage: { type: "string" },
              precommit: { type: "string" },
              commit: { type: "string" },
              verify: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } },
            },
            required: ["diagnostics", "tests", "build", "stage", "precommit", "commit", "verify"],
            additionalProperties: false,
          },
        },
        required: ["paths", "subject", "commands"],
        additionalProperties: false,
      },
      options: { namespace: "malahor", codemode: false },
      execute: async (value: unknown, call: ToolCall) => {
        const scope = await resolveScope(call.sessionID);
        if (!scope) throw new Error("Proyecto registrado/sesión no evaluable: commit bloqueado.");
        const result = await registry.prepare(
          value,
          call,
          scope,
          approval,
          () => resolveScope(call.sessionID),
        );
        return {
          content: `Flujo de commit estructural preparado para ${result.paths.length} ruta(s) y ${result.commands} comando(s) exactos. Ejecuta los gates en orden; cualquier diferencia invalida la autorización.`,
          metadata: {
            kind: "malahor.commit.grant",
            version: 1,
            paths: result.paths.length,
            commands: result.commands,
          },
        };
      },
    });
  });
}

export function isCommitPreparationTool(value: string): boolean {
  return PREPARE_TOOL_NAMES.has(value.trim().toLowerCase());
}

/**
 * Fuente canónica del comando en la frontera de permiso shell. El host puede
 * sanear `resources`; `metadata.command` conserva el comando exacto y debe
 * prevalecer, igual que en el adaptador de hooks.
 */
export function commitPermissionCommand(resources: readonly unknown[], metadata: Record<string, unknown>): string {
  const metadataCommand = typeof metadata.command === "string" ? metadata.command.trim()
    : typeof metadata.cmd === "string" ? metadata.cmd.trim() : "";
  if (metadataCommand) return metadataCommand;
  return resources.length === 1 && typeof resources[0] === "string" ? resources[0].trim() : "";
}

function validatePreparation(value: unknown, projectRoot: string): {
  paths: string[];
  subject: string;
  sequence: string[];
} {
  const input = exactRecord(value, ["paths", "subject", "commands"], "Manifest de commit inválido.");
  if (detectPayloadSecretKinds(JSON.stringify(input)).length > 0) {
    throw new Error("El manifest de commit contiene material sensible y no puede sellarse.");
  }
  const root = canonicalDirectory(projectRoot);
  const subject = requiredString(input.subject, "Subject de commit ausente.");
  if (!isValidCommitSubject(subject)) throw new Error("Subject de commit inválido o no prevalidado.");
  const rawPaths = stringArray(input.paths, 1, 200, "El commit requiere rutas exactas.");
  const paths = [...new Set(rawPaths.map((candidate) => validateCommitPath(candidate, root)))].sort(compareText);
  if (paths.length !== rawPaths.length) throw new Error("Las rutas del commit deben ser únicas y canónicas.");

  const commands = exactRecord(input.commands, [
    "diagnostics", "tests", "build", "stage", "precommit", "commit", "verify",
  ], "Comandos de commit incompletos.");
  const diagnostics = stringArray(commands.diagnostics, 1, 12, "Falta el diagnóstico del commit.");
  const tests = stringArray(commands.tests, 1, 12, "Faltan las pruebas del commit.");
  const build = stringArray(commands.build, 1, 12, "Falta el build del commit.");
  for (const command of [...diagnostics, ...tests, ...build]) validateGateCommand(command, root);
  const stage = requiredString(commands.stage, "Comando de stage ausente.");
  const precommit = requiredString(commands.precommit, "Comando precommit ausente.");
  const commit = requiredString(commands.commit, "Comando de commit ausente.");
  const verify = stringArray(commands.verify, 2, 2, "La revalidación requiere status y log exactos.");
  validateStageCommand(stage, paths, root);
  validatePrecommitCommand(precommit, subject);
  validateCommitCommand(commit, subject, root);
  validateVerifyCommands(verify, root);

  const sequence = [...diagnostics, ...tests, ...build, stage, precommit, commit, ...verify];
  if (new Set(sequence).size !== sequence.length) throw new Error("Cada comando del grant debe ocupar una etapa única.");
  return { paths, subject, sequence };
}

function validateCommitPath(value: string, root: string): string {
  const raw = value.normalize("NFC").trim();
  if (!raw || raw.includes("\0") || path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)
    || raw.startsWith("~") || /[*?\[\]{}]/.test(raw)) {
    throw new Error(`Ruta de commit no literal: ${raw || "<vacía>"}.`);
  }
  const absolute = path.resolve(root, raw);
  if (!inside(absolute, root) || absolute === root) throw new Error(`Ruta de commit fuera del proyecto: ${raw}.`);
  if (classifyInfrastructurePath(root, absolute).protected) {
    throw new Error(`La autorización estructural de commit no cubre infraestructura: ${raw}.`);
  }
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`El stage exacto requiere archivos regulares: ${raw}.`);
    if (!inside(fs.realpathSync(absolute), root)) throw new Error(`Ruta de commit resuelve fuera del proyecto: ${raw}.`);
  } else if (!trackedDeletion(root, raw)) {
    throw new Error(`La ruta de commit no existe ni es una eliminación tracked: ${raw}.`);
  }
  return path.relative(root, absolute).split(path.sep).join("/");
}

function validateGateCommand(command: string, root: string): void {
  const tokens = closedCommand(command);
  if (/[*?\[\]{}]/.test(command)) throw new Error("Los gates de commit no admiten expansión del shell.");
  if (!safeGateTokenPaths(tokens, root)) throw new Error("Un gate de commit referencia una ruta fuera del proyecto.");
  if (classifyInfrastructureCommand(command).protected) throw new Error("Los gates de commit no ejecutan infraestructura, publicación ni despliegue.");
  if (installationCommand(command)) throw new Error("Los gates de commit no instalan ni actualizan dependencias.");
  if (destructiveCommand(command)) throw new Error("Los gates de commit no admiten comandos destructivos.");
  const executable = executableName(tokens[0] ?? "");
  if (NETWORK_EXECUTABLES.has(executable)) throw new Error("Los gates de commit no contactan red.");
  if (tokens.some((token) => ["--fix", "--fix-dry-run", "--write", "--update", "--update-snapshot", "--update-snapshots"].includes(token))) {
    throw new Error("Los gates de commit no reescriben código ni snapshots.");
  }

  const git = classifyGitCommand(command, { aliases: loadGitAliases(root) });
  if (git.hasGitCommand) {
    if (git.remote || git.failClosed || git.destructive || git.operations.some((operation) => operation !== "read")) {
      throw new Error("Un gate de commit solo puede usar Git read-only.");
    }
    if (!classifyReadOnlyShellCommand(command, root, { workingDirectory: root }).readOnly) {
      throw new Error("Comando Git de diagnóstico no reconocido por la política cerrada.");
    }
    return;
  }
  if (!safeCheckInvocation(tokens, root)) throw new Error(`Gate de commit no reconocido: ${tokens[0] ?? "<vacío>"}.`);
}

function safeCheckInvocation(tokens: string[], root: string): boolean {
  const executable = executableName(tokens[0] ?? "");
  if (["bun", "npm", "pnpm", "yarn"].includes(executable)) {
    const args = tokens.slice(1);
    if (executable === "bun" && args[0] === "test") return true;
    if (["npm", "pnpm"].includes(executable) && args[0] === "test") return safePackageScript("test", root);
    if (executable === "yarn" && args[0] === "test") return safePackageScript("test", root);
    const runAt = args[0] === "run" ? 1 : executable === "yarn" ? 0 : -1;
    const script = runAt >= 0 ? args[runAt] : undefined;
    return Boolean(script && SAFE_SCRIPT_NAME.test(script) && safePackageScript(script, root));
  }
  if (!DIRECT_CHECK_EXECUTABLES.has(executable)) return false;
  if (["python", "python3"].includes(executable)) return tokens[1] === "-m" && ["pytest", "ruff"].includes(tokens[2] ?? "");
  if (executable === "node") return tokens.includes("--check") || tokens.some((token) => /(?:^|\/)(?:eslint|jest|tsc|vitest)(?:\.js)?$/.test(token));
  if (executable === "go") return ["test", "vet", "build"].includes(tokens[1] ?? "");
  if (executable === "cargo") return ["test", "check", "build", "clippy"].includes(tokens[1] ?? "");
  if (executable === "dotnet") return ["test", "build"].includes(tokens[1] ?? "");
  if (["mvn", "mvnw", "gradle", "gradlew", "make"].includes(executable)) {
    return tokens.slice(1).some((token) => SAFE_SCRIPT_NAME.test(token.replace(/^[-:]+/, "")));
  }
  return true;
}

function safeGateTokenPaths(tokens: string[], root: string): boolean {
  const canonicalRoot = fs.realpathSync(root);
  return tokens.every((token, index) => {
    const candidate = index === 0 ? token : token.startsWith("-") && token.includes("=")
      ? token.slice(token.indexOf("=") + 1)
      : token;
    if (!candidate || candidate.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      return !/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
    }
    const pathLike = path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)
      || candidate.startsWith(".") || candidate.startsWith("~")
      || candidate.includes("/") || candidate.includes("\\");
    if (!pathLike) return true;
    const absolute = path.resolve(root, candidate);
    if (!inside(absolute, canonicalRoot)) return false;
    const existing = nearestExistingPath(absolute);
    if (!existing) return false;
    try {
      return inside(fs.realpathSync(existing), canonicalRoot);
    } catch {
      return false;
    }
  });
}

function nearestExistingPath(target: string): string | undefined {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

function safePackageScript(name: string, root: string, seen = new Set<string>()): boolean {
  if (!SAFE_SCRIPT_NAME.test(name) || seen.has(name)) return false;
  const scripts = packageScripts(root);
  const body = scripts[name];
  if (!body || body.length > 8000) return false;
  if (classifyInfrastructureCommand(body).protected || installationCommand(body) || destructiveCommand(body)) return false;
  const git = classifyGitCommand(body, { aliases: loadGitAliases(root) });
  if (git.remote || git.failClosed || git.destructive
    || git.operations.some((operation) => !["read"].includes(operation))) return false;
  if (/\b(?:curl|wget|ssh|scp|sftp|nc|netcat|telnet|gh|glab)\b/i.test(body)) return false;
  const nested = [...body.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+run\s+([^\s;&|]+)/gi)]
    .map((match) => match[1]!)
    .filter((script) => !["test", "run"].includes(script));
  const next = new Set(seen).add(name);
  return nested.every((script) => script.includes("/") || script.includes("\\")
    ? safeLocalGateScript(script, root)
    : safePackageScript(script, root, next));
}

function safeLocalGateScript(value: string, root: string): boolean {
  if (value.includes("\0") || path.isAbsolute(value) || value.startsWith("~")) return false;
  const target = path.resolve(root, value);
  if (!inside(target, root) || !fs.existsSync(target)) return false;
  const base = path.basename(target).replace(/\.[a-z0-9]+$/i, "");
  if (!/^(?:build|compile|test|lint|check|typecheck|verify|diagnostic)(?:[-_.].*)?$/i.test(base)) return false;
  try {
    const content = fs.readFileSync(target, "utf8");
    if (content.length > 200_000 || classifyInfrastructureCommand(content).protected
      || installationCommand(content) || destructiveCommand(content)
      || /\b(?:curl|wget|ssh|scp|sftp|nc|netcat|telnet|gh|glab)\b/i.test(content)) return false;
    const git = classifyGitCommand(content, { aliases: loadGitAliases(root) });
    return !git.remote && !git.failClosed && !git.destructive
      && git.operations.every((operation) => operation === "read");
  } catch {
    return false;
  }
}

function validateStageCommand(command: string, paths: string[], root: string): void {
  const tokens = closedCommand(command);
  if (tokens[0] !== "git" || tokens[1] !== "add" || tokens[2] !== "--") {
    throw new Error("El stage debe usar `git add --` con rutas exactas.");
  }
  const staged = tokens.slice(3).map((candidate) => validateCommitPath(candidate, root));
  // `git add --` actúa sobre un conjunto: el orden textual no cambia el efecto.
  // Se exige el conjunto canónico exacto, sin duplicados ni rutas adicionales.
  const stagedSet = new Set(staged);
  if (staged.length !== paths.length || stagedSet.size !== staged.length
    || !paths.every((candidate) => stagedSet.has(candidate))) {
    throw new Error("El comando de stage no coincide exactamente con las rutas selladas.");
  }
  const classification = classifyGitCommand(command, { aliases: loadGitAliases(root) });
  if (classification.remote || classification.failClosed || classification.destructive
    || classification.operations.length !== 1 || classification.operations[0] !== "stage") {
    throw new Error("El grant solo admite un stage Git ordinario y exacto.");
  }
}

function validatePrecommitCommand(command: string, subject: string): void {
  const tokens = closedCommand(command);
  if (tokens[0] !== "malahor-ai" || tokens[1] !== "git" || tokens[2] !== "precommit") {
    throw new Error("El grant requiere `malahor-ai git precommit`.");
  }
  let message: string | undefined;
  let json = false;
  const seen = new Set<string>();
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--json") {
      if (seen.has(token)) throw new Error("Flag precommit duplicado.");
      seen.add(token);
      json = true;
      continue;
    }
    if (token === "--message") {
      if (seen.has(token) || !tokens[index + 1]) throw new Error("Opción precommit inválida.");
      seen.add(token);
      if (token === "--message") message = tokens[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Opción precommit no autorizada: ${token}.`);
  }
  if (!json || message !== subject) throw new Error("Precommit debe validar exactamente el subject sellado y devolver JSON.");
}

function validateCommitCommand(command: string, subject: string, root: string): void {
  const tokens = closedCommand(command);
  if (tokens[0] !== "git" || tokens[1] !== "commit") {
    throw new Error("El grant requiere un `git commit` ordinario.");
  }
  const messages: string[] = [];
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token !== "-m" && token !== "--message") throw new Error(`Opción de commit no autorizada: ${token}.`);
    const message = tokens[index + 1];
    if (!message) throw new Error("Cada -m del commit requiere texto literal.");
    messages.push(message);
    index += 1;
  }
  if (messages[0] !== subject) throw new Error("El commit final no conserva el subject sellado.");
  const classification = classifyGitCommand(command, { aliases: loadGitAliases(root) });
  if (classification.remote || classification.failClosed || classification.destructive
    || classification.operations.length !== 1 || classification.operations[0] !== "commit") {
    throw new Error("La autorización no cubre amend, stage implícito ni otras mutaciones Git.");
  }
}

function validateVerifyCommands(commands: string[], root: string): void {
  const subcommands = commands.map((command) => {
    const tokens = closedCommand(command);
    if (!classifyReadOnlyShellCommand(command, root, { workingDirectory: root }).readOnly) {
      throw new Error("La revalidación posterior debe ser Git read-only y cerrada.");
    }
    const git = tokens.indexOf("git");
    if (git < 0) throw new Error("La revalidación posterior requiere Git.");
    let index = git + 1;
    while (tokens[index]?.startsWith("-")) index += 1;
    return tokens[index];
  });
  if (subcommands[0] !== "status" || subcommands[1] !== "log") {
    throw new Error("La revalidación sellada debe ejecutar status y después log.");
  }
}

function explicitCommitRequest(value: string | undefined): boolean {
  if (!value) return false;
  if (value.trimStart().startsWith(COMMIT_COMMAND_MARKER)) return true;
  const normalized = value.normalize("NFD").replace(/\p{M}+/gu, "").trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
  if (!normalized || /[?¿]/.test(normalized) || /^(?:no|sin)\b/.test(normalized)) return false;
  const text = normalized.replace(/[.!]+$/g, "").trim();
  if (text === "/malahor-commit") return true;
  const polite = text.replace(/^por favor,?\s+/, "");
  return /^(?:commit|comitea(?:\s+(?:(?:el|este)\s+)?commit|\s+(?:(?:todos?|estos?|los|mis)\s+)?cambios)?|(?:haz|crea|realiza|ejecuta|genera)\s+(?:el\s+)?commit)$/.test(polite);
}

function promptText(input: Record<string, unknown>): string | undefined {
  if (typeof input.prompt === "string") return input.prompt;
  const prompt = recordValue(input.prompt);
  return stringValue(prompt?.text) ?? stringValue(input.text);
}

function closedCommand(command: string): string[] {
  const raw = requiredString(command, "Comando vacío.");
  if (raw.length > 8000 || /[\r\n]/.test(raw) || /[;&|<>`]/.test(raw)
    || /\$\(|\$\{|<\(|>\(/.test(raw)) throw new Error("Comando indirecto o compuesto no autorizado.");
  const tokens = shellTokens(raw);
  if (!tokens || tokens.length === 0) throw new Error("Comando no evaluable.");
  return tokens;
}

function shellTokens(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (quote === '"' && (character === "$" || character === "`")) return undefined;
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === "$" || (character === "~" && current.length === 0)) return undefined;
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (quote || escaped) return undefined;
  if (started) tokens.push(current);
  return tokens;
}

function normalizeScope(scope: CommitWorkflowScope): CommitWorkflowScope {
  const sessionID = requiredString(scope.sessionID, "Sesión de commit ausente.");
  const project = requiredString(scope.project, "Proyecto de commit ausente.");
  const policyRevision = requiredString(scope.policyRevision, "Revisión de política ausente.");
  if (!["advisor", "assistant", "executor"].includes(scope.mode)) throw new Error("Modo de commit inválido.");
  return { sessionID, project, policyRevision, mode: scope.mode, root: canonicalDirectory(scope.root) };
}

function sameScope(left: CommitWorkflowScope, right: CommitWorkflowScope): boolean {
  return left.sessionID === right.sessionID && left.project === right.project
    && left.policyRevision === right.policyRevision && left.mode === right.mode && left.root === right.root;
}

function canonicalDirectory(value: string): string {
  const resolved = path.resolve(requiredString(value, "Raíz de commit ausente."));
  const canonical = fs.realpathSync(resolved);
  if (!fs.statSync(canonical).isDirectory()) throw new Error("La raíz de commit no es un directorio.");
  return canonical;
}

function packageScripts(root: string): Record<string, string> {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: unknown };
    const scripts = recordValue(value.scripts);
    if (!scripts) return {};
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function trackedDeletion(root: string, relative: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relative], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function installationCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:--?[a-z0-9._-]+)(?:=[^\s]+)?\s+)*(?:add|i|install|remove|rm|un|uninstall|up|update|upgrade)\b/i.test(command)
    || /\b(?:python(?:3)?\s+-m\s+)?(?:pip|pip3|uv(?:\s+pip)?|gem|cargo|go)\s+(?:install|uninstall)\b/i.test(command)
    || /\b(?:apt(?:-get)?|dnf|yum|apk|brew|choco|winget)\s+(?:install|remove|uninstall|update|upgrade)\b/i.test(command)
    || /\bmalahor-ai\s+(?:install|uninstall|update|codegraph\s+setup)\b/i.test(command);
}

function destructiveCommand(command: string): boolean {
  return /\b(?:rm|rmdir|unlink|shred|truncate|mkfs(?:\.[a-z0-9]+)?|wipefs)\b/i.test(command)
    || /\bdd\s+[^;&|]*\bof=/i.test(command);
}

function executableName(value: string): string {
  return path.basename(value).replace(/\.exe$/i, "").replace(/^\.\//, "").toLowerCase();
}

function commitApprovalEvidence(
  scope: CommitWorkflowScope,
  call: CommitWorkflowCall,
  prepared: ReturnType<typeof validatePreparation>,
): CommitApprovalEvidence {
  const digest = createHash("sha256").update(JSON.stringify({
    paths: prepared.paths,
    subject: prepared.subject,
    sequence: prepared.sequence,
  })).digest("hex");
  return {
    scope: normalizeScope(scope),
    callKey: commitCallKey(call),
    resources: [digest, prepared.subject, ...prepared.paths],
    paths: [...prepared.paths],
    subject: prepared.subject,
  };
}

function commitPermissionCall(sessionID: string | undefined, value: unknown): CommitWorkflowCall | undefined {
  const source = recordValue(value);
  const messageID = stringValue(source?.messageID);
  const id = stringValue(source?.id);
  return source?.type === "tool" && sessionID && messageID && id
    ? { sessionID, agent: "malahor", messageID, id }
    : undefined;
}

function commitCallKey(call: CommitWorkflowCall): string {
  return [call.sessionID, call.messageID, call.id].join("\0");
}

function commitShellCallKey(messageID: string, toolCallID: string): string {
  return JSON.stringify([messageID, toolCallID]);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactRecord(value: unknown, keys: string[], message: string): Record<string, unknown> {
  const record = recordValue(value);
  if (!record || Object.keys(record).sort(compareText).join("\0") !== [...keys].sort(compareText).join("\0")) {
    throw new Error(message);
  }
  return record;
}

function stringArray(value: unknown, min: number, max: number, message: string): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(message);
  const strings = value.map((item) => requiredString(item, message));
  if (strings.some((item) => item.length > 8000)) throw new Error(message);
  return strings;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(message);
  return value.trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function inside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
