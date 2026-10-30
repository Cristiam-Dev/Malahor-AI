import path from "node:path";

import { loadConfig } from "../cli/core/config";
import { registeredProjectRoots } from "../cli/core/context";
import { MODE_CHANGE_ACTION, parseModeName, previewModeChange } from "../cli/core/mode";
import { resolvePaths } from "../cli/core/paths";
import {
  planAllows, presentPlan, renderPlan, requestPlanExecution, validState,
  type PlanInput, type PlannedAction, type PlanScope, type PlanState, type PlanningAdapter,
} from "../cli/core/planning";
import { detectSecretKinds, type PluginAdapterOptions } from "../cli/core/hooks/plugin-adapter";

export interface PlanningStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: PlanState): Promise<void>;
}

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
const READ_ONLY_TOOLS = new Set([
  "read", "glob", "grep", "webfetch", "websearch", "list", "question", "skill",
  "todowrite", "todoread", "invalid", "malahor_plan", "malahor_run",
]);
const PROTECTED = new Set(["edit", "shell", "subagent"]);
const CODE_READ_TOOLS = new Set(["read", "glob", "grep"]);

/** Solo las acciones declaradas se median aquí; las demás políticas del host siguen vigentes. */
export async function evaluatePlanningPermission(
  input: Record<string, unknown>, options: PluginAdapterOptions, storage?: PlanningStorage,
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
  if (action === REVIEW_ACTION || action === RUN_ACTION) {
    const state = resolved && await readPlan(storage, resolved.scope.sessionID);
    const digest = Array.isArray(input.resources) ? input.resources[0] : undefined;
    if (!state || digest !== state.digest || state.project !== resolved?.scope.project
      || state.mode !== resolved.scope.mode || state.policyRevision !== resolved.scope.policyRevision
      || state.expiresAt <= Date.now()
      || (action === REVIEW_ACTION && (state.mode !== "assistant" || state.reviewedAt !== undefined))
      || (action === RUN_ACTION && (state.mode === "advisor" || state.plan.actions.length === 0
        || (state.mode === "assistant" && state.reviewedAt === undefined)))) {
      deny(input, "Plan no vigente o confirmacion fuera de orden.");
      return;
    }
    input.effect = "ask"; // Nunca heredar una aprobacion persistente 'always'.
    input.message = action === REVIEW_ACTION
      ? `Revisa el plan; esta primera confirmacion NO autoriza ejecutar:\n${renderPlan(state)}`
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
  if (normalized !== "subagent" && await delegatedSpecialist(input.sessionID, resolved.scope, options, storage)) return;
  const state = await readPlan(storage, resolved.scope.sessionID);
  const resources = Array.isArray(input.resources) ? input.resources : [];
  if (resources.length === 0 || resources.some((item) => typeof item !== "string"
    || !planAllows(state, resolved.scope, normalizeAction(normalized, item, resolved.directory)))) {
    deny(input, "Accion no incluida en un plan vigente y confirmado.");
  }
}

/** Segunda frontera: rutas directas y argumentos de tool, no solo permission.evaluate. */
export async function evaluatePlanningTool(
  input: Record<string, unknown>, options: PluginAdapterOptions, storage?: PlanningStorage,
): Promise<void> {
  const tool = text(input.tool);
  if (routineTool(tool)) return;
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
    && await delegatedSpecialist(input.sessionID, resolved.scope, options, storage)) return;
  const actions = toolActions(tool, input.input, resolved.directory);
  const state = await readPlan(storage, resolved.scope.sessionID);
  if (!actions || actions.length === 0 || actions.some((operation) => !planAllows(state, resolved.scope, operation))) {
    throw new Error(`Malahor: ${tool || "tool"} fuera de un plan vigente y confirmado.`);
  }
}

export async function registerPlanningTools(
  tools: PlanningTools, approvals: ApprovalPort, storage: PlanningStorage, options: PluginAdapterOptions,
): Promise<{ dispose?: () => Promise<void> | void } | void> {
  return tools.transform((editor) => {
    editor.namespace({ name: "malahor", description: "Plan de trabajo portable de Malahor" });
    editor.add({
      name: "plan",
      description: "Presenta el plan. En asistente solicita la primera confirmacion; en ejecutor muestra el plan para aprobacion posterior. Asesor solo permite concepto.",
      input: {
        type: "object", properties: {
          summary: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          actions: { type: "array", items: {
            type: "object", properties: { action: { type: "string" }, resource: { type: "string" } },
            required: ["action", "resource"], additionalProperties: false,
          } },
        }, required: ["summary", "steps", "actions"], additionalProperties: false,
      },
      options: { namespace: "malahor", codemode: false },
      execute: async (value: unknown, call: ToolCall) => {
        const resolved = await requireScope(call, options);
        if (call.agent !== "malahor") throw new Error("Solo el primario puede presentar el plan.");
        const raw = value as PlanInput;
        if (detectSecretKinds(raw).length > 0) throw new Error("Posible secreto en el plan: no se almacena ni se muestra.");
        const actions = raw.actions?.map((item) => normalizeAction(item.action, item.resource, resolved.directory));
        const state = await presentPlan(resolved.scope, { ...raw, actions }, planningAdapter(storage, approvals, call));
        return { content: `${renderPlan(state)}\nDigest completo: ${state.digest}` };
      },
    });
    editor.add({
      name: "run",
      description: "Solicita la segunda confirmacion del asistente o aprobacion previa del plan del ejecutor. No ejecuta herramientas por si misma.",
      input: { type: "object", properties: { digest: { type: "string" } }, required: ["digest"], additionalProperties: false },
      options: { namespace: "malahor", codemode: false },
      execute: async (value: unknown, call: ToolCall) => {
        const resolved = await requireScope(call, options);
        if (call.agent !== "malahor") throw new Error("Solo el primario puede solicitar ejecucion.");
        const digest = text((value as { digest?: unknown }).digest);
        const state = await requestPlanExecution(resolved.scope, digest, planningAdapter(storage, approvals, call));
        return { content: `Plan ${state.digest.slice(0, 12)} autorizado hasta ${new Date(state.expiresAt).toISOString()}. Solo operaciones declaradas; guardrails vigentes.` };
      },
    });
  });
}

