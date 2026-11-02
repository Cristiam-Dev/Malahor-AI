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
  canonicalizePlannedActions,
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
  controlPlan, DEFAULT_PLANNING_AUTHORITY, planAllows, presentPlan, renderPlan, requestPlanExecution, validState,
  PLAN_CONTRACT_VERSION,
  type PlanControl, type PlanInput, type PlannedAction, type PlanScope, type PlanState, type PlanStateV5, type PlanningAdapter,
} from "../cli/core/planning";
import type { PlanningAuthority } from "../cli/core/planning-authority";
import { detectSecretKinds, type PluginAdapterOptions } from "../cli/core/hooks/plugin-adapter";
import { isProtectedDocumentationPath, parsePatchOperations } from "../cli/core/documentation-boundary";
import { classifyInfrastructureCommand, classifyInfrastructurePath } from "../cli/core/infrastructure-boundary";
import { classifyGitCommand, loadGitAliases } from "../cli/core/git-command-policy";
import { classifyReadOnlyShellCommand } from "../cli/core/read-only-shell-policy";
import {
  loadActivePlan,
  loadActivePlanRaw,
  loadPlanRecord,
  persistPlanState,
  type PlanningRetentionStorage,
} from "./plan-retention";
import { createExecutionGuard } from "./execution-guard";

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
]);
const PROTECTED = new Set(["edit", "shell", "subagent"]);
const CODE_READ_TOOLS = new Set(["read", "glob", "grep"]);

/** Solo las acciones declaradas se median aquí; las demás políticas del host siguen vigentes. */
export async function evaluatePlanningPermission(
  input: Record<string, unknown>, options: PluginAdapterOptions, storage?: PlanningStorage,
  authority: PlanningAuthority = fallbackAuthority,
): Promise<void> {
  const action = text(input.action);
  const normalized = permissionAction(action);
  if (input.effect === "deny") return;
  const resolved = await resolvePlanningScope(input.sessionID, options);
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
    if (!state || state.version !== 5 || digest !== state.digest || state.project !== resolved?.scope.project
      || state.mode !== resolved.scope.mode || state.policyRevision !== resolved.scope.policyRevision
      || (action === REVIEW_ACTION && (state.mode !== "assistant" || state.phase !== "presented"))
      || (action === RUN_ACTION && (state.mode === "advisor" || state.plan.actions.length === 0
        || (state.mode === "assistant" ? state.phase !== "reviewed" : state.phase !== "presented")))
      || (action === RESUME_ACTION && !["paused", "blocked"].includes(state.phase))
      || (action === COMPLETE_ACTION && !["running", "paused"].includes(state.phase))) {
      deny(input, "Plan no vigente o confirmacion fuera de orden.");
      return;
    }
    input.effect = "ask"; // Nunca heredar una aprobacion persistente 'always'.
    input.message = action === REVIEW_ACTION
      ? `Revisa el plan; esta primera confirmacion NO autoriza ejecutar:\n${renderPlan(state)}`
      : action === RESUME_ACTION ? `Reanuda SOLO el plan y revision mostrados:\n${renderPlan(state)}`
        : action === COMPLETE_ACTION ? `Confirma el cierre del plan; puede desbloquear dependencias, pero no inicia otros planes:\n${renderPlan(state)}`
        : state.mode === "executor"
        ? `Aprobacion previa del plan para ejecutar SOLO sus acciones:\n${renderPlan(state)}`
        : `Segunda confirmacion: ejecuta SOLO las acciones del plan revisado:\n${renderPlan(state)}`;
    return;
  }
  if (action === REPAIR_ACTION) {
    await evaluateRepairApproval(input, resolved, storage, options, authority);
    return;
  }

  if (CODE_READ_TOOLS.has(action) && resolved?.scope.mode === "advisor") {
    deny(input, "Asesor: no consulta archivos de codigo ni verifica la implementacion.");
    return;
  }
  if (!PROTECTED.has(normalized)) {
    if (action && !READ_ONLY_TOOLS.has(action) && !routineTool(action) && action !== "*"
      && action !== "external_directory") deny(input, `Tool no clasificada para planeacion: ${action}`);
    return;
  }
  const projectRoot = resolved
    ? planningProjectRoot(resolved.scope.project, resolved.directory, options.env)
    : undefined;
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
  }
}

/** Segunda frontera: rutas directas y argumentos de tool, no solo permission.evaluate. */
export async function evaluatePlanningTool(
  input: Record<string, unknown>, options: PluginAdapterOptions, storage?: PlanningStorage,
  authority: PlanningAuthority = fallbackAuthority,
  approvals?: ApprovalPort,
): Promise<void> {
  const tool = text(input.tool);
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
  if (readOnlyShellTool(tool, input.input, projectRoot, resolved.directory)) return;
  if (!storage) throw new Error("Malahor: sesion/proyecto de planeacion no mediable.");
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
}

