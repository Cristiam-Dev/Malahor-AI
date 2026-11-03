import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalizeDirectTaskMutation } from "../cli/core/action-intent";
import { isProtectedDocumentationPath, parsePatchOperations } from "../cli/core/documentation-boundary";
import { detectPayloadSecretKinds } from "../cli/core/hooks/secret-scan";
import { classifyInfrastructurePath } from "../cli/core/infrastructure-boundary";
import { classifyReadOnlyShellCommand } from "../cli/core/read-only-shell-policy";
import type { TaskDecisionV1, TaskMode } from "../cli/core/task-classification";

export const DIRECT_TASK_APPROVAL = "malahor_direct_task_execute";
export const DIRECT_GRANT_MISMATCH = "DIRECT_GRANT_MISMATCH" as const;

export interface DirectTaskScope {
  sessionID: string;
  project: string;
  policyRevision: string;
  mode: TaskMode;
  root: string;
}

export interface DirectTaskCall {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
}

export interface DirectTaskApprovalPort {
  assert(input: {
    sessionID: string;
    agent: string;
    source: { type: "tool"; messageID: string; id: string };
    action: string;
    resources: string[];
    save: string[];
  }): Promise<unknown>;
}

export interface DirectMutationInputV1 {
  kind: "edit" | "write" | "patch";
  path: string;
  existence?: "must-exist" | "may-create";
  payload: Record<string, unknown>;
}

export interface DirectVerificationInputV1 {
  kind: "shell";
  argv: string[];
  cwd?: string;
}

export interface DirectTaskPreparationInputV1 {
  decisionRef: string;
  summary: string;
  mutations: DirectMutationInputV1[];
  verification: DirectVerificationInputV1[];
}

export interface DirectEnvelopeActionV1 {
  actionID: string;
  kind: DirectMutationInputV1["kind"];
  relativePath: string;
  existence: "must-exist" | "may-create";
  payloadDigest: string;
}

export interface DirectTaskEnvelopeV1 {
  schema: 1;
  kind: "malahor.direct-task";
  decisionRef: string;
  project: string;
  policyRevision: string;
  mode: TaskMode;
  rootDigest: string;
  summary: string;
  actions: DirectEnvelopeActionV1[];
  verification: Array<{ argv: string[]; cwd: string }>;
  proof: string;
}

export type DirectToolAuthorization =
  | { effect: "absent" }
  | { effect: "allow" }
  | { effect: "deny"; code: typeof DIRECT_GRANT_MISMATCH };

export interface DirectTaskRegistry {
  prepare(
    input: unknown,
    call: DirectTaskCall,
    scope: DirectTaskScope,
    decision: TaskDecisionV1,
    approval: DirectTaskApprovalPort,
    resolveScope: () => Promise<DirectTaskScope | undefined>,
  ): Promise<{ envelope: DirectTaskEnvelopeV1; actions: number }>;
  authorizeTool(input: {
    scope: DirectTaskScope;
    tool: string;
    value: unknown;
    messageID: string;
    toolCallID: string;
    boundary: "tool" | "permission";
  }): DirectToolAuthorization;
  invalidate(sessionID: string): void;
}

interface DirectGrant {
  scope: DirectTaskScope;
  envelope: DirectTaskEnvelopeV1;
  cursor: number;
  inFlight?: {
    index: number;
    callKey: string;
    toolSeen: boolean;
    permissionSeen: boolean;
  };
}