function planningAdapter(storage: PlanningStorage, port: ApprovalPort, call: ToolCall): PlanningAdapter {
  return {
    load: (sessionID) => storage.get(planKey(sessionID)),
    save: (state) => storage.set(planKey(state.sessionID), state),
    confirm: (kind, state) => ask(port, call, kind === "review" ? REVIEW_ACTION : RUN_ACTION, state.digest),
  };
}

/** El subagente hereda SOLO la delegacion explicitamente autorizada; el host conserva sus permisos propios. */
async function delegatedSpecialist(
  sessionID: unknown, scope: PlanScope, options: PluginAdapterOptions, storage?: PlanningStorage,
): Promise<boolean> {
  if (!storage || typeof sessionID !== "string" || !options.resolveParentSession) return false;
  try {
    const parent = await options.resolveParentSession(sessionID);
    if (!parent || !["malahor-diagnostico", "malahor-testing"].includes(parent.agent)) return false;
    const state = await readPlan(storage, parent.parentID);
    return planAllows(state, { ...scope, sessionID: parent.parentID }, { action: "subagent", resource: parent.agent });
  } catch { return false; }
}

export function planKey(sessionID: string): string {
  if (!/^ses[A-Za-z0-9_-]{1,128}$/.test(sessionID)) throw new Error("ID de sesion no evaluable.");
  return `planning/v1/${sessionID}`;
}

export async function injectPlanningInstructions(
  input: Record<string, unknown>, options: PluginAdapterOptions, storage?: PlanningStorage,
): Promise<void> {
  // Los especialistas tienen permisos propios; la mediacion de su lanzamiento es del primario.
  if (input.agent !== "malahor") return;
  const resolved = await resolvePlanningScope(input.sessionID, options);
  const state = resolved && await readPlan(storage, resolved.scope.sessionID);
  const mode = resolved?.scope.mode;
  const instructions = !resolved || !storage
    ? "Planeacion Malahor no disponible: no ejecutes operaciones de programacion. Revisa proyecto registrado y adaptador del host."
    : mode === "advisor"
      ? "Modo asesor: presenta solo concepto/alternativas; sin pasos, rutas de implementacion ni ejecucion. Si usas malahor_plan, steps y actions vacios."
      : [
        `Modo ${mode}: presenta plan visible mediante malahor_plan antes de ejecutar.`,
        mode === "assistant" ? "Guia por pasos; la tool solicita revision del plan y despues malahor_run solicita la segunda confirmacion para ejecutar."
          : "Presenta el plan y solicita su aprobacion previa mediante malahor_run ANTES de ejecutar.",
        "El plan enumera rutas/comandos/subagentes exactos. Si cambian, presenta otro plan y vuelve a pedir confirmaciones.",
        "Las aprobaciones de plan no autorizan commit, push, stage, instalacion local ni evitan guardrails.",
        state ? `Estado: ${state.authorizedAt !== undefined ? "autorizado" : state.reviewedAt !== undefined ? "revisado" : "presentado"}; revision ${state.digest.slice(0, 12)}; caduca ${new Date(state.expiresAt).toISOString()}.`
          : "Estado: sin plan vigente.",
      ].join("\n");
  const system = Array.isArray(input.system) ? input.system : [];
  const marker = "<!-- malahor-planning:v1 -->";
  const last = system.at(-1);
  if (isRecord(last) && last.type === "text" && typeof last.text === "string") {
    if (!last.text.includes(marker)) last.text += `\n\n${marker}\n${instructions}`;
  } else {
    system.push({ type: "text", text: `${marker}\n${instructions}` });
  }
  input.system = system;
}

async function readPlan(storage: PlanningStorage | undefined, sessionID: string): Promise<PlanState | undefined> {
  if (!storage) return undefined;
  try {
    const record = await storage.get(planKey(sessionID));
    return validState(record) ? record : undefined;
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

async function resolvePlanningScope(value: unknown, options: PluginAdapterOptions): Promise<{ scope: PlanScope; directory: string } | undefined> {
  if (typeof value !== "string" || !options.resolveSessionDirectory) return undefined;
  try {
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
    const matches = [...args.patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)];
    return matches.length ? matches.map((match) => normalizeAction("edit", match[1]!, directory)) : undefined;
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

function permissionAction(action: string): string {
  if (["bash", "command"].includes(action)) return "shell";
  if (["write", "patch", "create"].includes(action)) return "edit";
  if (action === "task") return "subagent";
  return action;
}

function routineTool(tool: string): boolean {
  return /^(?:mcp_)?(?:mnemo_|obsidian_|codegraph_(?!.*(?:index|write|delete)))/.test(tool);
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
