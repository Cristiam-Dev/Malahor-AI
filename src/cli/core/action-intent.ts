import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ACTION_INTENT_CANONICALIZER = "action-intent-v1" as const;

export type ActionIntentKind = "edit" | "shell" | "subagent";
export type ActionIntentEffect = "write" | "execute" | "delegate";
export type ActionIntentExistence = "must-exist" | "may-create";

export interface ActionIntentFilesystemResource {
  kind: "filesystem";
  canonicalPath: string;
  relativePath: string;
  access: "read" | "write";
  existence: ActionIntentExistence;
  sandbox?: boolean;
}

export interface ActionIntentCommand {
  executable: string;
  argv: string[];
  cwd: string;
  composition: "single" | "and-sequence";
}

export interface ActionIntentEnvironment {
  key: string;
  source: "host-managed" | "literal-nonsecret";
  valueDigest?: string;
}

export interface ActionIntentV1 {
  schema: 1;
  canonicalizer: typeof ACTION_INTENT_CANONICALIZER;
  actionID: string;
  kind: ActionIntentKind;
  effect: ActionIntentEffect;
  project: string;
  rootRef: string;
  rootDigest: string;
  resources: ActionIntentFilesystemResource[];
  command?: ActionIntentCommand;
  filesystem?: {
    readRoots: string[];
    writePaths: string[];
    createPaths: string[];
    sandboxWriteRoots: string[];
  };
  network?: "forbidden";
  environment?: ActionIntentEnvironment[];
  delegate?: {
    agent: "malahor-diagnostico" | "malahor-testing";
  };
  constraints: {
    remote: false;
    infrastructure: false;
    protectedOperation?: string;
  };
}

export interface PlannedActionLike {
  action: string;
  resource: string;
}

export interface PlannedActionIntentContext {
  project: string;
  root: string;
  rootRef?: string;
  plannedCwd?: string;
  cwd?: string;
  sandboxWriteRoots?: string[];
}

export interface ActionIntentRepairV1 {
  schema: 1;
  kind: "git-stage-manifest";
  sourceActionID: string;
  repairedActionID: string;
  relation: "equal" | "narrower";
  manifest: string[];
  manifestHash: string;
  repairedInputHash: string;
}

export class ActionIntentError extends Error {
  readonly code: "ACTION_NOT_CANONICALIZABLE" | "RESOURCE_OUTSIDE_SCOPE";

  constructor(code: ActionIntentError["code"], message: string) {
    super(message);
    this.name = "ActionIntentError";
    this.code = code;
  }
}

/**
 * Convierte una acción estructurada en uno o más efectos atómicos. Shell V1
 * solo admite comandos literales y secuencias `&&`; cada segmento obtiene su
 * propio actionID para que split/join conserven exactamente la misma secuencia.
 */
