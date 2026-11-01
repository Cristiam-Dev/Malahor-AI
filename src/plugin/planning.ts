import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../cli/core/config";
import { registeredProjectRoots } from "../cli/core/context";
import { MODE_CHANGE_ACTION, parseModeName, previewModeChange } from "../cli/core/mode";
import { resolvePaths } from "../cli/core/paths";
import {
  controlPlan, DEFAULT_PLANNING_AUTHORITY, planAllows, presentPlan, renderPlan, requestPlanExecution, validState,
  type PlanControl, type PlanInput, type PlannedAction, type PlanScope, type PlanState, type PlanningAdapter,
} from "../cli/core/planning";
import type { PlanningAuthority } from "../cli/core/planning-authority";
import { detectSecretKinds, type PluginAdapterOptions } from "../cli/core/hooks/plugin-adapter";
import { isProtectedDocumentationPath, parsePatchOperations } from "../cli/core/documentation-boundary";
import { classifyInfrastructureCommand, classifyInfrastructurePath } from "../cli/core/infrastructure-boundary";
import { classifyGitCommand, loadGitAliases } from "../cli/core/git-command-policy";
import {
  loadPlanRecord,
  persistPlanState,
  planKey,
  type PlanningRetentionStorage,
} from "./plan-retention";

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
    if (!state || digest !== state.digest || state.project !== resolved?.scope.project
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

  if (CODE_READ_TOOLS.has(action) && resolved?.scope.mode === "advisor") {
    deny(input, "Asesor: no consulta archivos de codigo ni verifica la implementacion.");
    return;
  }
  if (!PROTECTED.has(normalized)) {
    if (action && !READ_ONLY_TOOLS.has(action) && !routineTool(action) && action !== "*"
      && action !== "external_directory") deny(input, `Tool no clasificada para planeacion: ${action}`);
    return;
  }
  if (!resolved || !storage) {
    deny(input, "No hay proyecto/sesion o almacenamiento de planeacion mediable.");
    return;
  }
  if (resolved.scope.mode === "advisor") {
    deny(input, "El asesor no ejecuta acciones de programacion ni con una solicitud explicita.");
    return;
  }
  if (normalized !== "subagent" && await delegatedSpecialist(input.sessionID, resolved.scope, options, storage, authority)) return;
  const state = await readPlan(storage, resolved.scope.sessionID, authority);
  const resources = Array.isArray(input.resources) ? input.resources : [];
  if (!permissionResourcesAllowed(
    state, resolved.scope, normalized, resources, resolved.directory, authority,
  )) {
    deny(input, "Accion no incluida en un plan vigente y confirmado.");
  }
}