export async function registerPlanningTools(
  tools: PlanningTools, approvals: ApprovalPort, storage: PlanningStorage, options: PluginAdapterOptions,
  authority: PlanningAuthority = fallbackAuthority,
): Promise<{ dispose?: () => Promise<void> | void } | void> {
  return tools.transform((editor) => {
    editor.namespace({ name: "malahor", description: "Plan de trabajo portable de Malahor" });
    editor.add({
      name: "plan",
      description: "Registra un plan proporcional (nivel 0, 1 o 2) y devuelve su Markdown para presentarlo en foreground exactamente una vez como mensaje normal. Nivel 0 conserva plan y go, pero usa una vista minima. En asistente solicita la primera revision; en ejecutor espera una solicitud posterior antes de pedir aprobacion.",
      input: {
        type: "object", properties: {
          level: { type: "integer", enum: [0, 1, 2] },
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
            type: "object", properties: { action: { type: "string" }, resource: { type: "string" } },
            required: ["action", "resource"], additionalProperties: false,
          } },
          dependencies: { type: "array", items: {
            type: "object", properties: { planID: { type: "string" }, revision: { type: "string" } },
            required: ["planID", "revision"], additionalProperties: false,
          } },
        }, required: ["level", "summary", "steps", "presentation", "actions"], additionalProperties: false,
      },
      options: { namespace: "malahor", codemode: false },
      execute: async (value: unknown, call: ToolCall) => {
        const resolved = await requireScope(call, options);
        if (call.agent !== "malahor") throw new Error("Solo el primario puede presentar el plan.");
        const raw = value as PlanInput;
        if (raw.level !== 0 && raw.level !== 1 && raw.level !== 2) {
          throw new Error("malahor_plan requiere level 0, 1 o 2.");
        }
         if (detectSecretKinds(raw).length > 0) throw new Error("Posible secreto en el plan: no se almacena ni se muestra.");
         const actions = raw.actions?.map((item) => normalizeAction(item.action, item.resource, resolved.directory));
         const projectRoot = planningProjectRoot(resolved.scope.project, resolved.directory, options.env);
         if (raw.level === 0) validateLevelZeroActions(actions ?? [], projectRoot);
        const newRepoDoc = actions?.find((item) => item.action === "edit"
          && isProtectedDocumentationPath(projectRoot, item.resource) && !fs.existsSync(item.resource));
         if (newRepoDoc) throw new Error(`La documentacion operativa nueva debe ir al vault externo: ${newRepoDoc.resource}`);
        const normalizedActions = sortedPlannedActions(actions ?? []);
        const actionIntents = canonicalizePlannedActions(normalizedActions, {
          project: resolved.scope.project,
          root: projectRoot,
          rootRef: "project",
          cwd: resolved.directory,
        });
         const state = await presentPlan(
          resolved.scope, {
            ...raw,
            actions: normalizedActions,
            contractVersion: PLAN_CONTRACT_VERSION,
            canonicalizerVersion: ACTION_INTENT_CANONICALIZER,
            actionIntents,
          }, call.messageID,
          planningAdapter(storage, approvals, call, authority), authority,
         );
        return { content: foregroundPlanResult(state), metadata: {
          kind: "malahor.plan.presentation", version: 1,
          planID: state.planID, revision: state.revision, digest: state.digest, phase: state.phase,
        } };
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
        const digest = await resolveRunDigest(value, storage, resolved.scope, authority);
        const state = await requestPlanExecution(
          resolved.scope, digest, call.messageID,
          planningAdapter(storage, approvals, call, authority), authority,
        );
        return { content: renderPlan(state), metadata: {
          kind: "malahor.plan.state", version: 1,
          planID: state.planID, revision: state.revision, phase: state.phase,
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
        const state = await controlPlan(resolved.scope, action,
          planningAdapter(storage, approvals, call, authority), authority);
        return { content: renderPlan(state) };
      },
    });
  });
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
        `Modo ${mode}: presenta plan visible mediante malahor_plan antes de ejecutar.`,
        mode === "assistant" ? "Guia por pasos; la tool solicita revision del plan y despues malahor_run solicita la segunda confirmacion para ejecutar."
          : "Presenta el plan y solicita su aprobacion previa mediante malahor_run ANTES de ejecutar.",
        "Declara level 0, 1 o 2 en malahor_plan. Nivel 0 usa un plan minimo visible y conserva la aprobacion posterior go antes de cualquier efecto.",
        "Nivel 0 no usa Discovery ni SDD, no delega en subagentes y no crea documentacion ceremonial; ejecuta en una sola pasada y aplica validacion enfocada. Commit es la excepcion: conserva todos sus gates y hooks obligatorios.",
        "Usa nivel 0 solo con riesgo bajo, como maximo un archivo existente y sin categorias criticas, dependencias, infraestructura, instalacion, publicacion, despliegue ni destruccion; si el alcance crece, presenta nivel 1 o 2.",
        "Commit nivel 0: tras go revisa status/diff y ejecuta diagnostico, tests, build, stage exacto, precommit, hooks y revalidacion; no pide otra confirmacion salvo fallo o cambio material.",
        "Usa divulgacion progresiva: el resumen humano contiene objetivo, resultado, hasta cinco pasos, impacto, riesgo y una seccion 'Que debes hacer ahora' narrada en lenguaje tecnico comprensible.",
        "La vista normal no incrusta IDs, comandos ni el anexo tecnico; tampoco muestra rutas exactas.",
        "Ante un riesgo alto o una categoria critica, los riesgos, consecuencias y controles reforzados permanecen visibles en lenguaje humano. Los comandos, rutas, identidad y digest se muestran unicamente mediante /malahor-plan detalles.",
        "Despues de malahor_plan, copia el Markdown delimitado como una presentacion foreground exactamente una vez en un mensaje normal y termina este turno; no invoques malahor_run en la misma respuesta.",
        "Una traza u output tecnico del tool en background no cuenta como presentacion del plan y nunca sustituye el mensaje normal.",
        "Espera una solicitud posterior del usuario (por ejemplo, go o implementa) y solo entonces invoca malahor_run.",
        "malahor_run resuelve el plan activo firmado desde ctx.storage; no pidas al usuario el digest ni le exijas /malahor-plan detalles para ejecutar. Un digest explicito sigue siendo compatible y debe coincidir exactamente.",
        "Un go previo a la presentacion no aprueba un plan todavia no visto.",
        "El plan enumera rutas/comandos/subagentes exactos. Si cambian materialmente, presenta una revision nueva y vuelve a pedir confirmaciones.",
        "Los retries tecnicos con el mismo ActionIntentV1 reutilizan la revision V5; ASK, DENY, cambios materiales o loop guard bloquean sin auto-planificar.",
        "Si un guardrail incluye remediacion estructurada y saneada, explicala para una persona no desarrolladora como bloques completos de referencia y reemplazo: archivo y linea, busca, reemplaza, guarda y revalida.",
        "Sin remediacion verificable no inventes lineas ni codigo ni pidas interpretar variables. ASK requiere aprobacion, hard DENY no tiene atajo y secretos reales o ambiguos se retiran o rotan; una edicion manual solo permite continuar despues de revalidar.",
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

async function resolveRunDigest(
  value: unknown,
  storage: PlanningStorage,
  scope: PlanScope,
  authority: PlanningAuthority,
): Promise<string> {
  if (!isRecord(value)) throw new Error("Entrada de malahor_run no evaluable.");
  const provided = value.digest;
  if (provided !== undefined) return text(provided);
  const active = await readPlan(storage, scope.sessionID, authority);
  if (!active) throw new Error("No hay un plan activo firmado para solicitar ejecucion.");
  return active.digest;
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

function normalizeAction(action: string, resource: string, directory: string): PlannedAction {
  return { action, resource: action === "edit" ? path.resolve(directory, resource) : resource };
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

function sortedPlannedActions(actions: PlannedAction[]): PlannedAction[] {
  return [...new Map(actions.map((action) => [`${action.action}\0${action.resource}`, { ...action }])).values()]
    .sort((left, right) => compareText(
      `${left.action}\0${left.resource}`,
      `${right.action}\0${right.resource}`,
    ));
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

function validateLevelZeroActions(actions: PlannedAction[], projectRoot: string): void {
  const aliases = loadGitAliases(projectRoot);
  for (const action of actions) {
    if (action.action === "edit") {
      if (!insideExistingPath(action.resource, projectRoot)) {
        throw new Error("Nivel 0 solo modifica archivos existentes dentro del proyecto.");
      }
      let stat: fs.Stats;
      try { stat = fs.lstatSync(action.resource); }
      catch { throw new Error("Nivel 0 solo modifica un archivo existente."); }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Nivel 0 exige un archivo regular existente.");
      if (isProtectedDocumentationPath(projectRoot, action.resource)
        || classifyInfrastructurePath(projectRoot, action.resource).protected) {
        throw new Error("Nivel 0 no modifica documentacion operativa ni superficies protegidas.");
      }
      continue;
    }
    if (action.action !== "shell") continue;
    if (classifyInfrastructureCommand(action.resource).protected || installationCommand(action.resource)) {
      throw new Error("Nivel 0 no instala, publica ni despliega.");
    }
    if (destructiveCommand(action.resource)) throw new Error("Nivel 0 no admite comandos destructivos.");
    const git = classifyGitCommand(action.resource, { aliases });
    if (git.remote || git.destructive || git.failClosed
      || git.operations.some((operation) => !["read", "stage", "commit"].includes(operation))) {
      throw new Error("Nivel 0 solo admite lectura Git, stage exacto y commit ordinario bajo sus hooks.");
    }
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

function insideExistingPath(target: string, root: string): boolean {
  if (!inside(target, root)) return false;
  try {
    return inside(fs.realpathSync(target), fs.realpathSync(root));
  } catch {
    return false;
  }
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