export function canonicalizeActionIntent(input: Record<string, unknown>): ActionIntentV1[] {
  const kind = input.kind;
  if (kind !== "edit" && kind !== "shell" && kind !== "subagent") {
    throw canonicalizationError("Tipo de acción no soportado por ActionIntentV1.");
  }
  const project = requiredText(input.project, "Proyecto no evaluable.", 256);
  const root = canonicalRoot(requiredText(input.root, "Raíz de acción no evaluable.", 8_192));
  const rootRef = requiredText(input.rootRef ?? "project", "Referencia de raíz no evaluable.", 256);
  const rootDigest = sha256(root);
  const constraints = normalizeConstraints(input.constraints);

  if (kind === "edit") {
    const target = requiredText(input.path, "Ruta de edición no evaluable.", 8_192);
    const existence = input.existence === "may-create" ? "may-create"
      : input.existence === "must-exist" || input.existence === undefined ? "must-exist"
        : undefined;
    if (!existence) throw canonicalizationError("Contrato de existencia no evaluable.");
    const resource = filesystemResource(target, root, "write", existence);
    return [sealIntent({
      schema: 1,
      canonicalizer: ACTION_INTENT_CANONICALIZER,
      kind,
      effect: "write",
      project,
      rootRef,
      rootDigest,
      resources: [resource],
      constraints,
    })];
  }

  if (kind === "subagent") {
    const agent = input.agent;
    if (agent !== "malahor-diagnostico" && agent !== "malahor-testing") {
      throw canonicalizationError("El especialista no está gestionado por Malahor.");
    }
    return [sealIntent({
      schema: 1,
      canonicalizer: ACTION_INTENT_CANONICALIZER,
      kind,
      effect: "delegate",
      project,
      rootRef,
      rootDigest,
      resources: [],
      delegate: { agent },
      constraints,
    })];
  }

  const command = requiredText(input.command, "Comando shell no evaluable.", 16_384);
  const cwd = canonicalPathInsideRoot(
    typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : root,
    root,
    "El cwd queda fuera de la raíz autorizada.",
  );
  if (input.network !== undefined && input.network !== "forbidden") {
    throw canonicalizationError("ActionIntentV1 no autoriza red.");
  }
  const filesystem = normalizeFilesystem(input.filesystem, root);
  const resources = filesystemResources(filesystem, root);
  const environment = normalizeEnvironment(input.environment);
  const segments = parseClosedShell(command);

  return segments.map(({ executable, argv }) => sealIntent({
    schema: 1,
    canonicalizer: ACTION_INTENT_CANONICALIZER,
    kind,
    effect: "execute",
    project,
    rootRef,
    rootDigest,
    resources,
    command: { executable, argv, cwd, composition: "single" },
    filesystem,
    network: "forbidden",
    environment,
    constraints,
  }));
}

/** Crea intents canónicos para las acciones firmadas por la tool de planning. */
export function canonicalizePlannedActions(
  actions: readonly PlannedActionLike[],
  context: PlannedActionIntentContext,
): ActionIntentV1[] {
  const output: ActionIntentV1[] = [];
  for (const action of actions) {
    output.push(...canonicalizePlannedAction(action, context));
  }
  return output;
}

export function canonicalizePlannedAction(
  action: PlannedActionLike,
  context: PlannedActionIntentContext,
): ActionIntentV1[] {
  const base = {
    project: context.project,
    root: context.root,
    rootRef: context.rootRef ?? "project",
    constraints: { remote: false, infrastructure: false },
  } as const;
  if (action.action === "edit") {
    return canonicalizeActionIntent({
      ...base,
      kind: "edit",
      path: action.resource,
      existence: pathExistsWithoutFollowingSymlink(action.resource, context.root) ? "must-exist" : "may-create",
    });
  }
  if (action.action === "shell") {
    return canonicalizeActionIntent({
      ...base,
      kind: "shell",
      command: action.resource,
      cwd: context.cwd ?? context.root,
      filesystem: {
        readRoots: [context.root],
        writePaths: [],
        createPaths: [],
        sandboxWriteRoots: context.sandboxWriteRoots ?? [],
      },
      network: "forbidden",
      environment: [],
    });
  }
  if (action.action === "subagent") {
    return canonicalizeActionIntent({ ...base, kind: "subagent", agent: action.resource });
  }
  throw canonicalizationError("Acción de plan no soportada por ActionIntentV1.");
}

/**
 * Reconoce la reparación cerrada de un `git add` con directorios a un manifest
 * literal de archivos. La variante reparada solo puede conservar o estrechar
 * el conjunto revisado y mantiene proyecto, raíz y cwd.
 */