/** Segunda frontera: rutas directas y argumentos de tool, no solo permission.evaluate. */
export async function evaluatePlanningTool(
  input: Record<string, unknown>, options: PluginAdapterOptions, storage?: PlanningStorage,
  authority: PlanningAuthority = fallbackAuthority,
): Promise<void> {
  const tool = text(input.tool);
  if (routineTool(tool)) return;
  if (["question", "list", "todowrite", "todoread", "invalid"].includes(tool)) return;
  const resolved = await resolvePlanningScope(input.sessionID, options);
  if (!resolved || !storage) throw new Error("Malahor: sesion/proyecto de planeacion no mediable.");
  if (CODE_READ_TOOLS.has(tool) && resolved.scope.mode === "advisor") {
    throw new Error("Malahor: asesor no consulta archivos de codigo.");
  }
  if (READ_ONLY_TOOLS.has(tool)) return;
  if (resolved.scope.mode === "advisor") {
    throw new Error("Malahor: el asesor no ejecuta acciones de programacion.");
  }
  if (["edit", "write", "patch", "shell", "bash"].includes(tool)
    && await delegatedSpecialist(input.sessionID, resolved.scope, options, storage, authority)) return;
  const actions = toolActions(tool, input.input, resolved.directory);
  const state = await readPlan(storage, resolved.scope.sessionID, authority);
  if (!actions || actions.length === 0 || actions.some((operation) => !planAllows(state, resolved.scope, operation, Date.now(), authority))) {
    throw new Error(`Malahor: ${tool || "tool"} fuera de un plan vigente y confirmado.`);
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
        const state = await presentPlan(
          resolved.scope, { ...raw, actions }, call.messageID,
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
      description: "En un turno posterior al plan, solicita la segunda confirmacion del asistente o la aprobacion previa del ejecutor. No ejecuta herramientas por si misma.",
      input: { type: "object", properties: { digest: { type: "string" } }, required: ["digest"], additionalProperties: false },
      options: { namespace: "malahor", codemode: false },
      execute: async (value: unknown, call: ToolCall) => {
        const resolved = await requireScope(call, options);
        if (call.agent !== "malahor") throw new Error("Solo el primario puede solicitar ejecucion.");
        const digest = text((value as { digest?: unknown }).digest);
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
    loadActive: (sessionID) => storage.get(planKey(sessionID)),
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
        "En riesgo bajo o medio sin categorias criticas, no incrustes IDs, comandos ni el anexo tecnico en la vista normal; el detalle exacto se consulta con /malahor-plan detalles.",
        "Un riesgo alto o una categoria critica mantiene el anexo completo visible y abierto por defecto, sin interaccion adicional.",
        "Despues de malahor_plan, copia el Markdown delimitado como una presentacion foreground exactamente una vez en un mensaje normal y termina este turno; no invoques malahor_run en la misma respuesta.",
        "Una traza u output tecnico del tool en background no cuenta como presentacion del plan y nunca sustituye el mensaje normal.",
        "Espera una solicitud posterior del usuario (por ejemplo, go o implementa) y solo entonces invoca malahor_run.",
        "Un go previo a la presentacion no aprueba un plan todavia no visto.",
        "El plan enumera rutas/comandos/subagentes exactos. Si cambian materialmente, presenta una revision nueva y vuelve a pedir confirmaciones.",
        "La autorizacion no caduca por tiempo. Pausa, reanuda, revoca o consulta estado con malahor_plan_control o /malahor-plan.",
        "Las dependencias bloquean sin heredar permisos ni arrancar automaticamente.",
        "Las aprobaciones de plan no autorizan commit, push, stage, instalacion local ni evitan guardrails.",
        state ? `Estado: ${state.phase}; plan ${state.planID.slice(0, 12)}; revision ${state.revision.slice(0, 12)}; sin caducidad temporal.`
          : "Estado: sin plan vigente.",
      ].join("\n");
  const system = Array.isArray(input.system) ? input.system : [];
  const marker = "<!-- malahor-planning:v4 -->";
  const previousMarkers = [
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
    const record = await storage.get(planKey(sessionID));
    return validState(record, authority) ? record : undefined;
  } catch { return undefined; }
}

async function ask(port: ApprovalPort, call: ToolCall, action: string, digest: string): Promise<void> {
  await port.assert({ sessionID: call.sessionID, agent: call.agent,
    source: { type: "tool", messageID: call.messageID, id: call.id },
    action, resources: [digest], save: [],
  });
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
    if ([args.cwd, args.workdir].some((cwd) => cwd !== undefined
      && (typeof cwd !== "string" || path.resolve(directory, cwd) !== path.resolve(directory)))) return undefined;
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

function permissionResourcesAllowed(
  state: unknown,
  scope: PlanScope,
  action: string,
  resources: unknown[],
  directory: string,
  authority: PlanningAuthority,
): boolean {
  if (resources.length === 0 || resources.some((item) => typeof item !== "string")) return false;
  const now = Date.now();
  if (resources.every((item) => planAllows(
    state, scope, normalizeAction(action, item as string, directory), now, authority,
  ))) return true;

  // OpenCode V2 escanea un comando compuesto y emite un recurso por cada
  // subcomando. La segunda frontera (tool.execute.before) conserva la
  // coincidencia exacta del comando original; aqui solo reconstruimos `&&`
  // para no rechazar antes un comando compuesto que si figura en el plan.
  if (action !== "shell" || resources.length < 2) return false;
  const compound = (resources as string[]).join(" && ");
  return planAllows(state, scope, { action: "shell", resource: compound }, now, authority);
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

function deny(input: Record<string, unknown>, message: string): void {
  input.effect = "deny";
  input.message = `[malahor.plan] ${message}`;
}
