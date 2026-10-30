import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { MalahorMode } from "./config";

/** Contrato portable: los adaptadores traducen operaciones del host a action/resource. */
export interface PlannedAction {
  action: string;
  resource: string;
}

export interface PlanInput {
  summary: string;
  steps: string[];
  actions: PlannedAction[];
}

export interface PlanState {
  version: 1;
  sessionID: string;
  project: string;
  mode: MalahorMode;
  policyRevision: string;
  plan: PlanInput;
  digest: string;
  revision: string;
  createdAt: number;
  expiresAt: number;
  reviewedAt?: number;
  authorizedAt?: number;
  reviewProof?: string;
  authorizationProof?: string;
}

export interface PlanScope {
  sessionID: string;
  project: string;
  mode: MalahorMode;
  policyRevision: string;
}

/** Puerto de harness: el core nunca conoce permisos, UI ni almacenamiento de OpenCode. */
export interface PlanningAdapter {
  load(sessionID: string): Promise<unknown>;
  save(state: PlanState): Promise<void>;
  confirm(kind: "review" | "run", state: PlanState): Promise<void>;
}

const PLAN_TTL_MS = 30 * 60_000;
const ACTIONS = new Set(["edit", "shell", "subagent"]);
// Recibos efimeros: una alteracion del storage no fabrica confirmaciones. Al reiniciar se vuelven a pedir.
// No prueban identidad humana: la UI del host sigue siendo la frontera de interaccion.
const receiptKey = randomBytes(32);
// El puerto de storage V2 solo expone get/set. Serializar las transiciones en este proceso
// evita que una confirmacion anterior resucite un plan reemplazado en la misma sesion.
const transitions = new Map<string, Promise<void>>();

export async function presentPlan(scope: PlanScope, input: PlanInput, adapter: PlanningAdapter): Promise<PlanState> {
  return serialize(scope.sessionID, async () => {
    const state = proposePlan(scope, input);
    await adapter.save(state); // Reemplazar el plan revoca autorizaciones anteriores.
    if (scope.mode !== "assistant") return state;
    await adapter.confirm("review", state);
    const current = await adapter.load(scope.sessionID);
    if (!validState(current) || current.revision !== state.revision || current.digest !== state.digest) {
      throw new Error("El plan cambio durante la revision: vuelve a presentarlo.");
    }
    await adapter.save(reviewPlan(current, state.digest));
    return state;
  });
}

export async function requestPlanExecution(scope: PlanScope, digest: string, adapter: PlanningAdapter): Promise<PlanState> {
  return serialize(scope.sessionID, async () => {
    const state = await adapter.load(scope.sessionID);
    if (!validState(state) || state.digest !== digest || state.sessionID !== scope.sessionID
      || state.project !== scope.project || state.mode !== scope.mode || state.policyRevision !== scope.policyRevision
      || state.expiresAt <= Date.now()
      || state.plan.actions.length === 0 || state.authorizedAt !== undefined) {
      throw new Error("No hay un plan ejecutable vigente.");
    }
    if (state.mode === "advisor" || (state.mode === "assistant" && state.reviewedAt === undefined)) {
      throw new Error("Primero revisa el plan.");
    }
    await adapter.confirm("run", state);
    const current = await adapter.load(scope.sessionID);
    if (!validState(current) || current.revision !== state.revision || current.digest !== state.digest) {
      throw new Error("El plan cambio durante la orden: vuelve a presentarlo.");
    }
    const authorized = authorizePlan(current, state.digest);
    await adapter.save(authorized);
    return authorized;
  });
}

async function serialize<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
  const previous = transitions.get(sessionID) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => gate);
  transitions.set(sessionID, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (transitions.get(sessionID) === current) transitions.delete(sessionID);
  }
}

export function proposePlan(scope: PlanScope, input: PlanInput, now = Date.now()): PlanState {
  if (!scope.sessionID || !scope.project || !/^[a-f0-9]{32}$/.test(scope.policyRevision) || !Number.isFinite(now)) {
    throw new Error("Sesion/proyecto/politica de plan no evaluable.");
  }
  if (!input || typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 4000) {
    throw new Error("El plan necesita un resumen no vacio (maximo 4000 caracteres).");
  }
  if (!Array.isArray(input.steps) || !Array.isArray(input.actions) || input.steps.length > 30 || input.actions.length > 80) {
    throw new Error("Pasos/acciones de plan invalidos o demasiado extensos.");
  }
  if (scope.mode === "advisor" && (input.steps.length !== 0 || input.actions.length !== 0)) {
    throw new Error("Asesor solo presenta un concepto, sin pasos ni ejecucion.");
  }
  if (scope.mode !== "advisor" && input.steps.length === 0) throw new Error("El plan requiere pasos visibles.");
  if (input.steps.some((step) => typeof step !== "string" || !step.trim() || step.length > 1000)) {
    throw new Error("Paso de plan invalido.");
  }
  if (input.actions.some((item) => !item || typeof item.action !== "string" || !ACTIONS.has(item.action)
    || typeof item.resource !== "string" || !item.resource.trim() || item.resource.length > 4096)) {
    throw new Error("La accion debe ser edit, shell o subagent con recurso exacto.");
  }
  if (JSON.stringify(input).length > 12_000) throw new Error("El plan es demasiado grande para una revision visible.");
  const actions = [...new Map(input.actions.map((item) => [`${item.action}\0${item.resource}`, { ...item }])).values()]
    .sort((a, b) => `${a.action}\0${a.resource}`.localeCompare(`${b.action}\0${b.resource}`));
  const plan = { summary: input.summary.trim(), steps: [...input.steps], actions };
  const revision = randomBytes(16).toString("hex");
  const digest = createHash("sha256").update(JSON.stringify({ scope, plan, revision })).digest("hex");
  return {
    version: 1, ...scope, plan, digest, revision,
    createdAt: now, expiresAt: now + PLAN_TTL_MS,
  };
}

