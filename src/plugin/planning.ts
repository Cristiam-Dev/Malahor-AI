import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../cli/core/config";
import { registeredProjectRoots } from "../cli/core/context";
import { MODE_CHANGE_ACTION, parseModeName, previewModeChange } from "../cli/core/mode";
import { resolvePaths } from "../cli/core/paths";
import {
  ACTION_INTENT_CANONICALIZER,
  ActionIntentError,
  canonicalizeActionIntent,
  canonicalizePlannedAction,
  deriveActionIntentRepair,
  sameActionIntentSequence,
  validActionIntentRepair,
  type ActionIntentRepairV1,
  type ActionIntentV1,
} from "../cli/core/action-intent";
import {
  PlanningAuthorizationError,
  authorizationMessage,
  decideAuthorization,
  type AuthorizationDecision,
  type AuthorizationDenialCode,
} from "../cli/core/authorization-decision";
import {
  actionGraphForPlan, controlPlan, DEFAULT_PLANNING_AUTHORITY, normalizePlannedActions, planAllows,
  planExecutionProofHash, presentPlan, proposePlan, renderPlan, requestPlanExecution, reviewPlan, validState,
  PLAN_CONTRACT_VERSION,
  type PlanActionGraphNodeV1, type PlanControl, type PlanDependency, type PlanInput, type PlannedAction,
  type PlanScope, type PlanState, type PlanStateV5, type PlanningAdapter,
} from "../cli/core/planning";
import type { PlanningAuthority } from "../cli/core/planning-authority";
import {
  renderPlanRevisionPresentation,
  type PlanRevisionPresentationContext,
  type PlanPresentationView,
} from "../cli/core/plan-presentation";
import { detectSecretKinds, type PluginAdapterOptions } from "../cli/core/hooks/plugin-adapter";
import { MALAHOR_CODE_MODE_TOOL_NAMES } from "../cli/core/hooks/types";
import { isProtectedDocumentationPath, parsePatchOperations } from "../cli/core/documentation-boundary";
import { classifyReadOnlyShellCommand } from "../cli/core/read-only-shell-policy";
import { resolveDocsProject } from "../docs/resolver";
import {
  loadActivePlan,
  loadActivePlanRaw,
  loadPlanRecord,
  persistPlanState,
  type PlanningRetentionStorage,
} from "./plan-retention";
import { createExecutionGuard } from "./execution-guard";
import {
  createPlanRecovery,
  createPlanRevisionRecovery,
  loadPlanRevisionCandidate,
  planExecutionKey,
  validPlanExecutionCheckpoint,
  type PlanExecutionCheckpointV1,
  type PlanRecovery,
  type PlanRevisionCandidateV1,
  type RecoveryCorrelation,
} from "./plan-recovery";
import {
  COMMIT_MANIFEST_APPROVAL,
  isCommitPreparationTool,
  type CommitWorkflowRegistry,
  type CommitWorkflowScope,
} from "./commit-workflow";
import {
  POINT_ACTION_APPROVAL,
  type PointActionCall,
  type PointActionMediator,
  type PointActionScope,
} from "./point-action-approval";

export type PlanningStorage = PlanningRetentionStorage;

export { planKey, planRecordKey, planRevisionKey } from "./plan-retention";

