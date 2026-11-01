import path from "node:path";

import { registeredProjectRoots } from "../context";
import { resolvePaths, type MalahorPaths } from "../paths";
import { resolveProject } from "../project";
import { auditHookResult, runHooks } from "./engine";
import { loadHookPolicy } from "./policy-loader";
import { usesFilesystemResources } from "./resources";
import {
  CODE_MODE_TOOL_NAMES,
  isMcpToolName,
  type HookContext,
  type HookDecision,
  type HookEvent,
  type HookResourceKind,
  type HookResult,
  type HookViolation,
} from "./types";
import { parsePatchOperations } from "../documentation-boundary";

export type PermissionEffect = "allow" | "ask" | "deny";

export interface ResolvedSessionProject {
  canonicalKey: string;
  root: string;
}

export interface SessionProjectHints {
  directory?: string;
  projectHint?: string;
  targetPaths?: string[];
}

export interface PluginAdapterOptions {
  cwd: string;
  permissionRegistered?: boolean;
  shellRegistered?: boolean;
  toolRegistered?: boolean;
  resolveSessionDirectory?: (sessionID: string) => Promise<string | undefined>;
  resolveSessionProject?: (
    sessionID: string,
    hints?: SessionProjectHints,
  ) => Promise<ResolvedSessionProject | undefined>;
  resolveParentSession?: (sessionID: string) => Promise<{ parentID: string; agent: string } | undefined>;
  env?: NodeJS.ProcessEnv;
}

export interface PermissionAdapterResult {
  result: HookResult;
  effect: PermissionEffect;
}

export interface ShellAdapterResult {
  result: HookResult;
  env: Record<string, string | undefined>;
  timeout: number;
}

interface EvaluationDetails {
  event: HookEvent;
  cwd?: string;
  command?: string;
  resourceKind?: HookResourceKind;
  targetPaths?: string[];
  metadata?: Record<string, unknown>;
  destructive?: boolean;
}

interface EvaluationScope {
  options: PluginAdapterOptions;
  project?: ResolvedSessionProject;
  error?: string;
}

/**
 * Evaluador comun de los hooks V2. No conoce el SDK: recibe la forma estructural
 * que expone `@opencode/plugin` y la traduce al motor unico de hooks.
 */
export async function evaluatePermission(
  input: Record<string, unknown>,
  options: PluginAdapterOptions,
): Promise<PermissionAdapterResult> {
  const action = stringValue(input.action) || "unknown";
  const resources = stringArray(input.resources);
  const metadata = recordValue(input.metadata) ?? {};
  const generic = action === "*";
  const toolOrigin = recordValue(input.source)?.type === "tool";

  const details = permissionDetails(action, resources, metadata, options.toolRegistered === true && toolOrigin);
  const allowUnbound = ["question", "list", "todowrite", "todoread"].includes(action.toLowerCase());
  const scope = await resolveEvaluationScope(
    input, options, details.cwd, details.targetPaths, details.resourceKind, allowUnbound,
  );
  const built = scope.error ? undefined : buildContext(details.event, scope.options, {
    command: details.command,
    resourceKind: details.resourceKind,
    targetPaths: details.targetPaths,
    metadata: {
      ...metadata,
      ...details.metadata,
      origin: "opencode-v2",
      action,
      ...(generic ? { genericPermission: true } : {}),
    },
  }, scope.project);

  const result = built?.context
    ? evaluate(built.context)
    : policyFailure(details.event, scope.options, scope.error ?? built?.error ?? "politica no evaluable", scope.project);
  const hostEffect = permissionEffect(input.effect);
  const effect = strongerEffect(hostEffect, decisionEffect(result.decision));

  if (effect !== hostEffect || result.decision !== "allow") {
    input.effect = effect;
  }
  const message = pluginMessage(result);
  if (message && effect !== "allow") {
    input.message = mergeMessage(input.message, message);
  }

  return { result, effect };
}

