import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalizeActionIntent, type ActionIntentV1 } from "../cli/core/action-intent";
import { isProtectedDocumentationPath, parsePatchOperations } from "../cli/core/documentation-boundary";
import { detectPayloadSecretKinds } from "../cli/core/hooks/secret-scan";
import { classifyInfrastructurePath } from "../cli/core/infrastructure-boundary";

/**
 * Shim transitorio: la ejecución directa genérica vive en
 * direct-task-execution.ts. Este mediador conserva la compatibilidad de la
 * aprobación puntual de un archivo hasta completar la migración.
 */
export const POINT_ACTION_APPROVAL = "malahor_point_action_execute";

export type PointActionMode = "advisor" | "assistant" | "executor";

export interface PointActionScope {
  sessionID: string;
  project: string;
  policyRevision: string;
  mode: PointActionMode;
  root: string;
}

export interface PointActionCall {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
}

export interface PointActionApprovalPort {
  assert(input: {
    sessionID: string;
    agent: string;
    source: { type: "tool"; messageID: string; id: string };
    action: string;
    resources: string[];
    save: string[];
  }): Promise<unknown>;
}

export interface PointActionPermissionInput {
  scope: PointActionScope;
  directory: string;
  action: string;
  resources: unknown[];
  effect: unknown;
  source: unknown;
  toolRegistered: boolean;
}

export interface PointActionToolInput {
  scope: PointActionScope;
  directory: string;
  tool: string;
  value: unknown;
  call: PointActionCall;
  approval: PointActionApprovalPort;
  revalidate: () => Promise<{ scope: PointActionScope; noActivePlan: boolean } | undefined>;
}

export interface PointActionMediator {
  observePermission(input: PointActionPermissionInput): boolean;
  evaluateApprovalPermission(input: Record<string, unknown>, scope: PointActionScope | undefined): boolean;
  authorizeTool(input: PointActionToolInput): Promise<boolean>;
  invalidate(sessionID: string): void;
}

interface PointCandidate {
  scope: PointActionScope;
  actionID: string;
  relativePath: string;
  intent: ActionIntentV1;
  payloadDigest?: string;
}

interface PointEvidence {
  scope: PointActionScope;
  actionID: string;
  relativePath: string;
  callKey: string;
  payloadDigest?: string;
}

export function createPointActionMediator(): PointActionMediator {
  const hostAsks = new Map<string, PointEvidence>();
  const pending = new Map<string, PointEvidence>();

  const invalidate = (sessionID: string): void => {
    for (const [key, evidence] of hostAsks) {
      if (evidence.scope.sessionID === sessionID) hostAsks.delete(key);
    }
    for (const [key, evidence] of pending) {
      if (evidence.scope.sessionID === sessionID) pending.delete(key);
    }
  };

  return {
    observePermission(input) {
      if (!input.toolRegistered || input.action !== "edit" || input.scope.mode === "advisor"
        || input.resources.length !== 1 || typeof input.resources[0] !== "string") return false;
      const call = permissionCall(input.scope.sessionID, input.source);
      if (!call) return false;
      const candidate = candidateForTarget(
        input.scope,
        path.resolve(input.directory, input.resources[0]),
      );
      if (!candidate) return false;
      const key = callKey(call);
      if (input.effect === "ask") {
        hostAsks.set(key, { ...candidate, callKey: key });
      } else if (input.effect !== "allow") {
        return false;
      }
      return true;
    },

    evaluateApprovalPermission(input, currentScope) {
      const source = permissionCall(text(input.sessionID), input.source);
      const resources = Array.isArray(input.resources) ? input.resources : [];
      if (!source || !currentScope || resources.length !== 3
        || resources.some((item) => typeof item !== "string")) return false;
      const evidence = pending.get(callKey(source));
      if (!evidence || !sameScope(evidence.scope, currentScope)
        || resources[0] !== evidence.actionID || resources[1] !== evidence.relativePath
        || resources[2] !== evidence.payloadDigest) return false;
      input.effect = "ask";
      input.message = `Autoriza una edición puntual del archivo ${evidence.relativePath}. No crea, borra ni mueve archivos y no autoriza otros efectos.`;
      return true;
    },

    async authorizeTool(input) {
      if (input.call.agent !== "malahor" || input.call.sessionID !== input.scope.sessionID
        || input.scope.mode === "advisor") return false;
      const candidate = candidateForTool(input.scope, input.directory, input.tool, input.value);
      if (!candidate) return false;
      const key = callKey(input.call);
      const hostEvidence = hostAsks.get(key);
      if (hostEvidence) {
        hostAsks.delete(key);
        if (!sameEvidence(hostEvidence, candidate)) {
          throw new Error("La aprobación nativa previa no coincide con la edición puntual actual.");
        }
        const fresh = await input.revalidate();
        if (!fresh || !fresh.noActivePlan || !sameScope(candidate.scope, fresh.scope)) {
          throw new Error("El proyecto, modo, política o Planning cambió después de la aprobación nativa.");
        }
        const revalidated = candidateForTool(fresh.scope, input.directory, input.tool, input.value);
        if (!revalidated || !sameEvidence(candidate, revalidated)) {
          throw new Error("La edición puntual cambió después de la aprobación nativa.");
        }
        return true;
      }
      if (pending.has(key)) throw new Error("Ya existe una aprobación puntual pendiente para esta llamada.");
      const evidence: PointEvidence = { ...candidate, callKey: key };
      pending.set(key, evidence);
      try {
        await input.approval.assert({
          sessionID: input.call.sessionID,
          agent: input.call.agent,
          source: { type: "tool", messageID: input.call.messageID, id: input.call.id },
          action: POINT_ACTION_APPROVAL,
          resources: [candidate.actionID, candidate.relativePath, candidate.payloadDigest!],
          save: [],
        });
        if (!pending.has(key)) throw new Error("La aprobación puntual fue invalidada antes de ejecutar.");
        const fresh = await input.revalidate();
        if (!fresh || !fresh.noActivePlan || !sameScope(candidate.scope, fresh.scope)) {
          throw new Error("El proyecto, modo, política o Planning cambió durante la aprobación puntual.");
        }
        const revalidated = candidateForTool(fresh.scope, input.directory, input.tool, input.value);
        if (!revalidated || !sameEvidence(candidate, revalidated)) {
          throw new Error("La edición puntual cambió durante la aprobación nativa.");
        }
        return true;
      } finally {
        pending.delete(key);
      }
    },

    invalidate,
  };
}