interface ApprovalPort {
  assert(input: {
    sessionID: string;
    agent: string;
    source: { type: "tool"; messageID: string; id: string };
    action: string;
    resources: string[];
    save: string[];
  }): Promise<unknown>;
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

export interface PlanningTools {
  transform(callback: (editor: ToolEditor) => void): Promise<{ dispose?: () => Promise<void> | void } | void>;
}

const REVIEW_ACTION = "malahor_plan_review";
const RUN_ACTION = "malahor_plan_run";
const RESUME_ACTION = "malahor_plan_resume";
const COMPLETE_ACTION = "malahor_plan_complete";
const REPAIR_ACTION = "malahor_plan_repair";
const pendingRepairApprovals = new Set<string>();
const FOREGROUND_START = "<!-- malahor-plan-foreground:start -->";
const FOREGROUND_END = "<!-- malahor-plan-foreground:end -->";
const fallbackAuthority = DEFAULT_PLANNING_AUTHORITY;
const READ_ONLY_TOOLS = new Set([
  "read", "glob", "grep", "webfetch", "websearch", "list", "question", "skill",
  "todowrite", "todoread", "invalid", "malahor_plan", "malahor_run", "malahor_plan_control",
  ...MALAHOR_CODE_MODE_TOOL_NAMES,
]);
const PROTECTED = new Set(["edit", "shell", "subagent"]);
const CODE_READ_TOOLS = new Set(["read", "glob", "grep", ...MALAHOR_CODE_MODE_TOOL_NAMES]);

/** Solo las acciones declaradas se median aquí; las demás políticas del host siguen vigentes. */
export async function evaluatePlanningPermission(
  input: Record<string, unknown>, options: PluginAdapterOptions, storage?: PlanningStorage,
  authority: PlanningAuthority = fallbackAuthority,
  commitWorkflow?: CommitWorkflowRegistry,
  pointActions?: PointActionMediator,
): Promise<void> {
  const action = text(input.action);
  const normalized = permissionAction(action);
  if (input.effect === "deny") return;
  const resolved = await resolvePlanningScope(input.sessionID, options);
  if (action === POINT_ACTION_APPROVAL) {
    const root = resolved ? planningProjectRoot(resolved.scope.project, resolved.directory, options.env) : undefined;
    if (!root || !pointActions?.evaluateApprovalPermission(input, resolved
      ? pointScope(resolved.scope, root) : undefined)) {
      deny(input, "Aprobación puntual inválida, desactualizada o ajena a esta llamada.");
    }
    return;
  }
  if (action === COMMIT_MANIFEST_APPROVAL) {
    const root = resolved ? planningProjectRoot(resolved.scope.project, resolved.directory, options.env) : undefined;
    if (!root || !commitWorkflow?.evaluateApprovalPermission(input, resolved
      ? commitScope(resolved.scope, root) : undefined)) {
      deny(input, "Aprobación de manifest de commit inválida, desactualizada o ajena a esta llamada.");
    }
    return;
  }
  if (isCommitPreparationTool(action)) {
    if (resolved) {
      const root = planningProjectRoot(resolved.scope.project, resolved.directory, options.env);
      commitWorkflow?.observePreparationPermission({
        scope: commitScope(resolved.scope, root),
        action,
        effect: input.effect,
        source: input.source,
      });
    }
    return;
  }
  if (action === MODE_CHANGE_ACTION) {
    const resources = Array.isArray(input.resources) ? input.resources : [];
    if (!resolved || resources.length !== 3 || resources.some((item) => typeof item !== "string")) {
      deny(input, "Cambio de modo sin sesion/proyecto o preview estructurado.");
      return;
    }
    try {
      const [configFile, current, target] = resources as string[];
      const env = { ...options.env ?? process.env, MALAHOR_OPENCODE_DETECT: "0" };
      const preview = previewModeChange(parseModeName(target!), env, resolved.directory);
      if (preview.configFile !== configFile || preview.current !== current || preview.target !== target
        || preview.changes.length === 0) {
        deny(input, "El preview de cambio de modo ya no coincide con la configuracion.");
        return;
      }
      input.effect = "ask";
      input.message = `Cambiar modo Malahor: ${preview.current} -> ${preview.target}. Se creara respaldo, se invalidaran planes anteriores y aplicara desde el siguiente turno de esta sesion.`;
    } catch {
      deny(input, "Cambio de modo invalido o desactualizado.");
    }
    return;
  }
  if (action === REVIEW_ACTION || action === RUN_ACTION || action === RESUME_ACTION || action === COMPLETE_ACTION) {
    const state = resolved && await readPlan(storage, resolved.scope.sessionID, authority);
    const digest = Array.isArray(input.resources) ? input.resources[0] : undefined;
    let revision: PlanRevisionCandidateV1 | undefined;
    if (state?.version === 5 && (action === REVIEW_ACTION || action === RUN_ACTION) && storage) {
      try { revision = await loadPlanRevisionCandidate(storage, state, authority); }
      catch {
        deny(input, "La revisión candidata persistida no es verificable.");
        return;
      }
    }
    const approvalState = revision && digest === revision.candidate.digest
      ? revision.candidate
      : state;
    if (!approvalState || approvalState.version !== 5 || digest !== approvalState.digest
      || approvalState.project !== resolved?.scope.project
      || approvalState.mode !== resolved.scope.mode || approvalState.policyRevision !== resolved.scope.policyRevision
      || (action === REVIEW_ACTION && (approvalState.mode !== "assistant" || approvalState.phase !== "presented"
        || (revision !== undefined && revision.phase !== "presented")))
      || (action === RUN_ACTION && (approvalState.mode === "advisor" || approvalState.plan.actions.length === 0
        || (approvalState.mode === "assistant" ? approvalState.phase !== "reviewed" : approvalState.phase !== "presented")
        || (revision !== undefined && revision.phase !== (approvalState.mode === "assistant" ? "reviewed" : "presented"))))
      || (action === RESUME_ACTION && !["paused", "blocked"].includes(approvalState.phase))
      || (action === COMPLETE_ACTION && !["running", "paused"].includes(approvalState.phase))) {
      deny(input, "Plan no vigente o confirmacion fuera de orden.");
      return;
    }
    input.effect = "ask"; // Nunca heredar una aprobacion persistente 'always'.
    input.message = action === REVIEW_ACTION
      ? `Revisa el plan; esta primera confirmacion NO autoriza ejecutar:\n${renderPlan(approvalState)}`
      : action === RESUME_ACTION ? `Reanuda SOLO el plan y revision mostrados:\n${renderPlan(approvalState)}`
        : action === COMPLETE_ACTION ? `Confirma el cierre del plan; puede desbloquear dependencias, pero no inicia otros planes:\n${renderPlan(approvalState)}`
        : approvalState.mode === "executor"
        ? `Aprobacion previa del plan para ejecutar SOLO sus acciones:\n${renderPlan(approvalState)}`
        : `Segunda confirmacion: ejecuta SOLO las acciones del plan revisado:\n${renderPlan(approvalState)}`;
    return;
  }
  if (action === REPAIR_ACTION) {
    await evaluateRepairApproval(input, resolved, storage, options, authority);
    return;
  }
  const projectRoot = resolved
    ? planningProjectRoot(resolved.scope.project, resolved.directory, options.env)
    : undefined;

  // La evidencia de un ASK nativo se registra antes de cualquier retorno: el
  // contrato puntual exige reutilizar ese aviso y no abrir un segundo diálogo.
  if (normalized === "edit" && resolved && projectRoot && storage && resolved.scope.mode !== "advisor") {
    const rawState = await loadActivePlanRaw(storage, resolved.scope.sessionID);
    if (noActivePlan(rawState, authority) && pointActions?.observePermission({
      scope: pointScope(resolved.scope, projectRoot),
      directory: resolved.directory,
      action: normalized,
      resources: Array.isArray(input.resources) ? input.resources : [],
      effect: input.effect,
      source: input.source,
      toolRegistered: options.toolRegistered === true,
    })) return;
  }

  // Un ASK del host ya fue atribuido por observePlanningPermissionOutcome.
  // Planning no lo convierte en DENY ni lo trata como aprobación persistente.
  if (input.effect === "ask") return;

  if (CODE_READ_TOOLS.has(action) && resolved?.scope.mode === "advisor") {
    deny(input, "Asesor: no consulta archivos de codigo ni verifica la implementacion.");
    return;
  }
  if (!PROTECTED.has(normalized)) {
    if (action && !READ_ONLY_TOOLS.has(action) && !routineTool(action) && action !== "*"
      && action !== "external_directory") deny(input, `Tool no clasificada para planeacion: ${action}`);
    return;
  }
  if (normalized === "subagent" && resolved?.scope.mode !== "advisor"
    && directDiagnosticPermission(input.resources)) return;
  if (normalized === "shell" && resolved && projectRoot && resolved.scope.mode !== "advisor") {
    const candidate = permissionShellCandidate(input, projectRoot);
    const commitDecision = commitWorkflow?.authorizeShell({
      ...commitScope(resolved.scope, projectRoot),
      ...candidate,
      boundary: "permission",
    });
    if (commitDecision?.effect === "allow") return;
    if (commitDecision?.effect === "deny") {
      denyDecision(input, commitDecision);
      return;
    }
  }
  if (resolved && normalized !== "shell" && PROTECTED.has(normalized)) {
    commitWorkflow?.invalidate(resolved.scope.sessionID);
  }
  if (normalized === "shell" && resolved && resolved.scope.mode !== "advisor" && projectRoot
    && readOnlyShellResources(input.resources, projectRoot, resolved.directory)) return;
  if (!resolved || !storage) {
    deny(input, "No hay proyecto/sesion o almacenamiento de planeacion mediable.");
    return;
  }
  if (resolved.scope.mode === "advisor") {
    deny(input, "El asesor no ejecuta acciones de programacion ni con una solicitud explicita.");
    return;
  }
  if (normalized !== "subagent" && await delegatedSpecialist(input.sessionID, resolved.scope, options, storage, authority)) return;
  const resources = Array.isArray(input.resources) ? input.resources : [];
  const rawState = await loadActivePlanRaw(storage, resolved.scope.sessionID);
  const decision = authorizeResources(
    rawState,
    resolved.scope,
    normalized,
    resources,
    resolved.directory,
    projectRoot ?? resolved.directory,
    undefined,
    authority,
  );
  if (decision.effect === "repair") {
    if (options.toolRegistered !== true || !attributedToolSource(input.source)) {
      denyDecision(input, { effect: "deny", code: "CRITICAL_CONTROL_UNAVAILABLE" });
    }
    return;
  }
  if (decision.effect !== "allow") {
    denyDecision(input, decision);
    return;
  }
  if (validState(rawState, authority) && rawState.version === 5) {
    const operations = resources.map((resource) => normalizeAction(normalized, resource as string, resolved.directory));
    const actionIDs = matchedOperationActionIDs(
      rawState,
      operations,
      resolved.directory,
      projectRoot ?? resolved.directory,
      permissionOperationCwd(input, resolved.directory),
    );
    const checkpoint = await authorizeCheckpointActions(
      rawState,
      actionIDs,
      storage,
      authority,
      resolved.directory,
      projectRoot ?? resolved.directory,
      permissionToolCall(input),
    );
    if (checkpoint.effect === "deny") denyDecision(input, checkpoint);
  }
}

/**
 * Conserva el resultado autoritativo del host antes de que el PDP de Planning
 * evalúe la acción. Una segunda llamada en allow solo limpia un blocker si la
 * correlación exacta sigue vigente.
 */
export async function observePlanningPermissionOutcome(
  input: Record<string, unknown>,
  hostEffect: unknown,
  options: PluginAdapterOptions,
  storage?: PlanningStorage,
  authority: PlanningAuthority = fallbackAuthority,
): Promise<void> {
  if (!storage || !["allow", "warn", "ask", "deny"].includes(String(hostEffect))) return;
  const normalized = permissionAction(text(input.action));
  if (!PROTECTED.has(normalized)) return;
  const resolved = await resolvePlanningScope(input.sessionID, options);
  if (!resolved) return;
  const raw = await loadActivePlanRaw(storage, resolved.scope.sessionID);
  if (!validState(raw, authority) || raw.version !== 5 || raw.phase !== "running") return;
  const projectRoot = planningProjectRoot(resolved.scope.project, resolved.directory, options.env);
  const resources = Array.isArray(input.resources) && input.resources.every((item) => typeof item === "string")
    ? input.resources as string[]
    : [];
  const operations = resources.map((resource) => normalizeAction(normalized, resource, resolved.directory));
  const actionIDs = matchedOperationActionIDs(
    raw,
    operations,
    resolved.directory,
    projectRoot,
    permissionOperationCwd(input, resolved.directory),
  );
  const recovery = recoveryForState(raw, storage, authority, resolved.directory, projectRoot);
  if (!actionIDs?.length) {
    if (hostEffect === "ask" || hostEffect === "deny") {
      await recovery.recordUndeclaredAction({
        actionID: "f".repeat(64),
        optional: optionalDiagnosticPermission(input),
        source: optionalDiagnosticPermission(input) ? "diagnostic" : "tool",
      });
    }
    return;
  }
  const call = permissionToolCall(input);
  if (!call) {
    if (hostEffect === "ask" || hostEffect === "deny") {
      await recovery.setCommonBlocker({
        code: "CRITICAL_CONTROL_UNAVAILABLE",
        class: "critical-control",
        control: "integrity",
        boundary: "permission.evaluate",
      });
      deny(input, "La decisión del host no incluye una correlación de tool verificable.");
    }
    return;
  }
  const effect = hostEffect === "ask" ? "ask" : hostEffect === "deny" ? "deny" : "allow";
  for (const actionID of actionIDs) {
    await recovery.recordPermissionDecision({
      ...recoveryCorrelation(raw, actionID, call, input),
      effect,
      boundary: "permission.evaluate",
    });
  }
}

/** Segunda frontera: rutas directas y argumentos de tool, no solo permission.evaluate. */
export async function evaluatePlanningTool(
  input: Record<string, unknown>, options: PluginAdapterOptions, storage?: PlanningStorage,
  authority: PlanningAuthority = fallbackAuthority,
  approvals?: ApprovalPort,
  commitWorkflow?: CommitWorkflowRegistry,
  pointActions?: PointActionMediator,
): Promise<void> {
  const tool = text(input.tool);
  if (isCommitPreparationTool(tool)) return;
  if (routineTool(tool)) return;
  if (["question", "list", "todowrite", "todoread", "invalid"].includes(tool)) return;
  const resolved = await resolvePlanningScope(input.sessionID, options);
  if (!resolved) throw new Error("Malahor: sesion/proyecto de planeacion no mediable.");
  if (CODE_READ_TOOLS.has(tool) && resolved.scope.mode === "advisor") {
    throw new Error("Malahor: asesor no consulta archivos de codigo.");
  }
  if (READ_ONLY_TOOLS.has(tool)) return;
  if (resolved.scope.mode === "advisor") {
    throw new Error("Malahor: el asesor no ejecuta acciones de programacion.");
  }
  const projectRoot = planningProjectRoot(resolved.scope.project, resolved.directory, options.env);
  if (directDiagnosticTool(tool, input.input, input.agent)) return;
  if (tool === "shell" || tool === "bash") {
    const candidate = toolShellCandidate(input, resolved.directory, projectRoot);
    const commitDecision = commitWorkflow?.authorizeShell({
      ...commitScope(resolved.scope, projectRoot),
      ...candidate,
      boundary: "tool",
    });
    if (commitDecision?.effect === "allow") return;
    if (commitDecision?.effect === "deny") {
      throw new PlanningAuthorizationError(commitDecision.code);
    }
  } else if (["edit", "write", "patch", "subagent", "task"].includes(tool)) {
    commitWorkflow?.invalidate(resolved.scope.sessionID);
  }
  if (readOnlyShellTool(tool, input.input, projectRoot, resolved.directory)) return;
  if (!storage) throw new Error("Malahor: sesion/proyecto de planeacion no mediable.");
  if (["edit", "write", "patch"].includes(tool) && approvals && pointActions) {
    const rawState = await loadActivePlanRaw(storage, resolved.scope.sessionID);
    if (noActivePlan(rawState, authority)) {
      const call = pointToolCall(input);
      if (call && await pointActions.authorizeTool({
        scope: pointScope(resolved.scope, projectRoot),
        directory: resolved.directory,
        tool,
        value: input.input,
        call,
        approval: approvals,
        revalidate: async () => {
          const fresh = await resolvePlanningScope(input.sessionID, options);
          if (!fresh) return undefined;
          const freshRoot = planningProjectRoot(fresh.scope.project, fresh.directory, options.env);
          const freshState = await loadActivePlanRaw(storage, fresh.scope.sessionID);
          return {
            scope: pointScope(fresh.scope, freshRoot),
            noActivePlan: noActivePlan(freshState, authority),
          };
        },
      })) return;
    }
  }
  if (["edit", "write", "patch", "shell", "bash"].includes(tool)
    && await delegatedSpecialist(input.sessionID, resolved.scope, options, storage, authority)) return;
  const actions = toolActions(tool, input.input, resolved.directory);
  const rawState = await loadActivePlanRaw(storage, resolved.scope.sessionID);
  const args = isRecord(input.input) ? input.input : {};
  const operationCwd = typeof args.workdir === "string" ? path.resolve(resolved.directory, args.workdir)
    : typeof args.cwd === "string" ? path.resolve(resolved.directory, args.cwd)
      : resolved.directory;
  const decision = authorizeOperations(
    rawState,
    resolved.scope,
    actions,
    resolved.directory,
    projectRoot,
    operationCwd,
    authority,
  );
  if (decision.effect === "repair") {
    if (!validState(rawState, authority) || rawState.version !== 5 || !approvals) {
      throw new PlanningAuthorizationError("CRITICAL_CONTROL_UNAVAILABLE");
    }
    await applyRepairAuthorization(
      input,
      decision.candidate,
      decision.declaredActionIDs,
      rawState,
      approvals,
      storage,
      authority,
      projectRoot,
      resolved.directory,
    );
    return;
  }
  if (decision.effect === "deny") throw new PlanningAuthorizationError(decision.code, decision.safeDetail);
  if (decision.effect === "defer") {
    throw new PlanningAuthorizationError("CRITICAL_CONTROL_UNAVAILABLE", "La acción no alcanzó su frontera autoritativa.");
  }
  if (validState(rawState, authority) && rawState.version === 5) {
    const actionIDs = matchedOperationActionIDs(
      rawState,
      actions,
      resolved.directory,
      projectRoot,
      operationCwd,
    );
    const checkpoint = await authorizeCheckpointActions(
      rawState,
      actionIDs,
      storage,
      authority,
      resolved.directory,
      projectRoot,
      toolCallIdentity(input),
    );
    if (checkpoint.effect === "deny") throw new PlanningAuthorizationError(checkpoint.code, checkpoint.safeDetail);
    if (options.toolRegistered === true) {
      await reservePlanningToolCall(
        input,
        rawState,
        actionIDs,
        storage,
        authority,
        resolved.directory,
        projectRoot,
      );
    }
  }
}

/** Cierra reservas creadas en tool.execute.before sin inferir éxito por ausencia de error. */
export async function completePlanningTool(
  input: Record<string, unknown>,
  options: PluginAdapterOptions,
  storage?: PlanningStorage,
  authority: PlanningAuthority = fallbackAuthority,
): Promise<{ ok: boolean; completed: number; reason?: string }> {
  if (!storage) return { ok: false, completed: 0, reason: "storage de Planning no disponible" };
  const resolved = await resolvePlanningScope(input.sessionID, options);
  if (!resolved) return { ok: false, completed: 0, reason: "sesión/proyecto no evaluable" };
  const raw = await loadActivePlanRaw(storage, resolved.scope.sessionID);
  if (!validState(raw, authority) || raw.version !== 5 || raw.phase !== "running") {
    return { ok: true, completed: 0 };
  }
  const call = toolCallIdentity(input);
  const projectRoot = planningProjectRoot(resolved.scope.project, resolved.directory, options.env);
  const recovery = recoveryForState(raw, storage, authority, resolved.directory, projectRoot);
  if (!call) {
    await recovery.setCommonBlocker({
      code: "CRITICAL_CONTROL_UNAVAILABLE",
      class: "critical-control",
      control: "integrity",
      boundary: "tool.execute.after",
    });
    return { ok: false, completed: 0, reason: "resultado sin correlación exacta" };
  }
  const checkpoint = await recovery.snapshot();
  const reservations = Object.values(checkpoint.reservations).filter((reservation) =>
    reservation.sessionID === call.sessionID && reservation.messageID === call.messageID
      && reservation.callID === call.id);
  if (reservations.length === 0) return { ok: true, completed: 0 };
  const status = toolCompletionStatus(input);
  let completed = 0;
  for (const reservation of reservations) {
    const result = await recovery.completeToolCall({
      sessionID: reservation.sessionID,
      messageID: reservation.messageID,
      callID: reservation.callID,
      planID: reservation.planID,
      revision: reservation.revision,
      actionID: reservation.actionID,
      policyHash: reservation.policyHash,
      resourceHash: reservation.resourceHash,
      reservationID: reservation.reservationID,
      status,
    });
    if (result.code === "ACTION_SUCCEEDED" || result.code === "TECHNICAL_RETRY") completed++;
  }
  return { ok: true, completed };
}

export async function registerPlanningTools(
  tools: PlanningTools, approvals: ApprovalPort, storage: PlanningStorage, options: PluginAdapterOptions,
  authority: PlanningAuthority = fallbackAuthority,
): Promise<{ dispose?: () => Promise<void> | void } | void> {
  return tools.transform((editor) => {
    editor.namespace({ name: "malahor", description: "Plan de trabajo portable de Malahor" });
    editor.add({
      name: "plan",
      description: "Registra un plan de alcance considerable derivado de una especificacion SDD (nivel 1 o 2) y devuelve su Markdown para presentarlo en foreground exactamente una vez. Las acciones puntuales no usan esta tool.",
      input: {
        type: "object", properties: {
          level: { type: "integer", enum: [1, 2] },
          specRef: { type: "string", pattern: "^SDD/.+\\.md$" },
          specHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          summary: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          presentation: {
            type: "object", properties: {
              objective: { type: "string" },
              outcome: { type: "string" },
              steps: { type: "array", items: {
                type: "object", properties: {
                  title: { type: "string" }, description: { type: "string" },
                },
                required: ["title", "description"], additionalProperties: false,
              }, maxItems: 5 },
              impact: { type: "array", items: {
                type: "object", properties: {
                  area: { type: "string" }, description: { type: "string" },
                },
                required: ["area", "description"], additionalProperties: false,
              } },
              risk: {
                type: "object", properties: {
                  level: { type: "string", enum: ["low", "medium", "high"] },
                  categories: { type: "array", uniqueItems: true, items: {
                    type: "string", enum: ["security", "data", "architecture", "destructive"],
                  } },
                  summary: { type: "string" }, details: { type: "string" },
                },
                required: ["level", "categories", "summary", "details"], additionalProperties: false,
              },
              exclusions: { type: "array", items: { type: "string" } },
              completionCriteria: { type: "array", items: { type: "string" } },
            },
            required: ["objective", "outcome", "steps", "impact", "risk", "exclusions", "completionCriteria"],
            additionalProperties: false,
          },
          actions: { type: "array", items: {
            type: "object", properties: {
              key: { type: "string" },
              action: { type: "string" },
              resource: { type: "string" },
              dependsOn: { type: "array", uniqueItems: true, items: { type: "string" } },
            },
            required: ["action", "resource"], additionalProperties: false,
          } },
          dependencies: { type: "array", items: {
            type: "object", properties: { planID: { type: "string" }, revision: { type: "string" } },
            required: ["planID", "revision"], additionalProperties: false,
          } },
        }, required: ["level", "specRef", "specHash", "summary", "steps", "presentation", "actions"], additionalProperties: false,
      },
      options: { namespace: "malahor", codemode: false },
      execute: async (value: unknown, call: ToolCall) => {
        const resolved = await requireScope(call, options);
        if (call.agent !== "malahor") throw new Error("Solo el primario puede presentar el plan.");
        const raw = value as PlanInput;
        if (raw.level !== 1 && raw.level !== 2) {
          throw new Error("malahor_plan requiere level 1 o 2 y una especificacion SDD versionada.");
        }
        if (typeof raw.specRef !== "string" || typeof raw.specHash !== "string") {
          throw new Error("malahor_plan requiere specRef y specHash de una especificacion SDD versionada.");
        }
        verifySddSpec(raw.specRef, raw.specHash, resolved.scope.project, resolved.directory, options.env);
         if (detectSecretKinds(raw).length > 0) throw new Error("Posible secreto en el plan: no se almacena ni se muestra.");
         const actions = raw.actions?.map((item) => normalizeAction(
           item.action,
           item.resource,
           resolved.directory,
           item.key,
           item.dependsOn,
         ));
         const projectRoot = planningProjectRoot(resolved.scope.project, resolved.directory, options.env);
        const newRepoDoc = actions?.find((item) => item.action === "edit"
          && isProtectedDocumentationPath(projectRoot, item.resource) && !fs.existsSync(item.resource));
         if (newRepoDoc) throw new Error(`La documentacion operativa nueva debe ir al vault externo: ${newRepoDoc.resource}`);
        const normalizedActions = normalizePlannedActions(actions ?? []);
        const intentContext = {
           project: resolved.scope.project,
           root: projectRoot,
           rootRef: "project",
           cwd: resolved.directory,
        } as const;
        const intentGroups = normalizedActions.map((action) => ({
          action,
          intents: canonicalizePlannedAction(action, intentContext),
        }));
        const actionIntents = intentGroups.flatMap((group) => group.intents);
        const actionGraph = actionGraphFromGroups(intentGroups);
        return presentPlanningChange({
          input: {
            ...raw,
            actions: normalizedActions,
            contractVersion: PLAN_CONTRACT_VERSION,
            canonicalizerVersion: ACTION_INTENT_CANONICALIZER,
            actionIntents,
            actionGraph,
          },
          resolved,
          projectRoot,
          storage,
          approvals,
          call,
          authority,
        });
      },
    });
    editor.add({
      name: "run",
      description: "En un turno posterior al plan, resuelve el plan activo firmado y solicita la segunda confirmacion del asistente o la aprobacion previa del ejecutor. El digest explicito es opcional y solo se conserva por compatibilidad. No ejecuta herramientas por si misma.",
      input: { type: "object", properties: { digest: { type: "string" } }, additionalProperties: false },
      options: { namespace: "malahor", codemode: false },
      execute: async (value: unknown, call: ToolCall) => {
        const resolved = await requireScope(call, options);
        if (call.agent !== "malahor") throw new Error("Solo el primario puede solicitar ejecucion.");
        const result = await requestPlanningExecution({
          value,
          resolved,
          storage,
          approvals,
          call,
          options,
          authority,
        });
        return { content: result.content, metadata: {
          kind: "malahor.plan.state", version: 1,
          planID: result.state.planID, revision: result.state.revision, phase: result.state.phase,
        } };
      },
    });
    editor.add({
      name: "plan_control",
      description: "Consulta, pausa, reanuda, revoca o completa el plan activo sin ampliar sus efectos.",
      input: { type: "object", properties: {
        action: { type: "string", enum: ["status", "pause", "resume", "revoke", "complete"] },
      }, required: ["action"], additionalProperties: false },
      options: { namespace: "malahor", codemode: false },
      execute: async (value: unknown, call: ToolCall) => {
        const resolved = await requireScope(call, options);
        if (call.agent !== "malahor") throw new Error("Solo el primario puede controlar el plan.");
        const action = text((value as { action?: unknown }).action) as PlanControl;
        if (!["status", "pause", "resume", "revoke", "complete"].includes(action)) {
          throw new Error("Control de plan invalido.");
        }
        if (action === "complete") {
          const active = await readPlan(storage, resolved.scope.sessionID, authority);
          if (active) await assertPlanningCompletionReady(storage, active, authority);
        }
        const state = await controlPlan(resolved.scope, action,
          planningAdapter(storage, approvals, call, authority), authority);
        return { content: renderPlan(state) };
      },
    });
  });
}

async function presentPlanningChange(input: {
  input: PlanInput;
  resolved: { scope: PlanScope; directory: string };
  projectRoot: string;
  storage: PlanningStorage;
  approvals: ApprovalPort;
  call: ToolCall;
  authority: PlanningAuthority;
}): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const { resolved, storage, approvals, call, authority } = input;
  const active = await readPlan(storage, resolved.scope.sessionID, authority);
  if (active?.version === 5 && (active.phase === "running" || active.phase === "paused")
    && planMatchesScope(active, resolved.scope)) {
    const checkpoint = await recoveryForState(
      active,
      storage,
      authority,
      resolved.directory,
      input.projectRoot,
    ).snapshot();
    const manager = createPlanRevisionRecovery({ parent: active, checkpoint, storage, authority });
    let candidate = proposePlan(
      resolved.scope,
      input.input,
      Date.now(),
      call.messageID,
      active.planID,
      authority,
    );
    await assertRevisionDependencies(candidate, storage, authority);
    let revision = await manager.presentCandidate(candidate);
    if (active.mode === "assistant") {
      await ask(approvals, call, REVIEW_ACTION, candidate.digest);
      candidate = reviewPlan(candidate, candidate.digest, Date.now(), authority);
      revision = await manager.presentCandidate(candidate);
    }
    return {
      content: foregroundPlanRevisionResult(revision, checkpoint),
      metadata: {
        kind: "malahor.plan.revision-presentation",
        version: 1,
        planID: revision.planID,
        revision: revision.candidate.revision,
        digest: revision.candidate.digest,
        phase: revision.phase,
      },
    };
  }
  if (active?.version === 5 && active.phase === "blocked") {
    throw new Error("El plan espera dependencias externas; resuélvelas antes de presentar una revisión material.");
  }
  const state = await presentPlan(
    resolved.scope,
    input.input,
    call.messageID,
    planningAdapter(storage, approvals, call, authority),
    authority,
  );
  return {
    content: foregroundPlanResult(state),
    metadata: {
      kind: "malahor.plan.presentation",
      version: 1,
      planID: state.planID,
      revision: state.revision,
      digest: state.digest,
      phase: state.phase,
    },
  };
}