export function deriveActionIntentRepair(
  planned: PlannedActionLike,
  actual: PlannedActionLike,
  context: PlannedActionIntentContext,
): ActionIntentRepairV1 | undefined {
  if (planned.action !== "shell" || actual.action !== "shell") return undefined;
  try {
    const root = canonicalRoot(context.root);
    const plannedCwd = context.plannedCwd ?? root;
    const plannedIntents = canonicalizePlannedAction(planned, { ...context, root, cwd: plannedCwd });
    const actualIntents = canonicalizePlannedAction(actual, {
      ...context,
      root,
      cwd: context.cwd ?? plannedCwd,
    });
    if (plannedIntents.length !== 1 || actualIntents.length !== 1) return undefined;
    const source = plannedIntents[0]!;
    const repaired = actualIntents[0]!;
    if (source.actionID === repaired.actionID || !sameRepairEnvelope(source, repaired)) return undefined;
    const plannedTargets = gitStageTargets(source);
    const actualTargets = gitStageTargets(repaired);
    if (!plannedTargets || !actualTargets) return undefined;
    if (!hasLiteralStageDirectory(plannedTargets, root, source.command!.cwd)) return undefined;
    const plannedManifest = stageManifest(plannedTargets, root, source.command!.cwd, true);
    const manifest = stageManifest(actualTargets, root, repaired.command!.cwd, false);
    if (plannedManifest.length === 0 || manifest.length === 0 || !subset(manifest, plannedManifest)) return undefined;
    const relation = sameTextSequence(manifest, plannedManifest) ? "equal" : "narrower";
    const manifestHash = hashReference(canonical(manifest));
    const repairedInputHash = hashReference(canonical({
      kind: "git-stage-manifest",
      sourceActionID: source.actionID,
      repairedActionID: repaired.actionID,
      relation,
      manifestHash,
    }));
    return {
      schema: 1,
      kind: "git-stage-manifest",
      sourceActionID: source.actionID,
      repairedActionID: repaired.actionID,
      relation,
      manifest,
      manifestHash,
      repairedInputHash,
    };
  } catch {
    return undefined;
  }
}

export function validActionIntentRepair(value: unknown, rootValue: string): value is ActionIntentRepairV1 {
  if (!isRecord(value) || value.schema !== 1 || value.kind !== "git-stage-manifest"
    || typeof value.sourceActionID !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceActionID)
    || typeof value.repairedActionID !== "string" || !/^[a-f0-9]{64}$/.test(value.repairedActionID)
    || value.sourceActionID === value.repairedActionID
    || (value.relation !== "equal" && value.relation !== "narrower")
    || !Array.isArray(value.manifest) || value.manifest.length === 0 || value.manifest.length > 512
    || value.manifest.some((item) => typeof item !== "string")
    || typeof value.manifestHash !== "string" || typeof value.repairedInputHash !== "string") return false;
  try {
    const root = canonicalRoot(rootValue);
    const manifest = value.manifest as string[];
    if (!sameTextSequence(manifest, [...new Set(manifest)].sort(compareText))) return false;
    if (!sameTextSequence(manifest, stageManifest(manifest, root, root, false))) return false;
    const manifestHash = hashReference(canonical(manifest));
    if (value.manifestHash !== manifestHash) return false;
    const repairedInputHash = hashReference(canonical({
      kind: value.kind,
      sourceActionID: value.sourceActionID,
      repairedActionID: value.repairedActionID,
      relation: value.relation,
      manifestHash,
    }));
    return value.repairedInputHash === repairedInputHash;
  } catch {
    return false;
  }
}

/**
 * Compatibilidad interna para callers del core que todavía no conocen la raíz
 * física. Estos descriptores quedan firmados, pero el plugin nunca los usa como
 * grant directo: vuelve a canonicalizar las acciones firmadas con ProjectResolver.
 */