const MAX_ACTIONS = 32;
const MAX_VERIFICATIONS = 16;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export function createDirectTaskRegistry(): DirectTaskRegistry {
  const grants = new Map<string, DirectGrant>();
  const completed = new Map<string, Set<string>>();

  const invalidate = (sessionID: string): void => {
    grants.delete(sessionID);
    completed.delete(sessionID);
  };

  return {
    async prepare(input, call, scopeValue, decision, approval, resolveScope) {
      if (call.agent !== "malahor" || call.sessionID !== scopeValue.sessionID) {
        throw new Error("Solo el primario puede preparar su propia tarea directa.");
      }
      const scope = normalizeScope(scopeValue);
      if (scope.mode === "advisor") throw new Error("El asesor no ejecuta tareas directas.");
      if (decision.schema !== 1 || decision.route !== "direct") {
        throw new Error("La decisión de clasificación no autoriza ejecución directa.");
      }
      const parsed = parsePreparation(input);
      if (parsed.decisionRef !== decision.decisionRef) {
        throw new Error("La decisión de clasificación no coincide con la preparación.");
      }
      const envelope = compileEnvelope(parsed, scope);
      grants.delete(scope.sessionID);
      await approval.assert({
        sessionID: call.sessionID,
        agent: call.agent,
        source: { type: "tool", messageID: call.messageID, id: call.id },
        action: DIRECT_TASK_APPROVAL,
        resources: [envelope.decisionRef, envelope.proof, ...envelope.actions.map((action) => action.relativePath)],
        save: [],
      });
      const freshScope = await resolveScope();
      if (!freshScope || !sameScope(scope, normalizeScope(freshScope))) {
        throw new Error("El proyecto, modo o política cambió durante la aprobación directa.");
      }
      const fresh = compileEnvelope(parsed, normalizeScope(freshScope));
      if (fresh.proof !== envelope.proof) {
        throw new Error("La tarea directa cambió durante la aprobación nativa.");
      }
      grants.set(scope.sessionID, { scope, envelope: fresh, cursor: 0 });
      return { envelope: fresh, actions: fresh.actions.length };
    },

    authorizeTool(input) {
      const scope = normalizeScope(input.scope);
      const callKey = `${input.messageID}\u0000${input.toolCallID}`;
      if (completed.get(scope.sessionID)?.has(callKey)) {
        return { effect: "deny", code: DIRECT_GRANT_MISMATCH };
      }
      const grant = grants.get(scope.sessionID);
      if (!grant) return { effect: "absent" };
      if (!sameScope(grant.scope, scope)) {
        invalidate(scope.sessionID);
        return { effect: "deny", code: DIRECT_GRANT_MISMATCH };
      }
      const expected = grant.envelope.actions[grant.cursor];
      if (!expected) {
        invalidate(scope.sessionID);
        return { effect: "absent" };
      }
      const candidate = candidateForTool(input.tool, input.value);
      if (!candidate || candidate.kind !== expected.kind || candidate.relativePath !== expected.relativePath
        || candidate.payloadDigest !== expected.payloadDigest) {
        invalidate(scope.sessionID);
        return { effect: "deny", code: DIRECT_GRANT_MISMATCH };
      }
      if (!input.messageID.trim() || !input.toolCallID.trim()) {
        invalidate(scope.sessionID);
        return { effect: "deny", code: DIRECT_GRANT_MISMATCH };
      }
      const step = grant.inFlight;
      if (!step) {
        grant.inFlight = {
          index: grant.cursor,
          callKey,
          toolSeen: input.boundary === "tool",
          permissionSeen: input.boundary === "permission",
        };
      } else if (step.index !== grant.cursor || step.callKey !== callKey) {
        invalidate(scope.sessionID);
        return { effect: "deny", code: DIRECT_GRANT_MISMATCH };
      } else if (input.boundary === "tool") {
        step.toolSeen = true;
      } else {
        step.permissionSeen = true;
      }
      const current = grant.inFlight;
      if (current?.toolSeen && current.permissionSeen) {
        grant.cursor += 1;
        grant.inFlight = undefined;
        if (grant.cursor >= grant.envelope.actions.length) {
          completed.set(scope.sessionID, new Set([callKey]));
          grants.delete(scope.sessionID);
        }
      }
      return { effect: "allow" };
    },

    invalidate,
  };
}

interface DirectTaskToolCall {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
}

interface DirectTaskToolEditor {
  namespace(input: { name: string; description: string }): void;
  add(input: Record<string, unknown>): void;
}

export interface DirectTaskTools {
  transform(callback: (editor: DirectTaskToolEditor) => void): Promise<{ dispose?: () => Promise<void> | void } | void>;
}

const DIRECT_TASK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    decisionRef: { type: "string" },
    summary: { type: "string" },
    mutations: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["edit", "write", "patch"] },
          path: { type: "string" },
          existence: { type: "string", enum: ["must-exist", "may-create"] },
          payload: { type: "object" },
        },
        required: ["kind", "path", "payload"],
        additionalProperties: false,
      },
    },
    verification: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["shell"] },
          argv: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } },
          cwd: { type: "string" },
        },
        required: ["kind", "argv"],
        additionalProperties: false,
      },
    },
  },
  required: ["decisionRef", "summary", "mutations", "verification"],
  additionalProperties: false,
};