async function requestPlanningExecution(input: {
  value: unknown;
  resolved: { scope: PlanScope; directory: string };
  storage: PlanningStorage;
  approvals: ApprovalPort;
  call: ToolCall;
  options: PluginAdapterOptions;
  authority: PlanningAuthority;
}): Promise<{ state: PlanStateV5; content: string }> {
  const { value, resolved, storage, approvals, call, options, authority } = input;
  if (!isRecord(value)) throw new Error("Entrada de malahor_run no evaluable.");
  const active = await readPlan(storage, resolved.scope.sessionID, authority);
  if (active?.version === 5 && (active.phase === "running" || active.phase === "paused")) {
    const revision = await loadPlanRevisionCandidate(storage, active, authority);
    if (!revision) throw new Error("No hay una revisión candidata vigente para ejecutar.");
    const candidate = revision.candidate;
    const provided = value.digest;
    if (provided !== undefined && text(provided) !== candidate.digest) {
      throw new Error("El digest explícito no coincide con la revisión candidata vigente.");
    }
    if (revision.phase === "stale"
      || (candidate.mode === "assistant" ? revision.phase !== "reviewed" : revision.phase !== "presented")
      || candidate.presentationInteractionID === call.messageID) {
      throw new Error("La revisión candidata no puede ejecutarse en este turno o ya no está vigente.");
    }

    await assertRevisionDependencies(candidate, storage, authority);
    await ask(approvals, call, RUN_ACTION, candidate.digest);

    const freshResolved = await requireScope(call, options);
    const freshParent = await readPlan(storage, freshResolved.scope.sessionID, authority);
    if (!freshParent || freshParent.version !== 5 || !sameRunningParent(active, freshParent)
      || !samePlanScopeValue(resolved.scope, freshResolved.scope)
      || resolved.directory !== freshResolved.directory) {
      throw new Error("La revisión padre, el proyecto o la política cambiaron durante la aprobación.");
    }
    const freshRevision = await loadPlanRevisionCandidate(storage, freshParent, authority);
    if (!freshRevision || freshRevision.proof !== revision.proof
      || freshRevision.candidate.proof !== candidate.proof
      || freshRevision.phase !== revision.phase) {
      throw new Error("La revisión candidata cambió durante la aprobación.");
    }
    await assertRevisionDependencies(freshRevision.candidate, storage, authority);
    const pending = await pendingRevisionDependencies(freshRevision.candidate, storage, authority);
    const projectRoot = planningProjectRoot(
      freshResolved.scope.project,
      freshResolved.directory,
      options.env,
    );
    const checkpoint = await recoveryForState(
      freshParent,
      storage,
      authority,
      freshResolved.directory,
      projectRoot,
    ).snapshot();
    const activated = await createPlanRevisionRecovery({
      parent: freshParent,
      checkpoint,
      storage,
      authority,
    }).activateCandidate(freshRevision.candidate.revision, pending);
    return {
      state: activated.active,
      content: renderPlanRevision(
        freshRevision,
        activated.checkpoint,
        "summary",
        activated.active,
      ),
    };
  }

  if (!active) throw new Error("No hay un plan activo firmado para solicitar ejecucion.");
  const provided = value.digest;
  if (provided !== undefined && text(provided) !== active.digest) {
    throw new Error("El digest explícito no coincide con el plan activo vigente.");
  }
  const state = await requestPlanExecution(
    resolved.scope,
    active.digest,
    call.messageID,
    planningAdapter(storage, approvals, call, authority),
    authority,
  );
  return { state, content: renderPlan(state) };
}