export function compatibilityActionIntents(
  actions: readonly PlannedActionLike[],
  project: string,
): ActionIntentV1[] {
  const rootDigest = sha256(`unresolved:${project}`);
  return actions.flatMap((action) => {
    const base = {
      schema: 1 as const,
      canonicalizer: ACTION_INTENT_CANONICALIZER,
      project,
      rootRef: "planning:unresolved",
      rootDigest,
      constraints: { remote: false as const, infrastructure: false as const, protectedOperation: "runtime-recanonicalization" },
    };
    if (action.action === "edit") {
      return [sealIntent({
        ...base,
        kind: "edit",
        effect: "write",
        resources: [{
          kind: "filesystem",
          canonicalPath: path.resolve(action.resource),
          relativePath: action.resource,
          access: "write",
          existence: "may-create",
        }],
      })];
    }
    if (action.action === "subagent") {
      if (action.resource !== "malahor-diagnostico" && action.resource !== "malahor-testing") {
        throw canonicalizationError("El especialista no está gestionado por Malahor.");
      }
      return [sealIntent({
        ...base,
        kind: "subagent",
        effect: "delegate",
        resources: [],
        delegate: { agent: action.resource },
      })];
    }
    if (action.action !== "shell") throw canonicalizationError("Acción de plan no soportada.");
    return [sealIntent({
      ...base,
      kind: "shell",
      effect: "execute",
      resources: [],
      command: {
        executable: "planning-exact",
        argv: [action.resource],
        cwd: "planning:unresolved",
        composition: "single",
      },
      filesystem: { readRoots: [], writePaths: [], createPaths: [], sandboxWriteRoots: [] },
      network: "forbidden",
      environment: [],
    })];
  });
}

export function sameActionIntentSequence(
  left: readonly ActionIntentV1[],
  right: readonly ActionIntentV1[],
): boolean {
  return left.length === right.length && left.every((intent, index) => intent.actionID === right[index]?.actionID);
}

export function validActionIntentV1(value: unknown): value is ActionIntentV1 {
  if (!isRecord(value) || value.schema !== 1 || value.canonicalizer !== ACTION_INTENT_CANONICALIZER
    || typeof value.actionID !== "string" || !/^[a-f0-9]{64}$/.test(value.actionID)
    || !["edit", "shell", "subagent"].includes(String(value.kind))
    || !["write", "execute", "delegate"].includes(String(value.effect))
    || typeof value.project !== "string" || !value.project
    || typeof value.rootRef !== "string" || !value.rootRef
    || typeof value.rootDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.rootDigest)
    || !Array.isArray(value.resources) || !value.resources.every(validFilesystemResource)
    || !validConstraints(value.constraints)) return false;
  const common = ["schema", "canonicalizer", "actionID", "kind", "effect", "project", "rootRef", "rootDigest", "resources", "constraints"];
  if (value.kind === "edit" && (value.effect !== "write" || value.resources.length !== 1
    || !hasOnlyKeys(value, common))) return false;
  if (value.kind === "subagent" && (value.effect !== "delegate" || !isRecord(value.delegate)
    || !hasOnlyKeys(value, [...common, "delegate"]) || !hasOnlyKeys(value.delegate, ["agent"])
    || !["malahor-diagnostico", "malahor-testing"].includes(String(value.delegate.agent)))) return false;
  if (value.kind === "shell" && (value.effect !== "execute" || !validCommand(value.command)
    || value.network !== "forbidden" || !validFilesystem(value.filesystem)
    || !Array.isArray(value.environment) || !value.environment.every(validEnvironment)
    || !hasOnlyKeys(value, [...common, "command", "filesystem", "network", "environment"]))) return false;
  const { actionID: _actionID, ...unsigned } = value;
  return sha256(canonical(unsigned)) === value.actionID;
}

export function actionIntentSequenceHash(intents: readonly ActionIntentV1[]): string {
  return sha256(canonical(intents.map((intent) => intent.actionID)));
}

/** Canonicaliza una mutación de tarea directa con existencia explícita. */
export function canonicalizeDirectTaskMutation(input: {
  project: string;
  root: string;
  rootRef?: string;
  kind: "edit" | "write" | "patch";
  path: string;
  existence?: "must-exist" | "may-create";
}): ActionIntentV1[] {
  return canonicalizeActionIntent({
    kind: "edit",
    project: input.project,
    root: input.root,
    rootRef: input.rootRef ?? "project",
    path: input.path,
    existence: input.kind === "write" ? input.existence ?? "may-create" : input.existence ?? "must-exist",
    constraints: { remote: false, infrastructure: false },
  });
}