export async function evaluateToolHook(
  input: Record<string, unknown>,
  options: PluginAdapterOptions,
): Promise<HookResult> {
  const tool = stringValue(input.tool) || "unknown";
  const toolInput = input.input;
  const mapped = toolDetails(tool, toolInput, options);

  const allowUnbound = ["question", "list", "todowrite", "todoread"].includes(tool.toLowerCase());
  const scope = await resolveEvaluationScope(
    input, options, mapped.cwd, mapped.targetPaths, mapped.resourceKind, allowUnbound,
  );
  const built = scope.error ? undefined : buildContext(mapped.event, scope.options, {
    command: mapped.command,
    resourceKind: mapped.resourceKind,
    targetPaths: mapped.targetPaths,
    metadata: {
      ...mapped.metadata,
      origin: "opencode-v2",
      tool,
    },
  }, scope.project);

  return built?.context
    ? evaluate(built.context)
    : policyFailure(mapped.event, scope.options, scope.error ?? built?.error ?? "politica no evaluable", scope.project);
}

export async function evaluateShellHook(
  input: Record<string, unknown>,
  options: PluginAdapterOptions,
): Promise<ShellAdapterResult> {
  const command = stringValue(input.command) || "";
  const originalTimeout = numberValue(input.timeout, 0);
  const env: Record<string, string | undefined> = {};
  const rawEnv = recordValue(input.env);
  if (rawEnv) {
    for (const [key, value] of Object.entries(rawEnv)) {
      if (typeof value === "string" || value === undefined) env[key] = value;
    }
  }
  let timeout = originalTimeout;
  let envChanged = false;
  let timeoutChanged = false;

  const scope = await resolveEvaluationScope(input, options, stringValue(input.cwd));
  const built = scope.error ? undefined : buildContext("shell.exec.before", scope.options, {
    command,
    metadata: {
      origin: "opencode-v2",
      shell: stringValue(input.shell),
      cwd: scope.options.cwd,
      timeoutSeconds: timeout,
    },
  }, scope.project);

  if (!built?.context) {
    return {
      result: policyFailure("shell.exec.before", scope.options, scope.error ?? built?.error ?? "politica no evaluable", scope.project),
      env,
      timeout,
    };
  }

  const controls = built.context.security?.shell;
  if (controls) {
    if (controls.denyCredentialEnv === true) {
      for (const key of Object.keys(env)) {
        if (isCredentialEnvKey(key)) {
          delete env[key];
          envChanged = true;
        }
      }
    }
    if (controls.minimizeEnvironment === true) {
      for (const key of Object.keys(env)) {
        if (!isSafeEnvKey(key)) {
          delete env[key];
          envChanged = true;
        }
      }
    }
    if (controls.enforceTimeout === true && controls.timeoutSeconds && (timeout <= 0 || timeout > controls.timeoutSeconds)) {
      timeout = controls.timeoutSeconds;
      timeoutChanged = true;
      built.context.metadata = { ...built.context.metadata, timeoutSeconds: timeout };
    }
  }

  let result = runHooks(built.context);
  if (envChanged) {
    result = appendViolation(result, {
      id: "MAL-HOOK-SHELL-ENV",
      decision: "warn",
      message: "Se retiraron variables de entorno sensibles antes de ejecutar.",
      fix: "No pases credenciales por entorno; usa un gestor de secretos o un canal aprobado.",
    });
  }
  if (timeoutChanged) {
    result = appendViolation(result, {
      id: "MAL-HOOK-SHELL-TIMEOUT-CLAMP",
      decision: "warn",
      message: `Timeout ajustado al maximo de politica (${timeout}s).`,
      fix: "Define timeouts explicitos dentro del maximo administrado.",
    });
  }
  result = auditHookResult(built.context, result);

  return { result, env, timeout };
}

export async function evaluateSessionHook(
  event: HookEvent,
  input: Record<string, unknown>,
  options: PluginAdapterOptions,
): Promise<HookResult> {
  const model = recordValue(input.model);
  const request = recordValue(input.request);
  const metadata: Record<string, unknown> = {
    origin: "opencode-v2",
    providerID: stringValue(model?.providerID),
    kind: stringValue(input.kind),
  };
  const baseURL = stringValue(input.baseURL);
  const requestURL = stringValue(request?.url);
  if (baseURL) metadata.url = baseURL;
  if (requestURL) metadata.url = requestURL;
  const contentEvent = event === "session.prompt.before"
    || event === "session.context.before"
    || event === "session.compaction.before"
    || event === "session.generate.before"
    || event === "session.title.before";
  const secretKinds = contentEvent ? detectSecretKinds(input) : [];
  if (secretKinds.length > 0) {
    metadata.secretDetected = true;
    metadata.secretKinds = secretKinds;
  }

  const scope = await resolveEvaluationScope(input, options, undefined, undefined, undefined, true);
  const built = scope.error ? undefined : buildContext(event, scope.options, { metadata }, scope.project);
  return built?.context
    ? evaluate(built.context)
    : policyFailure(event, scope.options, scope.error ?? built?.error ?? "politica no evaluable", scope.project);
}