async function assertRevisionDependencies(
  state: PlanStateV5,
  storage: PlanningStorage,
  authority: PlanningAuthority,
): Promise<void> {
  const visit = async (dependencies: PlanDependency[], trail: Set<string>): Promise<void> => {
    for (const dependency of dependencies) {
      if (dependency.planID === state.planID || trail.has(dependency.planID)) {
        throw new Error("Ciclo de dependencias de plan detectado en la revisión candidata.");
      }
      const raw = await loadPlanRecord(storage, dependency.planID, authority);
      if (!raw || raw.project !== state.project || raw.revision !== dependency.revision) {
        throw new Error(`Dependencia de plan no evaluable: ${dependency.planID}.`);
      }
      const next = new Set(trail);
      next.add(dependency.planID);
      await visit(raw.plan.dependencies, next);
    }
  };
  await visit(state.plan.dependencies, new Set([state.planID]));
}

async function pendingRevisionDependencies(
  state: PlanStateV5,
  storage: PlanningStorage,
  authority: PlanningAuthority,
): Promise<PlanDependency[]> {
  const pending: PlanDependency[] = [];
  for (const dependency of state.plan.dependencies) {
    const raw = await loadPlanRecord(storage, dependency.planID, authority);
    if (!raw || raw.project !== state.project || raw.revision !== dependency.revision
      || raw.phase !== "completed") {
      pending.push(dependency);
    }
  }
  return pending;
}

function sameRunningParent(expected: PlanStateV5, value: PlanStateV5): boolean {
  return value.planID === expected.planID && value.revision === expected.revision
    && value.digest === expected.digest && value.proof === expected.proof
    && value.phase === expected.phase;
}

function samePlanScopeValue(left: PlanScope, right: PlanScope): boolean {
  return left.sessionID === right.sessionID && left.project === right.project
    && left.mode === right.mode && left.policyRevision === right.policyRevision;
}

function planMatchesScope(state: PlanState, scope: PlanScope): boolean {
  return state.sessionID === scope.sessionID && state.project === scope.project
    && state.mode === scope.mode && state.policyRevision === scope.policyRevision;
}

export function renderPlanRevision(
  revision: PlanRevisionCandidateV1,
  checkpoint: PlanExecutionCheckpointV1,
  view: PlanPresentationView = "summary",
  state: PlanStateV5 = revision.candidate,
): string {
  return renderPlanRevisionPresentation(
    state,
    revisionPresentationContext(revision, checkpoint),
    view,
  );
}

function revisionPresentationContext(
  revision: PlanRevisionCandidateV1,
  checkpoint: PlanExecutionCheckpointV1,
): PlanRevisionPresentationContext {
  const counts = {
    total: 0,
    succeeded: 0,
    ready: 0,
    waiting: 0,
    blocked: 0,
    inFlight: 0,
    failed: 0,
  };
  for (const node of Object.values(checkpoint.nodes)) {
    counts.total++;
    if (node.state === "succeeded") counts.succeeded++;
    else if (node.state === "ready") counts.ready++;
    else if (node.state === "waiting") counts.waiting++;
    else if (node.state === "blocked") counts.blocked++;
    else if (node.state === "in-flight") counts.inFlight++;
    else if (node.state === "failed") counts.failed++;
  }
  return {
    parentRevision: revision.parent.revision,
    progress: counts,
    delta: revision.delta,
  };
}

function foregroundPlanRevisionResult(
  revision: PlanRevisionCandidateV1,
  checkpoint: PlanExecutionCheckpointV1,
): string {
  return [
    FOREGROUND_START,
    renderPlanRevision(revision, checkpoint),
    FOREGROUND_END,
    "",
    "Publica solo el bloque delimitado, exactamente una vez como mensaje normal, y termina el turno.",
  ].join("\n");
}

function foregroundPlanResult(state: PlanState): string {
  return [
    FOREGROUND_START,
    renderPlan(state),
    FOREGROUND_END,
    "",
    "Publica solo el bloque delimitado, exactamente una vez como mensaje normal, y termina el turno.",
  ].join("\n");
}

function planningAdapter(
  storage: PlanningStorage,
  port: ApprovalPort,
  call: ToolCall,
  authority: PlanningAuthority,
): PlanningAdapter {
  return {
    loadActive: (sessionID) => loadActivePlanRaw(storage, sessionID),
    loadPlan: (planID) => loadPlanRecord(storage, planID, authority),
    save: (state) => persistPlanState(storage, state, authority).then(() => undefined),
    confirm: (kind, state) => ask(port, call,
      kind === "review" ? REVIEW_ACTION : kind === "run" ? RUN_ACTION
        : kind === "resume" ? RESUME_ACTION : COMPLETE_ACTION, state.digest),
  };
}

/** El subagente hereda SOLO la delegacion explicitamente autorizada; el host conserva sus permisos propios. */
async function delegatedSpecialist(
  sessionID: unknown, scope: PlanScope, options: PluginAdapterOptions, storage?: PlanningStorage,
  authority: PlanningAuthority = fallbackAuthority,
): Promise<boolean> {
  if (!storage || typeof sessionID !== "string" || !options.resolveParentSession) return false;
  try {
    const parent = await options.resolveParentSession(sessionID);
    if (!parent || !["malahor-diagnostico", "malahor-testing"].includes(parent.agent)) return false;
    const state = await readPlan(storage, parent.parentID, authority);
    return planAllows(state, { ...scope, sessionID: parent.parentID }, { action: "subagent", resource: parent.agent }, Date.now(), authority);
  } catch { return false; }
}