function parseClosedShell(command: string): Array<{ executable: string; argv: string[] }> {
  const segments = splitAndSequence(command);
  return segments.map((segment) => {
    const words = shellWords(segment);
    if (words.length === 0) throw canonicalizationError("Segmento shell vacío.");
    const [executable, ...argv] = words;
    if (!executable || /^[A-Za-z_][A-Za-z0-9_]*=/.test(executable)) {
      throw canonicalizationError("ActionIntentV1 no admite asignaciones shell inline.");
    }
    const basename = path.basename(executable).toLowerCase();
    if (basename === "eval" || (["sh", "bash", "zsh", "dash", "fish", "cmd", "powershell", "pwsh"].includes(basename)
      && argv.some((item) => item === "-c" || item === "/c" || item === "-command"))) {
      throw canonicalizationError("ActionIntentV1 no admite shells anidados ni eval.");
    }
    return { executable, argv };
  });
}

function splitAndSequence(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    const next = command[index + 1];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "&" && next === "&") {
      if (!current.trim()) throw canonicalizationError("Secuencia shell incompleta.");
      segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (character === "&" || character === "|" || character === ";" || character === "<" || character === ">"
      || character === "\n" || character === "\r" || character === "`" || character === "$"
      || character === "*" || character === "?" || character === "[") {
      throw canonicalizationError("Operador o expansión shell fuera del subconjunto cerrado.");
    }
    current += character;
  }
  if (escaped || quote || !current.trim()) throw canonicalizationError("Comando shell incompleto o con quoting inválido.");
  segments.push(current.trim());
  return segments;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  let started = false;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (escaped) {
      current += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (escaped || quote) throw canonicalizationError("Token shell incompleto.");
  if (started) words.push(current);
  return words;
}

function normalizeFilesystem(value: unknown, root: string): NonNullable<ActionIntentV1["filesystem"]> {
  const record = value === undefined ? {} : value;
  if (!isRecord(record)) throw canonicalizationError("Footprint de filesystem no evaluable.");
  return {
    readRoots: normalizedPathList(record.readRoots ?? [root], root, true),
    writePaths: normalizedPathList(record.writePaths ?? [], root, true),
    createPaths: normalizedPathList(record.createPaths ?? [], root, true),
    sandboxWriteRoots: normalizedPathList(record.sandboxWriteRoots ?? [], root, false),
  };
}

function normalizedPathList(value: unknown, root: string, confined: boolean): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw canonicalizationError("Lista de paths no evaluable.");
  }
  return [...new Set(value.map((item) => confined
    ? canonicalPathInsideRoot(item as string, root, "Recurso fuera de la raíz autorizada.")
    : canonicalLoosePath(item as string, root)))].sort(compareText);
}

function filesystemResources(
  filesystem: NonNullable<ActionIntentV1["filesystem"]>,
  root: string,
): ActionIntentFilesystemResource[] {
  const resources: ActionIntentFilesystemResource[] = [];
  for (const target of filesystem.readRoots) {
    resources.push(resourceFromCanonical(target, root, "read", "must-exist"));
  }
  for (const target of filesystem.writePaths) {
    resources.push(resourceFromCanonical(target, root, "write", "must-exist"));
  }
  for (const target of filesystem.createPaths) {
    resources.push(resourceFromCanonical(target, root, "write", "may-create"));
  }
  for (const target of filesystem.sandboxWriteRoots) {
    resources.push({
      kind: "filesystem",
      canonicalPath: target,
      relativePath: path.relative(root, target) || ".",
      access: "write",
      existence: "may-create",
      sandbox: true,
    });
  }
  return resources.sort((left, right) => compareText(
    `${left.access}\0${left.canonicalPath}\0${left.existence}`,
    `${right.access}\0${right.canonicalPath}\0${right.existence}`,
  ));
}