export function shouldBlockPluginResult(result: HookResult, options: PluginAdapterOptions, blockingAskIds: string[] = []): boolean {
  if (result.decision === "deny") return true;
  if (result.decision !== "ask") return false;
  if (blockingAskIds.some((id) => result.violations.some((violation) => violation.id === id))) return true;
  return options.permissionRegistered !== true;
}

export function formatPluginBlock(result: HookResult): string {
  return [
    `Malahor bloqueo ${result.event}: ${result.decision.toUpperCase()}`,
    ...result.violations
      .filter((violation) => violation.decision === "deny" || violation.decision === "ask")
      .map((violation) => `- ${violation.id}: ${violation.message}`),
  ].join("\n");
}

function evaluate(context: HookContext): HookResult {
  return auditHookResult(context, runHooks(context));
}

async function resolveEvaluationScope(
  input: Record<string, unknown>,
  options: PluginAdapterOptions,
  operationCwd?: string,
  targetPaths?: string[],
  resourceKind?: HookResourceKind,
  allowUnbound = false,
): Promise<EvaluationScope> {
  const fallback = path.resolve(options.cwd);
  const operationDirectory = operationCwd ? path.resolve(fallback, operationCwd) : undefined;
  const sessionID = stringValue(input.sessionID);

  if (options.resolveSessionProject && sessionID) {
    try {
      const project = await options.resolveSessionProject(sessionID, {
        ...(operationDirectory ? { directory: operationDirectory } : {}),
        ...(targetPaths?.length ? { targetPaths } : {}),
      });
      if (!project) {
        if (allowUnbound) return { options: { ...options, cwd: fallback } };
        return {
          options: { ...options, cwd: fallback },
          error: `la sesion ${sessionID} no tiene afinidad de proyecto inequívoca`,
        };
      }
      if (operationDirectory && !isWithinPath(operationDirectory, project.root)) {
        return {
          options: { ...options, cwd: fallback },
          project,
          error: `el directorio de operacion no pertenece al proyecto ${project.canonicalKey}`,
        };
      }
      const cwd = operationDirectory ?? path.resolve(project.root);
      const conflict = conflictingProjectTarget(cwd, targetPaths, resourceKind, project, options);
      if (conflict) {
        return {
          options: { ...options, cwd },
          project,
          error: `la operacion de ${project.canonicalKey} apunta a la raiz registrada de ${conflict}`,
        };
      }
      return { options: { ...options, cwd }, project };
    } catch (error) {
      if (allowUnbound) return { options: { ...options, cwd: fallback } };
      return {
        options: { ...options, cwd: fallback },
        error: `no se pudo resolver el proyecto de la sesion ${sessionID}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (operationDirectory) return { options: { ...options, cwd: operationDirectory } };

  if (!options.resolveSessionDirectory) {
    return { options: { ...options, cwd: fallback } };
  }

  if (!sessionID) {
    return {
      options: { ...options, cwd: fallback },
      error: "el hook no expuso sessionID para resolver la ubicacion de la sesion",
    };
  }

  try {
    const directory = await options.resolveSessionDirectory(sessionID);
    if (!directory) {
      return {
        options: { ...options, cwd: fallback },
        error: `la sesion ${sessionID} no expuso una ubicacion evaluable`,
      };
    }
    return { options: { ...options, cwd: path.resolve(directory) } };
  } catch (error) {
    return {
      options: { ...options, cwd: fallback },
      error: `no se pudo resolver la ubicacion de la sesion ${sessionID}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function buildContext(
  event: HookEvent,
  options: PluginAdapterOptions,
  details: Omit<EvaluationDetails, "event">,
  boundProject?: ResolvedSessionProject,
): { context?: HookContext; error?: string } {
  const cwd = path.resolve(options.cwd);
  const env = options.env ?? process.env;

  try {
    const paths = pluginPaths(cwd, env);
    const project = boundProject
      ? { ...resolveProject(boundProject.root), canonicalKey: boundProject.canonicalKey, root: boundProject.root }
      : resolveOperationProject(cwd, details.resourceKind, details.targetPaths, paths);
    const loaded = loadHookPolicy(paths, project.canonicalKey);
    const context: HookContext = {
      event,
      harness: "opencode",
      profile: loaded.policy.profile,
      cwd,
      projectRoot: project.root,
      malahorHome: paths.malahorHome,
      project: project.canonicalKey,
      policy: loaded.policy,
      security: loaded.security,
      policyMeta: loaded.policyMeta,
      command: details.command,
      resourceKind: details.resourceKind,
      targetPaths: details.targetPaths,
      destructive: details.destructive,
      audit: {
        enabled: true,
        required: loaded.security.audit?.required === true || loaded.security.audit?.failClosedIfUnavailable === true,
      },
      metadata: details.metadata,
    };
    return { context };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function policyFailure(
  event: HookEvent,
  options: PluginAdapterOptions,
  detail: string,
  boundProject?: ResolvedSessionProject,
): HookResult {
  const result: HookResult = {
    event,
    profile: "off",
    decision: "deny",
    violations: [{
      id: "MAL-HOOK-PLUGIN-POLICY",
      decision: "deny",
      message: `Politica runtime no evaluable: ${detail}`,
      fix: "Corrige la politica efectiva o el entorno antes de ejecutar la operacion protegida.",
    }],
  };

  try {
    const cwd = path.resolve(options.cwd);
    const paths = pluginPaths(cwd, options.env ?? process.env);
    const project = boundProject
      ? { ...resolveProject(boundProject.root), canonicalKey: boundProject.canonicalKey, root: boundProject.root }
      : resolveProject(cwd);
    const context: HookContext = {
      event,
      harness: "opencode",
      profile: "off",
      cwd,
      projectRoot: project.root,
      malahorHome: paths.malahorHome,
      project: project.canonicalKey,
      audit: { enabled: true },
      metadata: { origin: "opencode-v2" },
    };
    return auditHookResult(context, result);
  } catch {
    return result;
  }
}

function pluginPaths(cwd: string, env: NodeJS.ProcessEnv): MalahorPaths {
  // El plugin no debe lanzar `opencode api get` por cada hook: la deteccion
  // interactiva es exclusiva de la CLI.
  return resolvePaths({ ...env, MALAHOR_OPENCODE_DETECT: "0" }, cwd);
}

function resolveOperationProject(
  cwd: string,
  resourceKind: HookResourceKind | undefined,
  targetPaths: string[] | undefined,
  paths: MalahorPaths,
): ReturnType<typeof resolveProject> {
  const candidates = registeredProjectRoots(paths.projectsFile)
    .sort((left, right) => right.root.length - left.root.length);
  const absoluteTargets = usesFilesystemResources(resourceKind)
    ? (targetPaths ?? []).map((target) => path.resolve(cwd, target))
    : [];
  const candidate = candidates.find((entry) => (
    isWithinPath(cwd, entry.root) || absoluteTargets.some((target) => isWithinPath(target, entry.root))
  ));
  if (!candidate) return resolveProject(cwd);

  const resolved = resolveProject(candidate.root);
  return { ...resolved, canonicalKey: candidate.canonicalKey };
}

function conflictingProjectTarget(
  cwd: string,
  targetPaths: string[] | undefined,
  resourceKind: HookResourceKind | undefined,
  project: ResolvedSessionProject,
  options: PluginAdapterOptions,
): string | undefined {
  if (!usesFilesystemResources(resourceKind) || !targetPaths?.length) return undefined;
  const paths = pluginPaths(cwd, options.env ?? process.env);
  const roots = registeredProjectRoots(paths.projectsFile);
  const targets = targetPaths.map((target) => path.resolve(cwd, target));
  return roots.find((entry) => entry.canonicalKey !== project.canonicalKey
    && targets.some((target) => isWithinPath(target, entry.root)))?.canonicalKey;
}

function isWithinPath(value: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function permissionDetails(
  action: string,
  resources: string[],
  metadata: Record<string, unknown>,
  deferToolWrite: boolean,
): EvaluationDetails {
  const normalized = action.toLowerCase();
  const metadataCommand = stringValue(metadata.command) || stringValue(metadata.cmd);

  if (normalized === "bash" || normalized === "shell" || normalized === "command") {
    return {
      event: "shell.exec.before",
      command: metadataCommand || resources.join(" "),
      metadata: { ...metadata, tool: "bash" },
    };
  }

  if (normalized === "read" || normalized === "glob" || normalized === "grep") {
    return { event: "file.read.before", resourceKind: "filesystem", targetPaths: resources, metadata };
  }

  if (["edit", "write", "patch", "create"].includes(normalized) && deferToolWrite) {
    return {
      event: "plugin.permission.before",
      resourceKind: "filesystem",
      targetPaths: resources,
      metadata: { ...metadata, knownTool: true, deferredToToolHook: true },
    };
  }

  if (normalized === "edit" || normalized === "write" || normalized === "patch" || normalized === "create") {
    return { event: "file.write.before", resourceKind: "filesystem", targetPaths: resources, metadata };
  }

  if (normalized === "webfetch" || normalized === "fetch" || normalized === "http") {
    return {
      event: "session.http-request.before",
      metadata: { ...metadata, url: resources[0] ?? stringValue(metadata.url) },
    };
  }

  if (normalized === "external_directory") {
    return {
      event: metadata.write === true ? "file.write.before" : "file.read.before",
      resourceKind: "filesystem",
      targetPaths: resources,
      metadata,
    };
  }

  if (CODE_MODE_TOOL_NAMES.has(normalized)) {
    return { event: "tool.execute.before", metadata: { ...metadata, tool: normalized } };
  }

  if (normalized === "task" || isMcpToolName(normalized)) {
    return {
      event: "tool.execute.before",
      command: action.replace(/[_.:/-]+/g, " "),
      metadata: { ...metadata, tool: normalized === "task" ? "task" : action },
    };
  }

  if (normalized === "skill") {
    return { event: "tool.execute.before", metadata: { ...metadata, tool: "skill" } };
  }

  // Tools conocidas sin efecto propio (todo, question, list) no se convierten
  // en ask: su mediacion real ocurre en tool/shell/file cuando aplica.
  if (KNOWN_TOOLS.has(normalized)) {
    return { event: "plugin.permission.before", metadata: { ...metadata, action, knownTool: true } };
  }

  if (deferToolWrite) {
    return {
      event: "tool.execute.before",
      command: action.replace(/[_.:/-]+/g, " "),
      metadata: { ...metadata, tool: action, deferredToToolHook: true },
    };
  }

  return { event: "plugin.permission.before", metadata: { ...metadata, action } };
}

function toolDetails(tool: string, input: unknown, options: PluginAdapterOptions): EvaluationDetails {
  const normalized = tool.toLowerCase();
  const args = recordValue(input) ?? {};

  if (normalized === "bash") {
    if (options.shellRegistered) {
      return { event: "tool.execute.before", metadata: { tool } };
    }
    return {
      event: "shell.exec.before",
      cwd: stringValue(args.cwd) || stringValue(args.workdir),
      command: stringValue(args.command) || stringValue(args.cmd),
      metadata: { tool, timeoutSeconds: numberValue(args.timeout, 0) },
    };
  }

  if (normalized === "read" || normalized === "glob" || normalized === "grep") {
    return { event: "file.read.before", resourceKind: "filesystem", targetPaths: pathValues(args), metadata: { tool } };
  }

  if (normalized === "patch") {
    const patchText = stringValue(args.patchText) ?? "";
    const fileOperations = parsePatchOperations(patchText);
    return {
      event: "file.write.before",
      resourceKind: "filesystem",
      targetPaths: fileOperations.map((operation) => operation.path),
      metadata: { tool, fileOperations },
    };
  }

  if (normalized === "write" || normalized === "edit") {
    const targetPaths = pathValues(args);
    return {
      event: "file.write.before",
      resourceKind: "filesystem",
      targetPaths,
      metadata: { tool, fileOperations: targetPaths.map((targetPath) => ({ kind: "write", path: targetPath })) },
    };
  }

  if (normalized === "webfetch") {
    return {
      event: "session.http-request.before",
      metadata: { tool, url: stringValue(args.url) },
    };
  }

  return {
    event: "tool.execute.before",
    command: tool.replace(/[_.:/-]+/g, " "),
    metadata: { tool },
  };
}

const KNOWN_TOOLS = new Set([
  "todowrite",
  "todoread",
  "list",
  "question",
  "invalid",
]);

function pathValues(value: unknown): string[] {
  const record = recordValue(value);
  if (!record) return [];

  const direct = ["filePath", "file_path", "path", "targetPath", "target_path", "directory"]
    .map((key) => stringValue(record[key]))
    .filter((item): item is string => Boolean(item));
  const arrays = ["paths", "files"].flatMap((key) => stringArray(record[key]));
  const nested = ["arguments", "args", "input"].flatMap((key) => pathValues(record[key]));

  return [...new Set([...direct, ...arrays, ...nested])];
}

const PRIVATE_KEY_PATTERN = new RegExp(["-----BEGIN", "(RSA |OPENSSH |EC |DSA )?PRIVATE", "KEY-----"].join(" "));

export function detectSecretKinds(value: unknown): string[] {
  const text = collectStrings(value).join("\n");
  if (!text) return [];

  const kinds: string[] = [];
  if (PRIVATE_KEY_PATTERN.test(text)) kinds.push("private-key");
  if (/\b(AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) kinds.push("aws-access-key");
  if (/(api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[:=]\s*["'][^\r\n"']{16,}["']/i.test(text)) {
    kinds.push("credential-assignment");
  }
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/.test(text)) kinds.push("bearer-token");
  return kinds;
}

function collectStrings(value: unknown, depth = 0, output: string[] = []): string[] {
  if (depth > 6 || output.length >= 500) return output;
  if (typeof value === "string") {
    if (value.length <= 20000) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, depth + 1, output);
    return output;
  }
  const record = recordValue(value);
  if (record) {
    for (const item of Object.values(record)) collectStrings(item, depth + 1, output);
  }
  return output;
}

function appendViolation(result: HookResult, violation: HookViolation): HookResult {
  const violations = [...result.violations, violation];
  return {
    ...result,
    violations,
    decision: strongestDecision(violations),
  };
}

function strongestDecision(violations: HookViolation[]): HookDecision {
  const weight: Record<HookDecision, number> = { allow: 0, warn: 1, ask: 2, deny: 3 };
  return violations.reduce<HookDecision>((current, violation) => (
    weight[violation.decision] > weight[current] ? violation.decision : current
  ), "allow");
}

function decisionEffect(decision: HookDecision): PermissionEffect {
  if (decision === "deny") return "deny";
  if (decision === "ask") return "ask";
  return "allow";
}

function permissionEffect(value: unknown): PermissionEffect {
  return value === "deny" || value === "ask" ? value : "allow";
}

function strongerEffect(left: PermissionEffect, right: PermissionEffect): PermissionEffect {
  const weight: Record<PermissionEffect, number> = { allow: 0, ask: 1, deny: 2 };
  return weight[right] > weight[left] ? right : left;
}

function pluginMessage(result: HookResult): string | null {
  const relevant = result.violations.filter((violation) => violation.decision === "deny" || violation.decision === "ask");
  if (relevant.length === 0) return null;
  return `[malahor] ${relevant.map((violation) => `${violation.id}: ${violation.message}`).join("; ")}`;
}

function mergeMessage(current: unknown, next: string): string {
  const prefix = stringValue(current);
  return prefix ? `${prefix} ${next}` : next;
}

function isCredentialEnvKey(key: string): boolean {
  return /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|session|cookie|aws_|azure_|gcp_|google_|github_|gitlab_|npm_)/i.test(key);
}

function isSafeEnvKey(key: string): boolean {
  return /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|NO_COLOR|LANG|LC_.*|TZ|TMPDIR|PWD|XDG_.*|CI|NODE_ENV|BUN_ENV)$/.test(key);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