export async function injectPlanningInstructions(
  input: Record<string, unknown>, options: PluginAdapterOptions, storage?: PlanningStorage,
  authority: PlanningAuthority = fallbackAuthority,
): Promise<void> {
  // Los especialistas tienen permisos propios; la mediacion de su lanzamiento es del primario.
  if (input.agent !== "malahor") return;
  const resolved = await resolvePlanningScope(input.sessionID, options);
  const state = resolved && await readPlan(storage, resolved.scope.sessionID, authority);
  const mode = resolved?.scope.mode;
  const instructions = !resolved || !storage
    ? "Planeacion Malahor no disponible: no ejecutes operaciones de programacion. Revisa proyecto registrado y adaptador del host."
    : mode === "advisor"
      ? "Modo asesor: presenta solo concepto/alternativas; sin pasos, rutas de implementacion ni ejecucion. Si usas malahor_plan, declara level 1 o 2; steps, presentation.steps, presentation.impact y actions van vacios."
      : [
        `Modo ${mode}: clasifica cada solicitud en inspeccion directa, accion puntual o trabajo considerable.`,
        "Las lecturas, listados, Git read-only y el especialista malahor-diagnostico se ejecutan directamente sin plan, go ni aprobacion redundante.",
        "Una unica edicion de bajo riesgo sobre un archivo regular existente no usa Planning ni SDD: define la llamada exacta y deja que el harness solicite una sola aprobacion nativa. No pidas go ni conviertas una accion ambigua en puntual.",
        "Creacion, borrado, movimiento, symlinks, multiples recursos, secretos, infraestructura, shell mutante y superficies criticas quedan fuera del carril puntual y fallan cerrados.",
        "Solo el trabajo considerable previamente expandido en una especificacion Markdown bajo SDD/ usa malahor_plan. Declara level 1 o 2 junto con specRef y specHash SHA-256 de esa version canonica.",
        mode === "assistant" ? "Para trabajo considerable guia por pasos; la tool solicita revision del plan y despues malahor_run solicita la segunda confirmacion para ejecutar."
          : "Para trabajo considerable presenta el plan y solicita su aprobacion previa mediante malahor_run ANTES de ejecutar.",
        "Commit explicito es un flujo especializado sin Planning: no uses malahor_plan, malahor_run ni pidas go. La orden solo habilita preparar el manifest; la autorizacion ejecutable procede de una unica aprobacion nativa de la UI.",
        "Para ese commit carga git-commit-text, inspecciona y prevalida el subject; luego usa malahor_commit_prepare para validar el manifest y solicitar una única aprobación nativa de rutas y comandos exactos antes de diagnostico, tests, build, stage, precommit, commit y revalidacion. Cualquier diferencia invalida el grant.",
        "Usa divulgacion progresiva: el resumen humano contiene objetivo, resultado, hasta cinco pasos, impacto, riesgo y una seccion 'Que debes hacer ahora' narrada en lenguaje tecnico comprensible.",
        "La vista normal no incrusta IDs, comandos ni el anexo tecnico; tampoco muestra rutas exactas.",
        "Ante un riesgo alto o una categoria critica, los riesgos, consecuencias y controles reforzados permanecen visibles en lenguaje humano. Los comandos, rutas, identidad y digest se muestran unicamente mediante /malahor-plan detalles.",
        "Despues de malahor_plan, copia el Markdown delimitado como una presentacion foreground exactamente una vez en un mensaje normal y termina este turno; no invoques malahor_run en la misma respuesta.",
        "Una traza u output tecnico del tool en background no cuenta como presentacion del plan y nunca sustituye el mensaje normal.",
        "Solo despues de presentar un plan derivado de SDD espera una solicitud posterior del usuario (por ejemplo, go o implementa) y entonces invoca malahor_run.",
        "malahor_run resuelve el plan activo firmado desde ctx.storage; no pidas al usuario el digest ni le exijas /malahor-plan detalles para ejecutar. Un digest explicito sigue siendo compatible y debe coincidir exactamente.",
        "Un go previo a la presentacion no aprueba un plan todavia no visto y nunca autoriza una accion puntual.",
        "El plan enumera rutas/comandos/subagentes exactos. Si cambian materialmente, presenta una revision nueva y vuelve a pedir confirmaciones.",
        "Los retries tecnicos con el mismo ActionIntentV1 reutilizan la revision V5; ASK, DENY, cambios materiales o loop guard bloquean sin auto-planificar.",
        "Un ASK, DENY o loop guard atribuible bloquea solo la accion exacta y sus descendientes declarados; las ramas firmadas e independientes continuan y conservan su progreso. Solo autoridad, storage, politica o integridad crean un bloqueo comun.",
        "Preguntas y respuestas no conceden autoridad ni limpian blockers. Tras una remediacion humana, relee el recurso y vuelve a cruzar la misma frontera; solo un allow verificable de la llamada exacta reanuda.",
        "Un cambio material usa una revision candidata del mismo plan: el padre sigue activo hasta aprobarla y solo se trasladan exitos con actionID y dependencias identicos, nunca blockers, nonces, reservas ni grants protegidos.",
        "Si un guardrail incluye remediacion estructurada y saneada, explicala para una persona no desarrolladora como bloques completos de referencia y reemplazo: archivo y linea, busca, reemplaza, guarda y revalida.",
        "Sin remediacion verificable no inventes lineas ni codigo ni pidas interpretar variables. ASK requiere aprobacion, hard DENY no tiene atajo y secretos reales o ambiguos se retiran o rotan; una edicion manual solo permite continuar despues de revalidar.",
        "Responder si, hecho, go o equivalente no limpia un blocker. Conserva el checkpoint y formula como maximo una pregunta accionable con causa, consecuencia, remediacion saneada y revalidacion.",
        "La autorizacion no caduca por tiempo. Pausa, reanuda, revoca o consulta estado con malahor_plan_control o /malahor-plan.",
        "Las dependencias bloquean sin heredar permisos ni arrancar automaticamente.",
        "Las aprobaciones de plan no autorizan commit, push, stage, instalacion local ni evitan guardrails.",
        state ? `Estado: ${state.phase}; plan ${state.planID.slice(0, 12)}; revision ${state.revision.slice(0, 12)}; sin caducidad temporal.`
          : "Estado: sin plan vigente.",
      ].join("\n");
  const system = Array.isArray(input.system) ? input.system : [];
  const marker = "<!-- malahor-planning:v5 -->";
  const previousMarkers = [
    "<!-- malahor-planning:v4 -->",
    "<!-- malahor-planning:v3 -->",
    "<!-- malahor-planning:v2 -->",
    "<!-- malahor-planning:v1 -->",
  ];
  for (const part of system) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    const text = part.text;
    if (text.includes(marker)) {
      input.system = system;
      return;
    }
    const legacyIndex = Math.max(...previousMarkers.map((previous) => text.indexOf(previous)));
    if (legacyIndex >= 0) {
      part.text = `${text.slice(0, legacyIndex).trimEnd()}\n\n${marker}\n${instructions}`;
      input.system = system;
      return;
    }
  }
  const last = system.at(-1);
  if (isRecord(last) && last.type === "text" && typeof last.text === "string") {
    last.text += `\n\n${marker}\n${instructions}`;
  } else {
    system.push({ type: "text", text: `${marker}\n${instructions}` });
  }
  input.system = system;
}

export async function readPlan(
  storage: PlanningStorage | undefined, sessionID: string, authority: PlanningAuthority = fallbackAuthority,
): Promise<PlanState | undefined> {
  if (!storage) return undefined;
  try {
    return await loadActivePlan(storage, sessionID, authority);
  } catch { return undefined; }
}

/** Evita cerrar un plan ocultando blockers o llamadas aún reservadas. */
export async function assertPlanningCompletionReady(
  storage: PlanningStorage,
  state: PlanState,
  authority: PlanningAuthority = fallbackAuthority,
): Promise<void> {
  if (state.version !== 5) return;
  const raw = await storage.get(planExecutionKey(state.planID, state.revision));
  // Compatibilidad: un V5 anterior puede no tener checkpoint de recuperación.
  if (raw === undefined) return;
  if (!validPlanExecutionCheckpoint(raw, {
    planID: state.planID,
    revision: state.revision,
    digest: state.digest,
    proofHash: planExecutionProofHash(state),
    phase: state.phase === "paused" || state.phase === "blocked" ? state.phase : "running",
  }, actionGraphForPlan(state), authority)) {
    throw new Error("El plan no puede completarse: el checkpoint no es verificable.");
  }
  if (raw.commonBlocker || Object.keys(raw.blockers).length > 0) {
    throw new Error("El plan no puede completarse mientras exista un blocker pendiente en el checkpoint.");
  }
  if (Object.keys(raw.reservations).length > 0
    || Object.values(raw.nodes).some((node) => node.state === "in-flight")) {
    throw new Error("El plan no puede completarse mientras exista una reserva in-flight pendiente.");
  }
  if (Object.values(raw.nodes).some((node) => node.state === "failed")) {
    throw new Error("El plan no puede completarse mientras exista un intento fallido pendiente.");
  }
}

async function ask(port: ApprovalPort, call: ToolCall, action: string, digest: string): Promise<void> {
  await port.assert({ sessionID: call.sessionID, agent: call.agent,
    source: { type: "tool", messageID: call.messageID, id: call.id },
    action, resources: [digest], save: [],
  });
}

async function applyRepairAuthorization(
  input: Record<string, unknown>,
  candidate: ActionIntentRepairV1,
  declaredActionIDs: string[],
  state: PlanStateV5,
  port: ApprovalPort,
  storage: PlanningStorage,
  authority: PlanningAuthority,
  projectRoot: string,
  directory: string,
): Promise<void> {
  if (!validActionIntentRepair(candidate, projectRoot)) {
    throw new PlanningAuthorizationError("ACTION_NOT_DECLARED");
  }
  const call = repairToolCall(input);
  if (!call || repairInputActionID(input, state.project, projectRoot, directory) !== candidate.repairedActionID) {
    throw new PlanningAuthorizationError("ACTION_NOT_DECLARED");
  }
  const reservation = [state.planID, state.revision, candidate.sourceActionID, candidate.repairedInputHash].join("\0");
  if (pendingRepairApprovals.has(reservation)) throw new PlanningAuthorizationError("ACTION_REPAIR_EXHAUSTED");
  pendingRepairApprovals.add(reservation);
  try {
    const guard = createExecutionGuard({
      plan: {
        planID: state.planID,
        revision: state.revision,
        digest: state.digest,
        phase: "running",
        actionIDs: declaredActionIDs,
      },
      storage,
    });
    const adapterRepair = { equivalent: true, ...candidate };
    const available = await guard.inspectAdapterRepair({
      actionID: candidate.sourceActionID,
      adapterRepair,
    });
    if (available.code === "ADAPTER_REPAIR_EXHAUSTED") {
      throw new PlanningAuthorizationError("ACTION_REPAIR_EXHAUSTED");
    }
    if (available.decision !== "retry") throw new PlanningAuthorizationError("ACTION_NOT_DECLARED");

    await port.assert({
      sessionID: state.sessionID,
      agent: call.agent,
      source: { type: "tool", messageID: call.messageID, id: call.id },
      action: REPAIR_ACTION,
      resources: repairApprovalResources(state, candidate),
      save: [],
    });

    const fresh = await readPlan(storage, state.sessionID, authority);
    const currentCall = repairToolCall(input);
    if (!fresh || fresh.version !== 5 || fresh.phase !== "running"
      || fresh.planID !== state.planID || fresh.revision !== state.revision || fresh.digest !== state.digest
      || !sameToolCall(call, currentCall)
      || repairInputActionID(input, state.project, projectRoot, directory) !== candidate.repairedActionID
      || !validActionIntentRepair(candidate, projectRoot)) {
      throw new PlanningAuthorizationError("PLAN_INVALID");
    }
    const applied = await guard.recordAttempt({
      actionID: candidate.sourceActionID,
      decisionCode: "ACTION_SERIALIZATION_MISMATCH",
      canonicalInputHash: candidate.repairedInputHash,
      resourceDigests: { before: [candidate.manifestHash], after: [candidate.manifestHash] },
      adapterRepair,
      result: { class: "not-run" },
    });
    if (applied.code === "ADAPTER_REPAIR_EXHAUSTED") {
      throw new PlanningAuthorizationError("ACTION_REPAIR_EXHAUSTED");
    }
    if (applied.code !== "ADAPTER_REPAIR_APPLIED") throw new PlanningAuthorizationError("ACTION_NOT_DECLARED");
  } finally {
    pendingRepairApprovals.delete(reservation);
  }
}

async function evaluateRepairApproval(
  input: Record<string, unknown>,
  resolved: { scope: PlanScope; directory: string } | undefined,
  storage: PlanningStorage | undefined,
  options: PluginAdapterOptions,
  authority: PlanningAuthority,
): Promise<void> {
  if (!resolved || !storage || !attributedToolSource(input.source)) {
    deny(input, "Reparación técnica sin sesión, storage o llamada de tool verificable.");
    return;
  }
  const state = await readPlan(storage, resolved.scope.sessionID, authority);
  const resources = Array.isArray(input.resources) ? input.resources : [];
  const candidate = repairFromApprovalResources(resources);
  const projectRoot = planningProjectRoot(resolved.scope.project, resolved.directory, options.env);
  let declaredActionIDs: string[] = [];
  if (state?.version === 5) {
    try {
      declaredActionIDs = plannedIntentGroups(state, resolved.directory, projectRoot)
        .flatMap((group) => group.intents.map((intent) => intent.actionID));
    } catch {
      deny(input, "No se pudieron recanonicalizar las acciones del plan para aprobar la reparación.");
      return;
    }
  }
  if (!state || state.version !== 5 || state.phase !== "running"
    || state.project !== resolved.scope.project || state.mode !== resolved.scope.mode
    || state.policyRevision !== resolved.scope.policyRevision
    || !candidate || !validActionIntentRepair(candidate, projectRoot)
    || !declaredActionIDs.includes(candidate.sourceActionID)
    || resources[0] !== state.planID || resources[1] !== state.revision || resources[2] !== state.digest) {
    deny(input, "Reparación técnica inválida, desactualizada o fuera del plan vigente.");
    return;
  }
  input.effect = "ask";
  input.message = `Autoriza una reparación técnica equivalente dentro de la misma revisión para ${candidate.manifest.length} archivo(s) exacto(s). No amplía paths, cwd ni efectos.`;
}