function filesystemResource(
  target: string,
  root: string,
  access: "read" | "write",
  existence: ActionIntentExistence,
): ActionIntentFilesystemResource {
  const canonicalPath = canonicalPathInsideRoot(target, root, "Recurso fuera de la raíz autorizada.");
  if (existence === "must-exist" && !fs.existsSync(canonicalPath)) {
    throw canonicalizationError("El recurso declarado como existente no existe.");
  }
  return resourceFromCanonical(canonicalPath, root, access, existence);
}

function resourceFromCanonical(
  canonicalPath: string,
  root: string,
  access: "read" | "write",
  existence: ActionIntentExistence,
): ActionIntentFilesystemResource {
  return {
    kind: "filesystem",
    canonicalPath,
    relativePath: portableRelative(root, canonicalPath),
    access,
    existence,
  };
}

function canonicalRoot(value: string): string {
  const resolved = path.resolve(value);
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("not-directory");
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error instanceof ActionIntentError) throw error;
    throw canonicalizationError("La raíz física no es un directorio regular evaluable.");
  }
}

function canonicalPathInsideRoot(target: string, root: string, message: string): string {
  const resolved = path.resolve(root, target);
  if (!inside(resolved, root)) throw resourceScopeError(message);
  const canonical = canonicalExistingOrFuturePath(resolved);
  if (!inside(canonical, root)) throw resourceScopeError(message);
  return canonical;
}

function canonicalExistingOrFuturePath(target: string): string {
  if (fs.existsSync(target)) return fs.realpathSync(target);
  const suffix: string[] = [];
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw canonicalizationError("No se pudo resolver el ancestro físico del recurso.");
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const stat = fs.lstatSync(cursor);
  if (stat.isSymbolicLink()) throw resourceScopeError("El recurso atraviesa un enlace simbólico no evaluable.");
  return path.join(fs.realpathSync(cursor), ...suffix);
}

function canonicalLoosePath(target: string, root: string): string {
  return canonicalExistingOrFuturePath(path.resolve(root, target));
}

function pathExistsWithoutFollowingSymlink(target: string, root: string): boolean {
  const resolved = path.resolve(root, target);
  try {
    const stat = fs.lstatSync(resolved);
    return !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function normalizeEnvironment(value: unknown): ActionIntentEnvironment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw canonicalizationError("Entorno de acción no evaluable.");
  const output = value.map((item) => {
    if (!isRecord(item) || typeof item.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.key)
      || (item.source !== "host-managed" && item.source !== "literal-nonsecret")
      || (item.valueDigest !== undefined && (typeof item.valueDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.valueDigest)))) {
      throw canonicalizationError("Variable de entorno no evaluable.");
    }
    return {
      key: item.key,
      source: item.source,
      ...(typeof item.valueDigest === "string" ? { valueDigest: item.valueDigest } : {}),
    } as ActionIntentEnvironment;
  });
  const keys = output.map((item) => item.key);
  if (new Set(keys).size !== keys.length) throw canonicalizationError("Variables de entorno duplicadas.");
  return output.sort((left, right) => compareText(left.key, right.key));
}

function normalizeConstraints(value: unknown): ActionIntentV1["constraints"] {
  const record = value === undefined ? {} : value;
  if (!isRecord(record) || (record.remote !== undefined && record.remote !== false)
    || (record.infrastructure !== undefined && record.infrastructure !== false)
    || (record.protectedOperation !== undefined && (typeof record.protectedOperation !== "string"
      || !record.protectedOperation.trim() || record.protectedOperation.length > 256))) {
    throw canonicalizationError("Restricciones de acción no evaluables.");
  }
  return {
    remote: false,
    infrastructure: false,
    ...(typeof record.protectedOperation === "string" ? { protectedOperation: record.protectedOperation.trim() } : {}),
  };
}

function sealIntent(value: Omit<ActionIntentV1, "actionID">): ActionIntentV1 {
  return { ...value, actionID: sha256(canonical(value)) };
}