export function reviewPlan(state: PlanState, digest: string, now = Date.now()): PlanState {
  assertCurrent(state, digest, now);
  if (state.mode !== "assistant" || state.reviewedAt !== undefined) throw new Error("Revision de plan no aplicable.");
  return { ...state, reviewedAt: now, reviewProof: receipt(state, "review", now) };
}

export function authorizePlan(state: PlanState, digest: string, now = Date.now()): PlanState {
  assertCurrent(state, digest, now);
  if (state.mode === "advisor" || (state.mode === "assistant" && state.reviewedAt === undefined)) {
    throw new Error("Falta la revision del plan o el modo no permite ejecucion.");
  }
  if (state.authorizedAt !== undefined) throw new Error("El plan ya tiene una autorizacion vigente.");
  return { ...state, authorizedAt: now, authorizationProof: receipt(state, "run", now) };
}

export function planAllows(state: unknown, scope: PlanScope, operation: PlannedAction, now = Date.now()): boolean {
  if (!validState(state) || state.mode === "advisor" || scope.mode === "advisor" || state.mode !== scope.mode
    || state.sessionID !== scope.sessionID || state.project !== scope.project || state.policyRevision !== scope.policyRevision
    || state.createdAt > now || state.expiresAt <= now
    || state.authorizedAt === undefined || state.authorizedAt > now) return false;
  return state.plan.actions.some(({ action, resource }) => action === operation.action && resource === operation.resource);
}

export function validState(state: unknown): state is PlanState {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const value = state as Record<string, unknown>;
  if (value.version !== 1 || typeof value.sessionID !== "string" || typeof value.project !== "string"
    || !["advisor", "assistant", "executor"].includes(String(value.mode))
    || typeof value.policyRevision !== "string" || !/^[a-f0-9]{32}$/.test(value.policyRevision)
    || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
    || typeof value.revision !== "string" || !/^[a-f0-9]{32}$/.test(value.revision)
    || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)
    || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)
    || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > PLAN_TTL_MS
    || (value.reviewedAt !== undefined && (typeof value.reviewedAt !== "number" || !Number.isFinite(value.reviewedAt)))
    || (value.authorizedAt !== undefined && (typeof value.authorizedAt !== "number" || !Number.isFinite(value.authorizedAt)))
    || (typeof value.reviewedAt === "number" && (value.reviewedAt < value.createdAt || value.reviewedAt >= value.expiresAt))
    || (typeof value.authorizedAt === "number" && (value.authorizedAt < value.createdAt || value.authorizedAt >= value.expiresAt))
    || (value.mode === "advisor" && (value.reviewedAt !== undefined || value.authorizedAt !== undefined))
    || (value.mode === "executor" && value.reviewedAt !== undefined)
    || (value.mode === "assistant" && value.authorizedAt !== undefined && (typeof value.reviewedAt !== "number"
      || (value.authorizedAt as number) < value.reviewedAt))
    || (value.reviewedAt === undefined && value.reviewProof !== undefined)
    || (value.authorizedAt === undefined && value.authorizationProof !== undefined)
    || !value.plan || typeof value.plan !== "object" || Array.isArray(value.plan)) return false;
  const plan = value.plan as Record<string, unknown>;
  if (typeof plan.summary !== "string" || !Array.isArray(plan.steps) || !Array.isArray(plan.actions)
    || !plan.steps.every((step) => typeof step === "string")
    || !plan.actions.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && typeof entry.action === "string" && typeof entry.resource === "string")) return false;
  const expected = createHash("sha256").update(JSON.stringify({ scope: {
    sessionID: value.sessionID, project: value.project, mode: value.mode, policyRevision: value.policyRevision,
  }, plan, revision: value.revision })).digest("hex");
  if (expected !== value.digest) return false;
  const planState = value as unknown as PlanState;
  return (value.reviewedAt === undefined || verifyReceipt(planState, "review", value.reviewedAt, value.reviewProof))
    && (value.authorizedAt === undefined || verifyReceipt(planState, "run", value.authorizedAt, value.authorizationProof));
}

export function renderPlan(state: PlanState): string {
  return [
    `Plan Malahor (${state.mode}) · ${state.digest.slice(0, 12)}`,
    state.plan.summary,
    ...state.plan.steps.map((step, index) => `${index + 1}. ${step}`),
    ...state.plan.actions.map(({ action, resource }) => `- ${action}: ${resource}`),
    `Caduca: ${new Date(state.expiresAt).toISOString()}`,
  ].join("\n");
}

function assertCurrent(state: PlanState, digest: string, now: number): void {
  if (!validState(state) || state.digest !== digest || !Number.isFinite(now) || state.expiresAt <= now) {
    throw new Error("Plan cambiado, expirado o no evaluable: vuelve a presentarlo.");
  }
}

function receipt(state: PlanState, kind: "review" | "run", at: number): string {
  return createHmac("sha256", receiptKey).update(JSON.stringify({
    kind, sessionID: state.sessionID, project: state.project, mode: state.mode, policyRevision: state.policyRevision,
    digest: state.digest, revision: state.revision, at,
    reviewProof: kind === "run" ? state.reviewProof ?? null : null,
  })).digest("hex");
}

function verifyReceipt(state: PlanState, kind: "review" | "run", at: number, proof: unknown): boolean {
  if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(receipt(state, kind, at), "hex"));
}