function repairApprovalResources(state: PlanStateV5, candidate: ActionIntentRepairV1): string[] {
  return [
    state.planID,
    state.revision,
    state.digest,
    candidate.sourceActionID,
    candidate.repairedActionID,
    candidate.repairedInputHash,
    candidate.manifestHash,
    candidate.relation,
    ...candidate.manifest,
  ];
}

function repairFromApprovalResources(resources: unknown[]): ActionIntentRepairV1 | undefined {
  if (resources.length < 9 || resources.some((item) => typeof item !== "string")) return undefined;
  const relation = resources[7];
  if (relation !== "equal" && relation !== "narrower") return undefined;
  return {
    schema: 1,
    kind: "git-stage-manifest",
    sourceActionID: resources[3] as string,
    repairedActionID: resources[4] as string,
    repairedInputHash: resources[5] as string,
    manifestHash: resources[6] as string,
    relation,
    manifest: resources.slice(8) as string[],
  };
}

function repairToolCall(input: Record<string, unknown>): ToolCall | undefined {
  const context = isRecord(input.context) ? input.context : {};
  const source = isRecord(input.source) ? input.source : {};
  const sessionID = text(input.sessionID || context.sessionID);
  const messageID = text(input.messageID || context.messageID || source.messageID);
  const id = text(input.id || input.callID || input.toolCallID || context.id || context.callID || source.id);
  const agent = text(input.agent || context.agent) || "malahor";
  return sessionID && messageID && id ? { sessionID, messageID, id, agent } : undefined;
}

function repairInputActionID(
  input: Record<string, unknown>,
  project: string,
  projectRoot: string,
  directory: string,
): string | undefined {
  try {
    const operations = toolActions(text(input.tool), input.input, directory);
    if (operations?.length !== 1 || operations[0]?.action !== "shell") return undefined;
    const args = isRecord(input.input) ? input.input : {};
    const operationCwd = typeof args.workdir === "string" ? path.resolve(directory, args.workdir)
      : typeof args.cwd === "string" ? path.resolve(directory, args.cwd)
        : directory;
    const intents = canonicalizePlannedAction(operations[0], {
      project,
      root: projectRoot,
      rootRef: "project",
      cwd: operationCwd,
    });
    return intents.length === 1 ? intents[0]?.actionID : undefined;
  } catch {
    return undefined;
  }
}

function sameToolCall(left: ToolCall, right: ToolCall | undefined): boolean {
  if (!right) return false;
  return left.sessionID === right.sessionID && left.agent === right.agent
    && left.messageID === right.messageID && left.id === right.id;
}

function attributedToolSource(value: unknown): boolean {
  return isRecord(value) && value.type === "tool" && Boolean(text(value.messageID)) && Boolean(text(value.id));
}


async function requireScope(call: ToolCall, options: PluginAdapterOptions) {
  const resolved = await resolvePlanningScope(call.sessionID, options);
  if (!resolved) throw new Error("Proyecto registrado/sesion no evaluable: planeacion bloqueada.");
  return resolved;
}

export async function resolvePlanningScope(value: unknown, options: PluginAdapterOptions): Promise<{ scope: PlanScope; directory: string } | undefined> {
  if (typeof value !== "string") return undefined;
  try {
    if (options.resolveSessionProject) {
      const project = await options.resolveSessionProject(value);
      if (!project) return undefined;
      const directory = path.resolve(project.root);
      const env = { ...options.env ?? process.env, MALAHOR_OPENCODE_DETECT: "0" };
      const config = loadConfig(env, directory);
      return { scope: {
        sessionID: value, project: project.canonicalKey, mode: config.mode,
        policyRevision: config.execution.revision,
      }, directory };
    }
    if (!options.resolveSessionDirectory) return undefined;
    const directory = await options.resolveSessionDirectory(value);
    if (!directory) return undefined;
    const env = { ...options.env ?? process.env, MALAHOR_OPENCODE_DETECT: "0" };
    const paths = resolvePaths(env, directory);
    const root = registeredProjectRoots(paths.projectsFile)
      .sort((a, b) => b.root.length - a.root.length)
      .find((entry) => inside(directory, entry.root));
    if (!root) return undefined;
    const config = loadConfig(env, directory);
    return { scope: {
      sessionID: value, project: root.canonicalKey, mode: config.mode,
      policyRevision: config.execution.revision,
    }, directory };
  } catch { return undefined; }
}

function toolActions(tool: string, value: unknown, directory: string): PlannedAction[] | undefined {
  const args = isRecord(value) ? value : {};
  if (tool === "shell" || tool === "bash") {
    if ([args.cwd, args.workdir].some((cwd) => cwd !== undefined && typeof cwd !== "string")) return undefined;
    if (typeof args.cwd === "string" && typeof args.workdir === "string"
      && path.resolve(directory, args.cwd) !== path.resolve(directory, args.workdir)) return undefined;
    return typeof args.command === "string" && args.command.trim()
      ? [{ action: "shell", resource: args.command }] : undefined;
  }
  if (tool === "subagent" || tool === "task") {
    return typeof args.agent === "string" ? [{ action: "subagent", resource: args.agent }] : undefined;
  }
  if (tool === "patch") {
    if (typeof args.patchText !== "string") return undefined;
    const operations = parsePatchOperations(args.patchText);
    return operations.length ? operations.map((operation) => normalizeAction("edit", operation.path, directory)) : undefined;
  }
  if (tool === "edit" || tool === "write") {
    const target = args.path ?? args.filePath;
    return typeof target === "string" ? [normalizeAction("edit", target, directory)] : undefined;
  }
  return undefined; // integraciones desconocidas no heredan autorizacion.
}