function validFilesystemResource(value: unknown): boolean {
  return isRecord(value) && value.kind === "filesystem" && typeof value.canonicalPath === "string"
    && typeof value.relativePath === "string" && (value.access === "read" || value.access === "write")
    && (value.existence === "must-exist" || value.existence === "may-create")
    && (value.sandbox === undefined || typeof value.sandbox === "boolean")
    && hasOnlyKeys(value, value.sandbox === undefined
      ? ["kind", "canonicalPath", "relativePath", "access", "existence"]
      : ["kind", "canonicalPath", "relativePath", "access", "existence", "sandbox"]);
}

function validCommand(value: unknown): boolean {
  return isRecord(value) && typeof value.executable === "string" && value.executable.length > 0
    && Array.isArray(value.argv) && value.argv.every((item) => typeof item === "string")
    && typeof value.cwd === "string" && value.cwd.length > 0
    && (value.composition === "single" || value.composition === "and-sequence")
    && hasOnlyKeys(value, ["executable", "argv", "cwd", "composition"]);
}

function validFilesystem(value: unknown): boolean {
  return isRecord(value) && [value.readRoots, value.writePaths, value.createPaths, value.sandboxWriteRoots]
    .every((item) => Array.isArray(item) && item.every((entry) => typeof entry === "string"))
    && hasOnlyKeys(value, ["readRoots", "writePaths", "createPaths", "sandboxWriteRoots"]);
}

function validEnvironment(value: unknown): boolean {
  return isRecord(value) && typeof value.key === "string"
    && (value.source === "host-managed" || value.source === "literal-nonsecret")
    && (value.valueDigest === undefined || (typeof value.valueDigest === "string" && /^[a-f0-9]{64}$/.test(value.valueDigest)))
    && hasOnlyKeys(value, value.valueDigest === undefined ? ["key", "source"] : ["key", "source", "valueDigest"]);
}

function validConstraints(value: unknown): boolean {
  return isRecord(value) && value.remote === false && value.infrastructure === false
    && (value.protectedOperation === undefined || typeof value.protectedOperation === "string")
    && hasOnlyKeys(value, value.protectedOperation === undefined
      ? ["remote", "infrastructure"]
      : ["remote", "infrastructure", "protectedOperation"]);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function portableRelative(root: string, target: string): string {
  const relative = path.relative(root, target) || ".";
  return relative.split(path.sep).join("/");
}

function sameRepairEnvelope(left: ActionIntentV1, right: ActionIntentV1): boolean {
  if (!left.command || !right.command) return false;
  return left.kind === "shell" && right.kind === "shell"
    && left.effect === right.effect
    && left.project === right.project
    && left.rootRef === right.rootRef
    && left.rootDigest === right.rootDigest
    && left.command.executable === "git"
    && right.command.executable === "git"
    && left.command.cwd === right.command.cwd
    && left.command.composition === "single"
    && right.command.composition === "single"
    && canonical(left.resources) === canonical(right.resources)
    && canonical(left.filesystem) === canonical(right.filesystem)
    && canonical(left.environment) === canonical(right.environment)
    && left.network === "forbidden"
    && right.network === "forbidden"
    && canonical(left.constraints) === canonical(right.constraints);
}

function gitStageTargets(intent: ActionIntentV1): string[] | undefined {
  const argv = intent.command?.argv;
  if (!argv || argv.length < 3 || argv[0] !== "add" || argv[1] !== "--") return undefined;
  const targets = argv.slice(2);
  if (targets.some((target) => !safeLiteralStageTarget(target))) return undefined;
  return targets;
}

function safeLiteralStageTarget(value: string): boolean {
  if (value.length === 0 || value.length > 4_096 || path.isAbsolute(value) || value.startsWith(":")) return false;
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) return false;
  for (const marker of ["*", "?", "[", "]", "{", "}"]) {
    if (value.includes(marker)) return false;
  }
  return value.split(/[\\/]/u).every((part) => part !== "" && part !== "." && part !== ".."
    && part.toLowerCase() !== ".git");
}