function candidateForTool(
  scope: PointActionScope,
  directory: string,
  tool: string,
  value: unknown,
): PointCandidate | undefined {
  const serialized = JSON.stringify(value);
  if (!["edit", "write", "patch"].includes(tool) || typeof serialized !== "string"
    || Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024
    || detectPayloadSecretKinds(serialized).length > 0) {
    return undefined;
  }
  const args = recordValue(value) ?? {};
  let target: string | undefined;
  if (tool === "patch") {
    if (typeof args.patchText !== "string") return undefined;
    const operations = parsePatchOperations(args.patchText);
    if (operations.length !== 1 || operations[0]?.kind !== "update") return undefined;
    target = operations[0].path;
  } else {
    const raw = args.path ?? args.filePath;
    if (typeof raw !== "string") return undefined;
    target = raw;
  }
  const candidate = candidateForTarget(scope, path.resolve(directory, target));
  return candidate ? {
    ...candidate,
    payloadDigest: createHash("sha256").update(serialized).digest("hex"),
  } : undefined;
}

function candidateForTarget(scopeValue: PointActionScope, target: string): PointCandidate | undefined {
  try {
    const scope = normalizeScope(scopeValue);
    const absolute = path.resolve(target);
    if (!inside(absolute, scope.root) || absolute === scope.root
      || isProtectedDocumentationPath(scope.root, absolute)
      || classifyInfrastructurePath(scope.root, absolute).protected) return undefined;
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const real = fs.realpathSync(absolute);
    if (!inside(real, scope.root)) return undefined;
    const intents = canonicalizeActionIntent({
      kind: "edit",
      project: scope.project,
      root: scope.root,
      rootRef: "project",
      path: absolute,
      existence: "must-exist",
      constraints: { remote: false, infrastructure: false },
    });
    if (intents.length !== 1) return undefined;
    return {
      scope,
      actionID: intents[0]!.actionID,
      relativePath: path.relative(scope.root, absolute).split(path.sep).join("/"),
      intent: intents[0]!,
    };
  } catch {
    return undefined;
  }
}

function permissionCall(sessionID: string, value: unknown): PointActionCall | undefined {
  const source = recordValue(value);
  const messageID = text(source?.messageID);
  const id = text(source?.id);
  return source?.type === "tool" && sessionID && messageID && id
    ? { sessionID, agent: "malahor", messageID, id }
    : undefined;
}

function normalizeScope(scope: PointActionScope): PointActionScope {
  if (!scope.sessionID || !scope.project || !scope.policyRevision
    || !["advisor", "assistant", "executor"].includes(scope.mode)) {
    throw new Error("Scope puntual no evaluable.");
  }
  const root = fs.realpathSync(path.resolve(scope.root));
  if (!fs.statSync(root).isDirectory()) throw new Error("Raíz puntual no evaluable.");
  return { ...scope, root };
}

function sameEvidence(left: PointEvidence | PointCandidate, right: PointEvidence | PointCandidate): boolean {
  return left.actionID === right.actionID && left.relativePath === right.relativePath
    && (left.payloadDigest === undefined || right.payloadDigest === undefined
      || left.payloadDigest === right.payloadDigest)
    && sameScope(left.scope, right.scope);
}

function sameScope(left: PointActionScope, right: PointActionScope): boolean {
  try {
    const a = normalizeScope(left);
    const b = normalizeScope(right);
    return a.sessionID === b.sessionID && a.project === b.project
      && a.policyRevision === b.policyRevision && a.mode === b.mode && a.root === b.root;
  } catch {
    return false;
  }
}

function callKey(call: PointActionCall): string {
  return [call.sessionID, call.messageID, call.id].join("\0");
}

function inside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