function normalizeAction(
  action: string,
  resource: string,
  directory: string,
  key?: string,
  dependsOn?: string[],
): PlannedAction {
  return {
    action,
    resource: action === "edit" ? path.resolve(directory, resource) : resource,
    ...(key === undefined ? {} : { key }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
  };
}

interface PlannedIntentGroup {
  action: PlannedAction;
  intents: ActionIntentV1[];
}

interface RepairAuthorization {
  effect: "repair";
  candidate: ActionIntentRepairV1;
  declaredActionIDs: string[];
}

type OperationAuthorization = AuthorizationDecision | RepairAuthorization;

const DUMMY_ACTION_ID = "0".repeat(64);

function authorizeResources(
  state: unknown,
  scope: PlanScope,
  action: string,
  resources: unknown[],
  directory: string,
  projectRoot: string,
  operationCwd: string | undefined,
  authority: PlanningAuthority,
): OperationAuthorization {
  if (resources.length === 0 || resources.some((item) => typeof item !== "string")) {
    return decisionForCanonicalizationFailure(state, scope, "ACTION_NOT_CANONICALIZABLE", authority);
  }
  return authorizeOperations(
    state,
    scope,
    (resources as string[]).map((resource) => normalizeAction(action, resource, directory)),
    directory,
    projectRoot,
    operationCwd ?? directory,
    authority,
  );
}

function authorizeOperations(
  state: unknown,
  scope: PlanScope,
  operations: PlannedAction[] | undefined,
  directory: string,
  projectRoot: string,
  operationCwd: string,
  authority: PlanningAuthority,
): OperationAuthorization {
  const preflight = decideAuthorization({
    state,
    scope,
    action: { actionID: DUMMY_ACTION_ID },
    declaredActionIDs: [DUMMY_ACTION_ID],
    host: { effect: "allow" },
    criticalControls: { authority: true, policy: true, toolHook: true, audit: true },
    now: Date.now(),
    authority,
  });
  if (preflight.effect !== "allow") return preflight;
  if (!validState(state, authority) || state.version !== 5) {
    return { effect: "deny", code: "PLAN_INVALID" };
  }
  if (!operations || operations.length === 0) {
    return decisionForCanonicalizationFailure(state, scope, "ACTION_NOT_CANONICALIZABLE", authority);
  }
  const kinds = new Set(operations.map((operation) => operation.action));
  if (kinds.size !== 1 || !["edit", "shell", "subagent"].includes(operations[0]!.action)) {
    return decisionForCanonicalizationFailure(state, scope, "ACTION_NOT_CANONICALIZABLE", authority);
  }

  let planned: PlannedIntentGroup[];
  try {
    planned = plannedIntentGroups(state, directory, projectRoot);
  } catch (error) {
    return decisionForIntentError(state, scope, error, authority, "ACTION_SERIALIZATION_MISMATCH");
  }
  const declaredActionIDs = planned.flatMap((group) => group.intents.map((intent) => intent.actionID));
  const kind = operations[0]!.action;

  try {
    if (kind === "shell") {
      const actual = operations.flatMap((operation) => canonicalizePlannedAction(operation, {
        project: scope.project,
        root: projectRoot,
        rootRef: "project",
        cwd: operationCwd,
      }));
      const match = planned.find((group) => group.action.action === "shell"
        && sameActionIntentSequence(group.intents, actual));
      if (!match) {
        const repairs = operations.length === 1 ? planned
          .filter((group) => group.action.action === "shell" && group.intents.length === 1)
          .map((group) => deriveActionIntentRepair(group.action, operations[0]!, {
            project: scope.project,
            root: projectRoot,
            rootRef: "project",
            plannedCwd: directory,
            cwd: operationCwd,
          }))
          .filter((candidate): candidate is ActionIntentRepairV1 => candidate !== undefined)
          .filter((candidate) => candidate.repairedActionID === actual[0]?.actionID
            && planned.some((group) => group.intents[0]?.actionID === candidate.sourceActionID))
          : [];
        if (repairs.length === 1) return {
          effect: "repair",
          candidate: repairs[0]!,
          declaredActionIDs,
        };
        return actionNotDeclaredDecision(state, scope, actual[0], declaredActionIDs, authority);
      }
      return authorizeIntentSequence(state, scope, actual, declaredActionIDs, authority);
    }

    if (kind === "subagent") {
      const actual = operations.flatMap((operation) => canonicalizePlannedAction(operation, {
        project: scope.project,
        root: projectRoot,
        rootRef: "project",
        cwd: directory,
      }));
      for (const intent of actual) {
        const match = planned.some((group) => group.action.action === "subagent"
          && group.intents.length === 1 && group.intents[0]?.actionID === intent.actionID);
        if (!match) return actionNotDeclaredDecision(state, scope, intent, declaredActionIDs, authority);
      }
      return authorizeIntentSequence(state, scope, actual, declaredActionIDs, authority);
    }

    const actual: ActionIntentV1[] = [];
    for (const operation of operations) {
      const normalized = canonicalizeActionIntent({
        kind: "edit",
        project: scope.project,
        root: projectRoot,
        rootRef: "project",
        path: operation.resource,
        existence: "may-create",
        constraints: { remote: false, infrastructure: false },
      })[0]!;
      const canonicalPath = normalized.resources[0]?.canonicalPath;
      const match = planned.find((group) => group.action.action === "edit"
        && group.intents.length === 1
        && group.intents[0]?.resources[0]?.canonicalPath === canonicalPath);
      if (!match) return actionNotDeclaredDecision(state, scope, normalized, declaredActionIDs, authority);
      actual.push(match.intents[0]!);
    }
    return authorizeIntentSequence(state, scope, actual, declaredActionIDs, authority);
  } catch (error) {
    return decisionForIntentError(state, scope, error, authority, "ACTION_NOT_CANONICALIZABLE");
  }
}

function plannedIntentGroups(
  state: PlanStateV5,
  directory: string,
  projectRoot: string,
): PlannedIntentGroup[] {
  const actions = state.plan.actions;
  if (state.actionIntentSource === "compatibility") {
    return actions.map((action) => ({
      action,
      intents: canonicalizePlannedAction(action, {
        project: state.project,
        root: projectRoot,
        rootRef: "project",
        cwd: directory,
      }),
    }));
  }

  const groups: PlannedIntentGroup[] = [];
  let cursor = 0;
  for (const action of actions) {
    if (action.action === "edit") {
      const stored = state.actionIntents[cursor];
      if (!stored || stored.kind !== "edit" || stored.resources.length !== 1) {
        throw new Error("Intent de edición desalineado.");
      }
      const normalized = canonicalizeActionIntent({
        kind: "edit",
        project: state.project,
        root: projectRoot,
        rootRef: "project",
        path: action.resource,
        existence: "may-create",
        constraints: { remote: false, infrastructure: false },
      })[0]!;
      if (stored.resources[0]?.canonicalPath !== normalized.resources[0]?.canonicalPath) {
        throw new Error("Path firmado y acción visible no coinciden.");
      }
      groups.push({ action, intents: [stored] });
      cursor += 1;
      continue;
    }
    const regenerated = canonicalizePlannedAction(action, {
      project: state.project,
      root: projectRoot,
      rootRef: "project",
      cwd: directory,
    });
    const stored = state.actionIntents.slice(cursor, cursor + regenerated.length);
    if (!sameActionIntentSequence(stored, regenerated)) {
      throw new Error("Intents firmados y acción visible no coinciden.");
    }
    groups.push({ action, intents: stored });
    cursor += regenerated.length;
  }
  if (cursor !== state.actionIntents.length) throw new Error("Sobran intents sin acción visible.");
  return groups;
}

function matchedOperationActionIDs(
  state: PlanStateV5,
  operations: PlannedAction[] | undefined,
  directory: string,
  projectRoot: string,
  operationCwd: string,
): string[] | undefined {
  if (!operations?.length) return undefined;
  const kinds = new Set(operations.map((operation) => operation.action));
  if (kinds.size !== 1) return undefined;
  const planned = plannedIntentGroups(state, directory, projectRoot);
  const kind = operations[0]!.action;
  if (kind === "shell") {
    const actual = operations.flatMap((operation) => canonicalizePlannedAction(operation, {
      project: state.project,
      root: projectRoot,
      rootRef: "project",
      cwd: operationCwd,
    }));
    const match = planned.find((group) => group.action.action === "shell"
      && sameActionIntentSequence(group.intents, actual));
    return match?.intents.map((intent) => intent.actionID);
  }
  if (kind === "subagent") {
    const actionIDs: string[] = [];
    for (const operation of operations) {
      const actual = canonicalizePlannedAction(operation, {
        project: state.project,
        root: projectRoot,
        rootRef: "project",
        cwd: directory,
      });
      const match = planned.find((group) => group.action.action === "subagent"
        && sameActionIntentSequence(group.intents, actual));
      if (!match) return undefined;
      actionIDs.push(...match.intents.map((intent) => intent.actionID));
    }
    return actionIDs;
  }
  if (kind !== "edit") return undefined;
  const actionIDs: string[] = [];
  for (const operation of operations) {
    const normalized = canonicalizeActionIntent({
      kind: "edit",
      project: state.project,
      root: projectRoot,
      rootRef: "project",
      path: operation.resource,
      existence: "may-create",
      constraints: { remote: false, infrastructure: false },
    })[0]!;
    const canonicalPath = normalized.resources[0]?.canonicalPath;
    const match = planned.find((group) => group.action.action === "edit"
      && group.intents.length === 1
      && group.intents[0]?.resources[0]?.canonicalPath === canonicalPath);
    if (!match) return undefined;
    actionIDs.push(match.intents[0]!.actionID);
  }
  return [...new Set(actionIDs)];
}

async function authorizeCheckpointActions(
  state: PlanStateV5,
  actionIDs: string[] | undefined,
  storage: PlanningStorage,
  authority: PlanningAuthority,
  directory: string,
  projectRoot: string,
  call?: ToolCall,
): Promise<AuthorizationDecision> {
  if (!actionIDs?.length) return { effect: "deny", code: "ACTION_NOT_DECLARED" };
  try {
    const recovery = recoveryForState(state, storage, authority, directory, projectRoot);
    const checkpoint = await recovery.snapshot();
    const requested = new Set(actionIDs);
    for (const actionID of actionIDs) {
      const decision = await recovery.evaluateAction(actionID);
      if (decision.effect === "deny") {
        // El host puede comprobar el permiso después de tool.execute.before:
        // la reserva de esta misma llamada no es una llamada concurrente.
        if (decision.code === "ACTION_IN_FLIGHT" && call
          && reservationOwnedByCall(checkpoint, actionID, call)) continue;
        const node = checkpoint.nodes[actionID];
        const internalSequence = decision.code === "DEPENDENCY_BLOCKED" && node
          && node.dependsOn.every((dependency) => requested.has(dependency)
            || checkpoint.nodes[dependency]?.state === "succeeded");
        if (!internalSequence) return recoveryDenial(decision.code);
      }
    }
    return { effect: "allow", code: "AUTHORIZED", actionID: actionIDs.at(-1)! };
  } catch {
    return { effect: "deny", code: "PLAN_CHECKPOINT_INVALID" };
  }
}

function reservationOwnedByCall(
  checkpoint: PlanExecutionCheckpointV1,
  actionID: string,
  call: ToolCall,
): boolean {
  return Object.values(checkpoint.reservations).some((reservation) =>
    reservation.actionID === actionID
    && reservation.sessionID === call.sessionID
    && reservation.messageID === call.messageID
    && reservation.callID === call.id);
}

async function reservePlanningToolCall(
  input: Record<string, unknown>,
  state: PlanStateV5,
  actionIDs: string[] | undefined,
  storage: PlanningStorage,
  authority: PlanningAuthority,
  directory: string,
  projectRoot: string,
): Promise<void> {
  if (!actionIDs?.length) throw new PlanningAuthorizationError("ACTION_NOT_DECLARED");
  const call = toolCallIdentity(input);
  if (!call) throw new PlanningAuthorizationError("CRITICAL_CONTROL_UNAVAILABLE", "La tool no incluye correlación before/after.");
  const recovery = recoveryForState(state, storage, authority, directory, projectRoot);
  for (const actionID of actionIDs) {
    const result = await recovery.reserveToolCall(recoveryCorrelation(state, actionID, call, input));
    if (result.decision === "block") {
      const denial = recoveryDenial(result.code);
      throw new PlanningAuthorizationError(denial.effect === "deny" ? denial.code : "PLAN_CHECKPOINT_INVALID");
    }
  }
}

function recoveryForState(
  state: PlanStateV5,
  storage: PlanningStorage,
  authority: PlanningAuthority,
  directory?: string,
  projectRoot?: string,
): PlanRecovery {
  const graph = state.actionIntentSource === "compatibility" && directory && projectRoot
    ? runtimeCompatibilityGraph(state, directory, projectRoot)
    : actionGraphForPlan(state);
  return createPlanRecovery({
    plan: {
      planID: state.planID,
      revision: state.revision,
      digest: state.digest,
      proofHash: planExecutionProofHash(state),
      phase: state.phase === "paused" || state.phase === "blocked" ? state.phase : "running",
    },
    graph,
    authority,
    storage,
  });
}

function runtimeCompatibilityGraph(
  state: PlanStateV5,
  directory: string,
  projectRoot: string,
): PlanActionGraphNodeV1[] {
  const groups = plannedIntentGroups(state, directory, projectRoot);
  if (groups.every((group) => group.action.key)) return actionGraphFromGroups(groups);
  return groups.flatMap((group, groupIndex) => group.intents.map((intent, intentIndex) => ({
    key: `legacy-${groupIndex + 1}-${intentIndex + 1}-${intent.actionID.slice(0, 8)}`,
    actionID: intent.actionID,
    dependsOn: intentIndex === 0 ? [] : [group.intents[intentIndex - 1]!.actionID],
  })));
}

function recoveryCorrelation(
  state: PlanStateV5,
  actionID: string,
  call: ToolCall,
  input: Record<string, unknown>,
): RecoveryCorrelation {
  return {
    sessionID: state.sessionID,
    messageID: call.messageID,
    callID: call.id,
    planID: state.planID,
    revision: state.revision,
    actionID,
    policyHash: `sha256:${createHash("sha256").update(state.policyRevision).digest("hex")}`,
    resourceHash: planningResourceHash(input),
  };
}

function recoveryDenial(code: string): AuthorizationDecision {
  const supported = new Set<AuthorizationDenialCode>([
    "ACTION_NOT_DECLARED",
    "DEPENDENCY_BLOCKED",
    "ACTION_IN_FLIGHT",
    "ACTION_ALREADY_COMPLETED",
    "ACTION_REMOVED",
    "PLAN_CHECKPOINT_INVALID",
    "PLAN_CORRELATION_MISMATCH",
    "HOST_ASK",
    "HOST_DENY",
    "CRITICAL_CONTROL_UNAVAILABLE",
  ]);
  return { effect: "deny", code: supported.has(code as AuthorizationDenialCode)
    ? code as AuthorizationDenialCode
    : "PLAN_CHECKPOINT_INVALID" };
}

function permissionOperationCwd(input: Record<string, unknown>, directory: string): string {
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const raw = metadata.workdir ?? metadata.cwd;
  return typeof raw === "string" ? path.resolve(directory, raw) : directory;
}

function permissionToolCall(input: Record<string, unknown>): ToolCall | undefined {
  const source = isRecord(input.source) ? input.source : {};
  const sessionID = text(input.sessionID);
  const messageID = text(source.messageID);
  const id = text(source.id || source.callID || source.toolCallID);
  const agent = text(input.agent) || "malahor";
  return source.type === "tool" && sessionID && messageID && id ? { sessionID, messageID, id, agent } : undefined;
}

function toolCallIdentity(input: Record<string, unknown>): ToolCall | undefined {
  return repairToolCall(input);
}

function optionalDiagnosticPermission(input: Record<string, unknown>): boolean {
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  return metadata.optional === true && (metadata.source === "diagnostic" || metadata.kind === "diagnostic");
}

function planningResourceHash(input: Record<string, unknown>): string {
  const source = isRecord(input.source) ? input.source : {};
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const payload = input.tool
    ? { tool: text(input.tool), input: input.input }
    : {
        action: text(input.action),
        resources: Array.isArray(input.resources) ? input.resources : [],
        command: text(metadata.command || metadata.cmd),
        cwd: text(metadata.workdir || metadata.cwd),
        source: { type: text(source.type) },
      };
  return `sha256:${createHash("sha256").update(canonicalPlanningValue(payload)).digest("hex")}`;
}

function canonicalPlanningValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPlanningValue).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalPlanningValue(item)}`).join(",")}}`;
  }
  if (typeof value === "function" || typeof value === "symbol") return JSON.stringify(String(value));
  return JSON.stringify(value) ?? "null";
}

function toolCompletionStatus(input: Record<string, unknown>): "success" | "failure" {
  const output = isRecord(input.output) ? input.output : {};
  const result = isRecord(input.result) ? input.result : {};
  if (input.error !== undefined && input.error !== null) return "failure";
  if (output.error !== undefined || result.error !== undefined || output.success === false || result.success === false) return "failure";
  if (["error", "failed", "failure", "cancelled"].includes(text(input.status || output.status || result.status).toLowerCase())) {
    return "failure";
  }
  return "success";
}