function hasLiteralStageDirectory(targets: string[], root: string, cwd: string): boolean {
  return targets.some((target) => {
    const resolved = path.resolve(cwd, target);
    if (!inside(resolved, root)) throw resourceScopeError("Path de stage fuera de la raíz autorizada.");
    assertNoSymlinkTraversal(resolved, root);
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const canonicalTarget = fs.realpathSync(resolved);
    return canonicalTarget !== root && path.basename(canonicalTarget).toLowerCase() !== ".git";
  });
}

function stageManifest(targets: string[], root: string, cwd: string, allowDirectories: boolean): string[] {
  const found = new Set<string>();
  const traversal = { nodes: 0 };
  for (const target of targets) {
    if (!safeLiteralStageTarget(target)) throw canonicalizationError("Target de stage no literal.");
    const resolved = path.resolve(cwd, target);
    if (!inside(resolved, root)) throw resourceScopeError("Path de stage fuera de la raíz autorizada.");
    collectStageTarget(resolved, root, allowDirectories, found, traversal, 0);
    if (found.size > 512) throw canonicalizationError("Manifest de stage fuera de límite.");
  }
  const manifest = [...found].sort(compareText);
  const size = manifest.reduce((total, item) => total + item.length, 0);
  if (size > 16_384) throw canonicalizationError("Manifest de stage fuera de límite.");
  return manifest;
}

function collectStageTarget(
  target: string,
  root: string,
  allowDirectories: boolean,
  found: Set<string>,
  traversal: { nodes: number },
  depth: number,
): void {
  traversal.nodes += 1;
  if (traversal.nodes > 1_024 || depth > 128) throw canonicalizationError("Recorrido de stage fuera de límite.");
  assertNoSymlinkTraversal(target, root);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw resourceScopeError("Stage mediante symlink no permitido.");
  const canonicalTarget = fs.realpathSync(target);
  if (!inside(canonicalTarget, root)) throw resourceScopeError("Path de stage fuera de la raíz autorizada.");
  if (stat.isFile()) {
    if (stat.nlink > 1) throw resourceScopeError("Stage mediante hardlink no permitido.");
    const relativePath = portableRelative(root, canonicalTarget);
    if (!found.has(relativePath) && found.size >= 512) {
      throw canonicalizationError("Manifest de stage fuera de límite.");
    }
    found.add(relativePath);
    return;
  }
  if (!stat.isDirectory() || !allowDirectories || canonicalTarget === root
    || path.basename(canonicalTarget).toLowerCase() === ".git") {
    throw canonicalizationError("El manifest reparado exige archivos exactos.");
  }
  const entries = fs.readdirSync(canonicalTarget, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    if (entry.name.toLowerCase() === ".git") throw canonicalizationError("El manifest no atraviesa metadata Git.");
    collectStageTarget(path.join(canonicalTarget, entry.name), root, true, found, traversal, depth + 1);
  }
}

function assertNoSymlinkTraversal(target: string, root: string): void {
  const relative = path.relative(root, target);
  if (relative === "") return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw resourceScopeError("Path de stage fuera de la raíz autorizada.");
  }
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw resourceScopeError("Stage mediante symlink no permitido.");
    }
  }
}

function subset(values: string[], allowed: string[]): boolean {
  const scope = new Set(allowed);
  return values.every((value) => scope.has(value));
}

function sameTextSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function inside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requiredText(value: unknown, message: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000\r\n]/u.test(value)) {
    throw canonicalizationError(message);
  }
  return value.trim();
}

function canonicalizationError(message: string): ActionIntentError {
  return new ActionIntentError("ACTION_NOT_CANONICALIZABLE", message);
}

function resourceScopeError(message: string): ActionIntentError {
  return new ActionIntentError("RESOURCE_OUTSIDE_SCOPE", message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashReference(value: string): string {
  return `sha256:${sha256(value)}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