export async function registerDirectTaskTool(
  tools: DirectTaskTools,
  registry: DirectTaskRegistry,
  classifier: import("./task-classification").TaskClassifier,
  resolveScope: (sessionID: string) => Promise<DirectTaskScope | undefined>,
  approval: DirectTaskApprovalPort,
): Promise<{ dispose?: () => Promise<void> | void } | void> {
  return tools.transform((editor) => {
    editor.namespace({ name: "malahor", description: "Ejecución directa aprobada por envelope" });
    editor.add({
      name: "direct_prepare",
      description: "Prepara una mutación directa cerrada, solicita aprobación nativa y emite un grant exacto.",
      input: DIRECT_TASK_INPUT_SCHEMA,
      options: { namespace: "malahor", codemode: false },
      execute: async (value: unknown, call: DirectTaskToolCall) => {
        const scope = await resolveScope(call.sessionID);
        if (!scope) throw new Error("Proyecto o sesión no evaluable para la tarea directa.");
        const record = classifier.current(call.sessionID, "direct");
        if (!record) throw new Error("No hay una decisión directa vigente para esta sesión.");
        const result = await registry.prepare(
          value,
          call,
          scope,
          record.decision,
          approval,
          () => resolveScope(call.sessionID),
        );
        return {
          content: `Tarea directa preparada con ${result.actions} acción(es); la aprobación cubre solo este envelope.`,
          metadata: {
            kind: "malahor.direct.task",
            version: 1,
            decisionRef: result.envelope.decisionRef,
            proof: result.envelope.proof,
            actions: result.actions,
          },
        };
      },
    });
  });
}

function parsePreparation(value: unknown): DirectTaskPreparationInputV1 {
  const record = exactRecord(value, ["decisionRef", "summary", "mutations", "verification"], "Preparación directa inválida.");
  const decisionRef = text(record.decisionRef, "decisionRef");
  if (!/^[a-f0-9]{64}$/.test(decisionRef)) throw new Error("decisionRef inválido.");
  const summary = text(record.summary, "summary");
  if (summary.length > 1_000 || /[\u0000\r\n]/.test(summary)) throw new Error("summary inválido.");
  if (!Array.isArray(record.mutations) || record.mutations.length === 0 || record.mutations.length > MAX_ACTIONS) {
    throw new Error("La tarea directa requiere mutaciones acotadas.");
  }
  if (!Array.isArray(record.verification) || record.verification.length > MAX_VERIFICATIONS) {
    throw new Error("La verificación directa es inválida.");
  }
  const serialized = JSON.stringify(value);
  // El scanner general detecta asignaciones de código; un payload JSON usa
  // `"clave":"valor"` y necesita esta comprobación cerrada adicional.
  const jsonCredential = /"(?:api[_-]?key|access[_-]?token|secret[_-]?key|password)"\s*:\s*"[^"\r\n]{16,}"/i
    .test(serialized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES
    || detectPayloadSecretKinds(serialized).length > 0
    || jsonCredential) {
    throw new Error("La preparación directa contiene material sensible o excesivo.");
  }
  const mutations = record.mutations.map((item) => parseMutation(item));
  const verification = record.verification.map((item) => parseVerification(item));
  return { decisionRef, summary, mutations, verification };
}

function parseMutation(value: unknown): DirectMutationInputV1 {
  const record = exactRecord(value, ["kind", "path", "existence", "payload"], "Mutación directa inválida.");
  const kind = record.kind;
  if (kind !== "edit" && kind !== "write" && kind !== "patch") throw new Error("Tipo de mutación directa inválido.");
  const target = text(record.path, "path");
  if (!target || path.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("~")
    || /[*?\[\]{}]/.test(target)) throw new Error("Ruta de mutación directa inválida.");
  const existence = record.existence === "may-create" ? "may-create"
    : record.existence === "must-exist" || record.existence === undefined ? "must-exist"
      : undefined;
  if (!existence) throw new Error("Contrato de existencia inválido.");
  if (kind !== "write" && existence === "may-create") throw new Error("Solo write puede crear archivos.");
  const payload = recordValue(record.payload);
  if (!payload) throw new Error("Payload de mutación directa inválido.");
  if (kind === "patch") {
    const patchText = typeof payload.patchText === "string" ? payload.patchText : undefined;
    if (!patchText) throw new Error("El patch directo requiere patchText.");
    const operations = parsePatchOperations(patchText);
    if (operations.length !== 1 || operations[0]?.kind !== "update" || operations[0].path !== target) {
      throw new Error("El patch directo debe actualizar exactamente el target declarado.");
    }
  }
  return { kind, path: target, existence, payload };
}

function parseVerification(value: unknown): DirectVerificationInputV1 {
  const record = exactRecord(value, ["kind", "argv", "cwd"], "Verificación directa inválida.");
  if (record.kind !== "shell" || !Array.isArray(record.argv) || record.argv.length === 0
    || record.argv.length > 32 || record.argv.some((item) => typeof item !== "string" || !item.trim()
      || item.length > 2_000 || /[\u0000\r\n]/.test(item))) {
    throw new Error("La verificación directa debe ser un argv shell cerrado.");
  }
  const cwd = record.cwd === undefined ? undefined : text(record.cwd, "cwd");
  return { kind: "shell", argv: [...record.argv] as string[], ...(cwd ? { cwd } : {}) };
}