function authorizeIntentSequence(
  state: PlanStateV5,
  scope: PlanScope,
  intents: ActionIntentV1[],
  declaredActionIDs: string[],
  authority: PlanningAuthority,
): AuthorizationDecision {
  let last: AuthorizationDecision | undefined;
  for (const intent of intents) {
    last = decideAuthorization({
      state,
      scope,
      action: intent,
      declaredActionIDs,
      canonicalization: { status: "ok" },
      serialization: { matches: true },
      resourceScope: { inside: true },
      protectedApproval: { required: false, approved: false },
      host: { effect: "allow" },
      criticalControls: { authority: true, policy: true, toolHook: true, audit: true },
      now: Date.now(),
      authority,
    });
    if (last.effect !== "allow") return last;
  }
  return last ?? { effect: "deny", code: "ACTION_NOT_CANONICALIZABLE" };
}

function actionNotDeclaredDecision(
  state: PlanStateV5,
  scope: PlanScope,
  intent: ActionIntentV1 | undefined,
  declaredActionIDs: string[],
  authority: PlanningAuthority,
): AuthorizationDecision {
  const undeclared = ["f".repeat(64), "e".repeat(64), "d".repeat(64)]
    .find((candidate) => !declaredActionIDs.includes(candidate))!;
  return decideAuthorization({
    state,
    scope,
    action: { ...(intent ?? {}), actionID: undeclared },
    declaredActionIDs,
    host: { effect: "allow" },
    criticalControls: { authority: true, policy: true, toolHook: true, audit: true },
    now: Date.now(),
    authority,
  });
}

function decisionForIntentError(
  state: unknown,
  scope: PlanScope,
  error: unknown,
  authority: PlanningAuthority,
  fallback: AuthorizationDenialCode,
): AuthorizationDecision {
  const code = error instanceof ActionIntentError ? error.code : fallback;
  return decisionForCanonicalizationFailure(state, scope, code, authority);
}

function decisionForCanonicalizationFailure(
  state: unknown,
  scope: PlanScope,
  code: AuthorizationDenialCode,
  authority: PlanningAuthority,
): AuthorizationDecision {
  return decideAuthorization({
    state,
    scope,
    action: { actionID: DUMMY_ACTION_ID },
    declaredActionIDs: [DUMMY_ACTION_ID],
    canonicalization: { status: "error", code },
    host: { effect: "allow" },
    criticalControls: { authority: true, policy: true, toolHook: true, audit: true },
    now: Date.now(),
    authority,
  });
}

function actionGraphFromGroups(groups: PlannedIntentGroup[]): PlanActionGraphNodeV1[] {
  const terminalByKey = new Map(groups.map((group) => [
    group.action.key!,
    group.intents.at(-1)?.actionID,
  ]));
  const graph: PlanActionGraphNodeV1[] = [];
  for (const group of groups) {
    if (group.intents.length === 0) throw new Error(`La acción ${group.action.key} no produjo intents firmables.`);
    for (const [index, intent] of group.intents.entries()) {
      const dependsOn = index > 0
        ? [group.intents[index - 1]!.actionID]
        : (group.action.dependsOn ?? []).map((key) => {
            const terminal = terminalByKey.get(key);
            if (!terminal) throw new Error(`Dependencia lógica no canonicalizable: ${key}.`);
            return terminal;
          });
      graph.push({
        key: group.intents.length === 1
          ? group.action.key!
          : `${group.action.key!.slice(0, 100)}.${index + 1}-${intent.actionID.slice(0, 8)}`,
        actionID: intent.actionID,
        dependsOn,
      });
    }
  }
  return graph;
}

function readOnlyShellResources(value: unknown, projectRoot: string, workingDirectory: string): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) return false;
  return value.every((command) => classifyReadOnlyShellCommand(command as string, projectRoot, {
    workingDirectory,
  }).readOnly);
}

function readOnlyShellTool(
  tool: string,
  value: unknown,
  projectRoot: string,
  sessionDirectory: string,
): boolean {
  if (tool !== "shell" && tool !== "bash") return false;
  const args = isRecord(value) ? value : {};
  if ([args.cwd, args.workdir].some((cwd) => cwd !== undefined && typeof cwd !== "string")) return false;
  const cwd = typeof args.cwd === "string" ? path.resolve(sessionDirectory, args.cwd) : undefined;
  const workdir = typeof args.workdir === "string" ? path.resolve(sessionDirectory, args.workdir) : undefined;
  if (cwd && workdir && cwd !== workdir) return false;
  const workingDirectory = workdir ?? cwd ?? sessionDirectory;
  return typeof args.command === "string"
    && classifyReadOnlyShellCommand(args.command, projectRoot, { workingDirectory }).readOnly;
}

function permissionShellCandidate(
  input: Record<string, unknown>,
  projectRoot: string,
): { command: string; cwd: string; messageID: string; toolCallID: string; valid: boolean } {
  const resources = Array.isArray(input.resources) ? input.resources : [];
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const metadataCommand = text(metadata.command || metadata.cmd);
  const rawCwd = metadata.workdir ?? metadata.cwd;
  const source = isRecord(input.source) ? input.source : {};
  const command = resources.length === 1 && typeof resources[0] === "string" ? resources[0] : "";
  const messageID = text(source.messageID);
  const toolCallID = text(source.id || source.callID || source.toolCallID);
  const valid = Boolean(command)
    && (!metadataCommand || metadataCommand === command)
    && (rawCwd === undefined || typeof rawCwd === "string")
    && source.type === "tool"
    && Boolean(messageID && toolCallID);
  return {
    command,
    cwd: typeof rawCwd === "string" ? path.resolve(projectRoot, rawCwd) : projectRoot,
    messageID,
    toolCallID,
    valid,
  };
}

function toolShellCandidate(
  input: Record<string, unknown>,
  sessionDirectory: string,
  projectRoot: string,
): { command: string; cwd: string; messageID: string; toolCallID: string; valid: boolean } {
  const args = isRecord(input.input) ? input.input : {};
  const command = typeof args.command === "string" ? args.command : "";
  const cwdValuesValid = [args.cwd, args.workdir]
    .every((cwd) => cwd === undefined || typeof cwd === "string");
  const cwd = typeof args.cwd === "string" ? path.resolve(sessionDirectory, args.cwd) : undefined;
  const workdir = typeof args.workdir === "string" ? path.resolve(sessionDirectory, args.workdir) : undefined;
  const messageID = text(input.messageID);
  const toolCallID = text(input.id || input.callID || input.toolCallID);
  return {
    command,
    cwd: workdir ?? cwd ?? projectRoot,
    messageID,
    toolCallID,
    valid: Boolean(command.trim()) && cwdValuesValid && (!cwd || !workdir || cwd === workdir)
      && Boolean(messageID && toolCallID),
  };
}

function commitScope(scope: PlanScope, root: string): CommitWorkflowScope {
  return {
    sessionID: scope.sessionID,
    project: scope.project,
    policyRevision: scope.policyRevision,
    mode: scope.mode,
    root,
  };
}

function pointScope(scope: PlanScope, root: string): PointActionScope {
  return {
    sessionID: scope.sessionID,
    project: scope.project,
    policyRevision: scope.policyRevision,
    mode: scope.mode,
    root,
  };
}

function pointToolCall(input: Record<string, unknown>): PointActionCall | undefined {
  const sessionID = text(input.sessionID);
  const agent = text(input.agent);
  const messageID = text(input.messageID);
  const id = text(input.id || input.callID || input.toolCallID);
  return sessionID && agent && messageID && id ? { sessionID, agent, messageID, id } : undefined;
}

function noActivePlan(value: unknown, authority: PlanningAuthority): boolean {
  if (value === undefined || value === null) return true;
  return validState(value, authority) && ["completed", "revoked", "superseded"].includes(value.phase);
}

function directDiagnosticPermission(resources: unknown): boolean {
  return Array.isArray(resources) && resources.length === 1 && resources[0] === "malahor-diagnostico";
}

function directDiagnosticTool(tool: string, value: unknown, agent: unknown): boolean {
  if (tool !== "subagent" && tool !== "task") return false;
  const args = isRecord(value) ? value : {};
  return agent === "malahor" && args.agent === "malahor-diagnostico";
}

function permissionAction(action: string): string {
  if (["bash", "command"].includes(action)) return "shell";
  if (["write", "patch", "create"].includes(action)) return "edit";
  if (action === "task") return "subagent";
  return action;
}

function routineTool(tool: string): boolean {
  const normalized = tool.trim().toLowerCase();
  if (/^(?:mcp[_:.-])?mnemo(?:[_:.-])/.test(normalized)) return true;
  if (/^(?:mcp[_:.-])?horiel[_:.-](?:memory_(?:get|search|context|brief|tree|list_projects|inspect_project|move_preview|promote_preview|delete_project_preview|restore_preview))$/.test(normalized)) return true;
  if (/^(?:mcp[_:.-])?docs(?:[_:.-])(?:resolve|list|read|search|write|append|move|open)$/.test(normalized)) return true;
  return /^(?:mcp[_:.-])?codegraph[_:.-](?!.*(?:index|write|delete))/.test(normalized);
}

function planningProjectRoot(project: string, directory: string, env: NodeJS.ProcessEnv | undefined): string {
  const paths = resolvePaths({ ...env ?? process.env, MALAHOR_OPENCODE_DETECT: "0" }, directory);
  return registeredProjectRoots(paths.projectsFile).find((entry) => entry.canonicalKey === project && inside(directory, entry.root))?.root
    ?? registeredProjectRoots(paths.projectsFile).find((entry) => entry.canonicalKey === project)?.root
    ?? directory;
}

function verifySddSpec(
  specRef: string,
  specHash: string,
  project: string,
  directory: string,
  env: NodeJS.ProcessEnv | undefined,
): void {
  const config = loadConfig({ ...env ?? process.env, MALAHOR_OPENCODE_DETECT: "0" }, directory);
  const docs = resolveDocsProject(config.paths, config.projects.aliases, project);
  const segments = specRef.trim().split("/");
  if (!docs.initialized || !specRef.startsWith("SDD/") || !specRef.endsWith(".md")
    || specRef.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("La referencia SDD no pertenece a la documentación canónica inicializada.");
  }
  const docsRoot = fs.realpathSync(docs.projectRoot);
  const target = path.resolve(docsRoot, specRef);
  if (!inside(target, docsRoot)) throw new Error("La referencia SDD queda fuera de la documentación canónica.");
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024
    || !inside(fs.realpathSync(target), docsRoot)) {
    throw new Error("La especificación SDD debe ser un Markdown regular y acotado dentro de la documentación canónica.");
  }
  const actualHash = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  if (actualHash !== specHash) throw new Error("La versión SHA-256 de la especificación SDD ya no coincide.");
}

function inside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function denyDecision(input: Record<string, unknown>, decision: AuthorizationDecision): void {
  if (decision.effect === "allow") return;
  if (decision.effect === "defer") {
    deny(input, "DEFER_TO_TOOL_HOOK: la acción requiere la segunda frontera autoritativa.");
    return;
  }
  input.effect = "deny";
  input.message = `[malahor.plan:${decision.code}] ${authorizationMessage(decision.code, decision.safeDetail)}`;
}

function deny(input: Record<string, unknown>, message: string): void {
  input.effect = "deny";
  input.message = `[malahor.plan] ${message}`;
}