function compileEnvelope(input: DirectTaskPreparationInputV1, scope: DirectTaskScope): DirectTaskEnvelopeV1 {
  const root = path.resolve(scope.root);
  const actions: DirectEnvelopeActionV1[] = [];
  for (const mutation of input.mutations) {
    const absolute = path.resolve(root, mutation.path);
    if (!inside(absolute, root) || absolute === root) throw new Error(`Ruta de mutación fuera de la raíz: ${mutation.path}.`);
    if (isProtectedDocumentationPath(root, absolute) || classifyInfrastructurePath(root, absolute).protected) {
      throw new Error(`La tarea directa no cubre documentación protegida ni infraestructura: ${mutation.path}.`);
    }
    const exists = existsRegular(absolute);
    if (mutation.existence === "must-exist" && !exists) {
      throw new Error(`La ruta debe existir y ser regular: ${mutation.path}.`);
    }
    if (mutation.kind === "write" && exists) {
      throw new Error(`write directo no sobrescribe archivos existentes: ${mutation.path}.`);
    }
    if (exists && !isRegular(absolute)) throw new Error(`La ruta no es un archivo regular: ${mutation.path}.`);
    const relativePath = path.relative(root, absolute).split(path.sep).join("/");
    const existence = mutation.existence ?? "must-exist";
    const intent = canonicalizeDirectTaskMutation({
      project: scope.project,
      root,
      kind: mutation.kind,
      path: relativePath,
      existence,
    })[0];
    if (!intent) throw new Error("La mutación directa no pudo canonicalizarse.");
    const payloadDigest = sha256(JSON.stringify(mutation.payload));
    actions.push({
      actionID: sha256(JSON.stringify({ decisionRef: input.decisionRef, kind: mutation.kind, relativePath, payloadDigest })),
      kind: mutation.kind,
      relativePath,
      existence,
      payloadDigest,
    });
  }
  const verification = input.verification.map((item) => {
    const cwd = item.cwd ? path.resolve(root, item.cwd) : root;
    if (!inside(cwd, root)) throw new Error("El cwd de verificación queda fuera de la raíz.");
    const command = item.argv.join(" ");
    if (!classifyReadOnlyShellCommand(command, root, { workingDirectory: cwd }).readOnly) {
      throw new Error("La verificación directa debe ser read-only y reconocida.");
    }
    return { argv: [...item.argv], cwd };
  });
  const unsigned: Omit<DirectTaskEnvelopeV1, "proof"> = {
    schema: 1,
    kind: "malahor.direct-task",
    decisionRef: input.decisionRef,
    project: scope.project,
    policyRevision: scope.policyRevision,
    mode: scope.mode,
    rootDigest: sha256(root),
    summary: input.summary,
    actions,
    verification,
  };
  return { ...unsigned, proof: sha256(JSON.stringify(unsigned)) };
}

function candidateForTool(tool: string, value: unknown): {
  kind: DirectMutationInputV1["kind"];
  relativePath: string;
  payloadDigest: string;
} | undefined {
  if (!["edit", "write", "patch"].includes(tool)) return undefined;
  const record = recordValue(value);
  if (!record) return undefined;
  const rawPath = tool === "patch"
    ? parsePatchOperations(typeof record.patchText === "string" ? record.patchText : "")[0]?.path
    : record.path ?? record.filePath;
  if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
  const normalized = path.normalize(rawPath).split(path.sep).join("/");
  if (normalized.startsWith("../") || normalized === "..") return undefined;
  return {
    kind: tool as DirectMutationInputV1["kind"],
    relativePath: normalized,
    payloadDigest: sha256(JSON.stringify(value)),
  };
}

function normalizeScope(scope: DirectTaskScope): DirectTaskScope {
  return {
    sessionID: scope.sessionID,
    project: scope.project,
    policyRevision: scope.policyRevision,
    mode: scope.mode,
    root: path.resolve(scope.root),
  };
}

function sameScope(left: DirectTaskScope, right: DirectTaskScope): boolean {
  return left.sessionID === right.sessionID && left.project === right.project
    && left.policyRevision === right.policyRevision && left.mode === right.mode
    && left.root === right.root;
}

function exactRecord(value: unknown, keys: string[], message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))
    || keys.some((key) => !(key in record) && key !== "existence" && key !== "cwd")) {
    throw new Error(message);
  }
  return record;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`${field} inválido.`);
  }
  return value.trim();
}

function existsRegular(target: string): boolean {
  try {
    return fs.lstatSync(target).isFile();
  } catch {
    return false;
  }
}

function isRegular(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function inside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
