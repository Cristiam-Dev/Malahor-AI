import { createHash, randomBytes } from "node:crypto";
import type { MalahorMode } from "./config";
import {
  createEphemeralPlanningAuthority,
  type PlanningAuthority,
} from "./planning-authority";
import {
  normalizePlanPresentation,
  renderPlanPresentation,
  validPlanPresentation,
  type PlanPresentationInput,
  type PlanPresentationOptions,
  type PlanPresentationView,
} from "./plan-presentation";

export interface PlannedAction {
  action: string;
  resource: string;
}

export type PlanLevel = 0 | 1 | 2;

export interface PlanDependency {
  planID: string;
  revision: string;
}

export interface PlanInput {
  /** Ausente solo para compatibilidad con callers/estados V4 anteriores; las tools nuevas lo exigen. */
  level?: PlanLevel;
  summary: string;
  steps: string[];
  presentation: PlanPresentationInput;
  actions: PlannedAction[];
  dependencies?: PlanDependency[];
}

export interface NormalizedPlanInput {
  level?: PlanLevel;
  summary: string;
  steps: string[];
  presentation: PlanPresentationInput;
  actions: PlannedAction[];
  dependencies: PlanDependency[];
}

export type PlanPhase = "presented" | "reviewed" | "running" | "paused" | "blocked"
  | "completed" | "revoked" | "superseded";
export type PlanControl = "status" | "pause" | "resume" | "revoke" | "complete";

export interface PlanState {
  version: 4;
  planID: string;
  sessionID: string;
  project: string;
  mode: MalahorMode;
  policyRevision: string;
  presentationInteractionID: string;
  plan: NormalizedPlanInput;
  digest: string;
  revision: string;
  phase: PlanPhase;
  createdAt: number;
  updatedAt: number;
  reviewedAt?: number;
  authorizedAt?: number;
  startedAt?: number;
  pausedAt?: number;
  blockedAt?: number;
  completedAt?: number;
  revokedAt?: number;
  supersededAt?: number;
  blockedBy?: PlanDependency[];
  proof: string;
}

export interface PlanScope {
  sessionID: string;
  project: string;
  mode: MalahorMode;
  policyRevision: string;
}

export interface PlanningAdapter {
  loadActive(sessionID: string): Promise<unknown>;
  loadPlan(planID: string): Promise<unknown>;
  save(state: PlanState): Promise<void>;
  confirm(kind: "review" | "run" | "resume" | "complete", state: PlanState): Promise<void>;
}

const ACTIONS = new Set(["edit", "shell", "subagent"]);
const PHASES = new Set<PlanPhase>([
  "presented", "reviewed", "running", "paused", "blocked", "completed", "revoked", "superseded",
]);
const TERMINAL = new Set<PlanPhase>(["completed", "revoked", "superseded"]);
const CORE_INTERACTION_ID = "core:direct";
export const DEFAULT_PLANNING_AUTHORITY = createEphemeralPlanningAuthority();
const transitions = new Map<string, Promise<void>>();

export async function presentPlan(
  scope: PlanScope,
  input: PlanInput,
  presentationInteractionID: string,
  adapter: PlanningAdapter,
  authority: PlanningAuthority = DEFAULT_PLANNING_AUTHORITY,
): Promise<PlanState> {
  return serialize(scope.sessionID, async () => {
    const now = Date.now();
    const stored = await adapter.loadActive(scope.sessionID);
    const previous = validState(stored, authority) && stored.sessionID === scope.sessionID ? stored : undefined;
    const current = previous && samePlanScope(previous, scope) ? previous : undefined;
    const planID = current && !TERMINAL.has(current.phase) ? current.planID : randomID();
    const state = proposePlan(scope, input, now, presentationInteractionID, planID, authority);
    await assertDependencyGraph(state, adapter, authority);
    if (previous && !TERMINAL.has(previous.phase)) {
      await adapter.save(seal({ ...previous, phase: "superseded", supersededAt: now, updatedAt: now }, authority));
    }
    await adapter.save(state);
    if (scope.mode !== "assistant") return state;
    await adapter.confirm("review", state);
    const fresh = await adapter.loadActive(scope.sessionID);
    if (!sameRevision(fresh, state, authority)) throw new Error("El plan cambio durante la revision: vuelve a presentarlo.");
    const reviewed = reviewPlan(fresh, state.digest, Date.now(), authority);
    await adapter.save(reviewed);
    return reviewed;
  });
}

export async function requestPlanExecution(
  scope: PlanScope,
  digest: string,
  executionInteractionID: string,
  adapter: PlanningAdapter,
  authority: PlanningAuthority = DEFAULT_PLANNING_AUTHORITY,
): Promise<PlanState> {
  return serialize(scope.sessionID, async () => {
    if (!validInteractionID(executionInteractionID)) throw new Error("Turno de ejecucion no evaluable.");
    const stored = await adapter.loadActive(scope.sessionID);
    if (!validState(stored, authority) || stored.digest !== digest || !samePlanScope(stored, scope)
      || stored.plan.actions.length === 0 || (stored.mode === "assistant" ? stored.phase !== "reviewed" : stored.phase !== "presented")) {
      throw new Error("No hay un plan ejecutable vigente.");
    }
    if (stored.presentationInteractionID === executionInteractionID) {
      throw new Error("El plan debe quedar visible y terminar su turno de presentacion. Espera una solicitud posterior del usuario antes de pedir aprobacion.");
    }
    if (stored.mode === "advisor") throw new Error("Primero revisa el plan.");
    await adapter.confirm("run", stored);
    const fresh = await adapter.loadActive(scope.sessionID);
    if (!sameRevision(fresh, stored, authority)) throw new Error("El plan cambio durante la orden: vuelve a presentarlo.");
    const pending = await pendingDependencies(fresh, adapter, authority);
    const next = pending.length > 0
      ? blockPlan(fresh, pending, Date.now(), authority)
      : authorizePlanAfterDependencyValidation(fresh, fresh.digest, Date.now(), authority);
    await adapter.save(next);
    return next;
  });
}

export async function controlPlan(
  scope: PlanScope,
  command: PlanControl,
  adapter: PlanningAdapter,
  authority: PlanningAuthority = DEFAULT_PLANNING_AUTHORITY,
): Promise<PlanState> {
  return serialize(scope.sessionID, async () => {
    const stored = await adapter.loadActive(scope.sessionID);
    if (!validState(stored, authority) || !samePlanScope(stored, scope)) throw new Error("No hay un plan vigente para esta sesion.");
    if (command === "status") return stored;
    if (command === "pause") {
      if (stored.phase !== "running") throw new Error("Solo un plan en ejecucion puede pausarse.");
      const next = seal({ ...stored, phase: "paused", pausedAt: Date.now(), updatedAt: Date.now() }, authority);
      await adapter.save(next);
      return next;
    }
    if (command === "revoke") {
      if (TERMINAL.has(stored.phase)) throw new Error("El plan ya esta cerrado.");
      const next = seal({ ...stored, phase: "revoked", revokedAt: Date.now(), updatedAt: Date.now() }, authority);
      await adapter.save(next);
      return next;
    }
    if (command === "resume") {
      if (stored.phase !== "paused" && stored.phase !== "blocked") throw new Error("Solo un plan pausado o bloqueado puede reanudarse.");
      await adapter.confirm("resume", stored);
      const fresh = await adapter.loadActive(scope.sessionID);
      if (!sameRevision(fresh, stored, authority)) throw new Error("El plan cambio durante la reanudacion.");
      const pending = await pendingDependencies(fresh, adapter, authority);
      const now = Date.now();
      const next = pending.length > 0 ? blockPlan(fresh, pending, now, authority)
        : seal({ ...fresh, phase: "running", startedAt: fresh.startedAt ?? now, updatedAt: now,
          blockedBy: undefined, blockedAt: undefined, pausedAt: undefined }, authority);
      await adapter.save(next);
      return next;
    }
    if (stored.phase !== "running" && stored.phase !== "paused") {
      throw new Error("Solo un plan iniciado puede completarse.");
    }
    await adapter.confirm("complete", stored);
    const fresh = await adapter.loadActive(scope.sessionID);
    if (!sameRevision(fresh, stored, authority)) throw new Error("El plan cambio durante el cierre.");
    const pending = await pendingDependencies(fresh, adapter, authority);
    if (pending.length > 0) throw new Error("El plan no puede completarse con dependencias pendientes.");
    const now = Date.now();
    const next = seal({ ...fresh, phase: "completed", completedAt: now, updatedAt: now }, authority);
    await adapter.save(next);
    return next;
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

export function proposePlan(
  scope: PlanScope,
  input: PlanInput,
  now = Date.now(),
  presentationInteractionID = CORE_INTERACTION_ID,
  planID = randomID(),
  authority: PlanningAuthority = DEFAULT_PLANNING_AUTHORITY,
): PlanState {
  validateScope(scope, now);
  if (!validInteractionID(presentationInteractionID)) throw new Error("Turno de presentacion no evaluable.");
  if (!/^[a-f0-9]{32}$/.test(planID)) throw new Error("Identidad de plan no evaluable.");
  const plan = normalizePlan(scope.mode, input);
  const revision = randomID();
  const digest = digestPlan(scope, plan, planID, revision, presentationInteractionID);
  return seal({
    version: 4, planID, ...scope, presentationInteractionID, plan, digest, revision,
    phase: "presented", createdAt: now, updatedAt: now, proof: "",
  }, authority);
}

export function reviewPlan(
  state: PlanState,
  digest: string,
  now = Date.now(),
  authority: PlanningAuthority = DEFAULT_PLANNING_AUTHORITY,
): PlanState {
  assertCurrent(state, digest, now, authority);
  if (state.mode !== "assistant" || state.phase !== "presented") throw new Error("Revision de plan no aplicable.");
  return seal({ ...state, phase: "reviewed", reviewedAt: now, updatedAt: now }, authority);
}

export function authorizePlan(
  state: PlanState,
  digest: string,
  now = Date.now(),
  authority: PlanningAuthority = DEFAULT_PLANNING_AUTHORITY,
): PlanState {
  assertCurrent(state, digest, now, authority);
  assertReadyForAuthorization(state);
  if (state.plan.dependencies.length > 0) throw new Error("Las dependencias deben validarse mediante el adaptador antes de ejecutar.");
  return startPlan(state, now, authority);
}

function authorizePlanAfterDependencyValidation(
  state: PlanState,
  digest: string,
  now: number,
  authority: PlanningAuthority,
): PlanState {
  assertCurrent(state, digest, now, authority);
  assertReadyForAuthorization(state);
  return startPlan(state, now, authority);
}

function assertReadyForAuthorization(state: PlanState): void {
  if (state.mode === "advisor" || (state.mode === "assistant" ? state.phase !== "reviewed" : state.phase !== "presented")) {
    throw new Error("Falta la revision del plan o el modo no permite ejecucion.");
  }
}

function startPlan(state: PlanState, now: number, authority: PlanningAuthority): PlanState {
  return seal({ ...state, phase: "running", authorizedAt: now, startedAt: now, updatedAt: now }, authority);
}

export function planAllows(
  state: unknown,
  scope: PlanScope,
  operation: PlannedAction,
  now = Date.now(),
  authority: PlanningAuthority = DEFAULT_PLANNING_AUTHORITY,
): boolean {
  if (!validState(state, authority) || state.phase !== "running" || state.mode === "advisor" || scope.mode === "advisor"
    || !samePlanScope(state, scope) || state.createdAt > now || state.updatedAt > now) return false;
  return state.plan.actions.some(({ action, resource }) => action === operation.action && resource === operation.resource);
}

export function validState(state: unknown, authority: PlanningAuthority = DEFAULT_PLANNING_AUTHORITY): state is PlanState {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const value = state as Record<string, unknown>;
  if (value.version !== 4 || typeof value.planID !== "string" || !/^[a-f0-9]{32}$/.test(value.planID)
    || typeof value.sessionID !== "string" || typeof value.project !== "string"
    || !["advisor", "assistant", "executor"].includes(String(value.mode))
    || typeof value.policyRevision !== "string" || !/^[a-f0-9]{32}$/.test(value.policyRevision)
    || !validInteractionID(value.presentationInteractionID)
    || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
    || typeof value.revision !== "string" || !/^[a-f0-9]{32}$/.test(value.revision)
    || typeof value.phase !== "string" || !PHASES.has(value.phase as PlanPhase)
    || !validTime(value.createdAt) || !validTime(value.updatedAt) || (value.updatedAt as number) < (value.createdAt as number)
    || !validOptionalTimes(value)
    || !validPlan(value.plan, value.mode as MalahorMode)
    || typeof value.proof !== "string") return false;
  const plan = value.plan as NormalizedPlanInput;
  const expected = digestPlan({
    sessionID: value.sessionID as string, project: value.project as string,
    mode: value.mode as MalahorMode, policyRevision: value.policyRevision as string,
  }, plan, value.planID, value.revision, value.presentationInteractionID as string);
  if (expected !== value.digest || !validPhase(value)) return false;
  return authority.verify(statePayload(value), value.proof);
}

export function renderPlan(
  state: PlanState,
  options: PlanPresentationOptions | PlanPresentationView = {},
): string {
  return renderPlanPresentation(state, options);
}

function normalizePlan(mode: MalahorMode, input: PlanInput): NormalizedPlanInput {
  if (!input || typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 4000) {
    throw new Error("El plan necesita un resumen no vacio (maximo 4000 caracteres).");
  }
  const level = normalizePlanLevel(input.level);
  const dependencies = input.dependencies ?? [];
  if (!Array.isArray(input.steps) || !Array.isArray(input.actions) || !Array.isArray(dependencies)
    || input.steps.length > 30 || input.actions.length > 80 || dependencies.length > 30) {
    throw new Error("Pasos, acciones o dependencias invalidos o demasiado extensos.");
  }
  if (mode === "advisor" && (input.steps.length !== 0 || input.actions.length !== 0 || dependencies.length !== 0)) {
    throw new Error("Asesor solo presenta un concepto, sin pasos ni ejecucion.");
  }
  if (mode !== "advisor" && input.steps.length === 0) throw new Error("El plan requiere pasos visibles.");
  if (mode !== "advisor" && input.actions.length === 0) throw new Error("El plan requiere acciones o efectos exactos.");
  if (input.steps.some((step) => typeof step !== "string" || !step.trim() || step.length > 1000)) throw new Error("Paso de plan invalido.");
  if (input.actions.some((item) => !item || typeof item.action !== "string" || !ACTIONS.has(item.action)
    || typeof item.resource !== "string" || !item.resource.trim() || item.resource.length > 4096)) {
    throw new Error("La accion debe ser edit, shell o subagent con recurso exacto.");
  }
  if (dependencies.some((item) => !item || !/^[a-f0-9]{32}$/.test(item.planID) || !/^[a-f0-9]{32}$/.test(item.revision))) {
    throw new Error("Dependencia de plan invalida.");
  }
  if (JSON.stringify(input).length > 12_000) throw new Error("El plan es demasiado grande para una revision visible.");
  const presentation = normalizePlanPresentation(input.presentation, mode, level);
  const actions = uniqueSorted(input.actions, (item) => `${item.action}\0${item.resource}`);
  const normalizedDependencies = uniqueSorted(dependencies, (item) => `${item.planID}\0${item.revision}`);
  validatePlanLevel(level, mode, input.steps, presentation, actions, normalizedDependencies);
  const normalized = {
    summary: input.summary.trim(), steps: [...input.steps], presentation, actions, dependencies: normalizedDependencies,
  };
  return input.level === undefined ? normalized : { level, ...normalized };
}

function normalizePlanLevel(value: unknown): PlanLevel {
  if (value === undefined) return 1;
  if (value === 0 || value === 1 || value === 2) return value;
  throw new Error("Nivel de plan invalido: usa 0, 1 o 2.");
}

function validatePlanLevel(
  level: PlanLevel,
  mode: MalahorMode,
  steps: string[],
  presentation: PlanPresentationInput,
  actions: PlannedAction[],
  dependencies: PlanDependency[],
): void {
  if (level !== 0) return;
  const editTargets = new Set(actions.filter((item) => item.action === "edit").map((item) => item.resource));
  if (mode === "advisor") throw new Error("Nivel 0 requiere un modo de ejecucion; asesor solo presenta conceptos.");
  if (steps.length > 3 || presentation.steps.length > 2 || presentation.impact.length > 1
    || presentation.exclusions.length > 3 || presentation.completionCriteria.length > 3) {
    throw new Error("Nivel 0 exige un plan minimo: hasta tres pasos internos, dos pasos visibles y listas breves.");
  }
  if (presentation.risk.level !== "low" || presentation.risk.categories.length > 0) {
    throw new Error("Nivel 0 solo admite riesgo bajo y ninguna categoria critica.");
  }
  if (dependencies.length > 0) throw new Error("Nivel 0 no admite dependencias entre planes.");
  if (actions.some((item) => item.action === "subagent")) throw new Error("Nivel 0 no usa subagentes.");
  if (editTargets.size > 1) throw new Error("Nivel 0 solo puede modificar un archivo existente.");
}

async function assertDependencyGraph(state: PlanState, adapter: PlanningAdapter, authority: PlanningAuthority): Promise<void> {
  const visit = async (dependencies: PlanDependency[], trail: Set<string>): Promise<void> => {
    for (const dependency of dependencies) {
      if (dependency.planID === state.planID || trail.has(dependency.planID)) throw new Error("Ciclo de dependencias de plan detectado.");
      const raw = await adapter.loadPlan(dependency.planID);
      if (!validState(raw, authority) || raw.project !== state.project || raw.revision !== dependency.revision) {
        throw new Error(`Dependencia de plan no evaluable: ${dependency.planID}.`);
      }
      const next = new Set(trail);
      next.add(dependency.planID);
      await visit(raw.plan.dependencies, next);
    }
  };
  await visit(state.plan.dependencies, new Set([state.planID]));
}

async function pendingDependencies(
  state: PlanState, adapter: PlanningAdapter, authority: PlanningAuthority,
): Promise<PlanDependency[]> {
  const pending: PlanDependency[] = [];
  for (const dependency of state.plan.dependencies) {
    const raw = await adapter.loadPlan(dependency.planID);
    if (!validState(raw, authority) || raw.project !== state.project
      || raw.revision !== dependency.revision || raw.phase !== "completed") pending.push(dependency);
  }
  return pending;
}

function blockPlan(state: PlanState, blockedBy: PlanDependency[], now: number, authority: PlanningAuthority): PlanState {
  return seal({ ...state, phase: "blocked", authorizedAt: state.authorizedAt ?? now, blockedAt: now,
    blockedBy, updatedAt: now }, authority);
}

function assertCurrent(state: PlanState, digest: string, now: number, authority: PlanningAuthority): void {
  if (!validState(state, authority) || state.digest !== digest || !Number.isFinite(now) || state.createdAt > now) {
    throw new Error("Plan cambiado o no evaluable: vuelve a presentarlo.");
  }
}

function seal(state: PlanState, authority: PlanningAuthority): PlanState {
  const next = { ...state, proof: "" };
  return { ...next, proof: authority.sign(statePayload(next as unknown as Record<string, unknown>)) };
}

function statePayload(value: Record<string, unknown>): string {
  const { proof: _proof, ...payload } = value;
  return canonical(payload);
}

function digestPlan(
  scope: PlanScope, plan: NormalizedPlanInput, planID: unknown, revision: unknown, presentationInteractionID: string,
): string {
  return createHash("sha256").update(canonical({ scope, plan, planID, revision, presentationInteractionID })).digest("hex");
}

function sameRevision(value: unknown, expected: PlanState, authority: PlanningAuthority): value is PlanState {
  return validState(value, authority) && value.planID === expected.planID
    && value.revision === expected.revision && value.digest === expected.digest && value.proof === expected.proof;
}

function samePlanScope(state: PlanState, scope: PlanScope): boolean {
  return state.sessionID === scope.sessionID && state.project === scope.project
    && state.mode === scope.mode && state.policyRevision === scope.policyRevision;
}

function validPlan(value: unknown, mode: MalahorMode): value is NormalizedPlanInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  const level = plan.level === undefined ? 1 : plan.level;
  if (level !== 0 && level !== 1 && level !== 2) return false;
  const structurallyValid = typeof plan.summary === "string" && Array.isArray(plan.steps) && Array.isArray(plan.actions)
    && Array.isArray(plan.dependencies) && plan.steps.every((step) => typeof step === "string")
    && validPlanPresentation(plan.presentation, mode, level)
    && plan.actions.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && ACTIONS.has(String((entry as Record<string, unknown>).action))
      && typeof (entry as Record<string, unknown>).resource === "string")
    && plan.dependencies.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && /^[a-f0-9]{32}$/.test(String((entry as Record<string, unknown>).planID))
      && /^[a-f0-9]{32}$/.test(String((entry as Record<string, unknown>).revision)));
  if (!structurallyValid) return false;
  try {
    validatePlanLevel(
      level as PlanLevel,
      mode,
      plan.steps as string[],
      plan.presentation as PlanPresentationInput,
      plan.actions as PlannedAction[],
      plan.dependencies as PlanDependency[],
    );
    return true;
  } catch {
    return false;
  }
}

function validPhase(value: Record<string, unknown>): boolean {
  const phase = value.phase as PlanPhase;
  if (value.mode === "advisor" && phase !== "presented" && phase !== "revoked" && phase !== "superseded") return false;
  if (phase === "reviewed" && (value.mode !== "assistant" || !validTime(value.reviewedAt))) return false;
  if (["running", "paused", "blocked", "completed"].includes(phase)
    && (!validTime(value.authorizedAt) || (phase !== "blocked" && !validTime(value.startedAt)))) return false;
  if (phase === "paused" && !validTime(value.pausedAt)) return false;
  if (phase === "blocked" && (!validTime(value.blockedAt) || !Array.isArray(value.blockedBy) || value.blockedBy.length === 0)) return false;
  if (phase === "completed" && !validTime(value.completedAt)) return false;
  if (phase === "revoked" && !validTime(value.revokedAt)) return false;
  if (phase === "superseded" && !validTime(value.supersededAt)) return false;
  return true;
}

function validOptionalTimes(value: Record<string, unknown>): boolean {
  return ["reviewedAt", "authorizedAt", "startedAt", "pausedAt", "blockedAt", "completedAt", "revokedAt", "supersededAt"]
    .every((key) => value[key] === undefined || validTime(value[key]));
}

function validateScope(scope: PlanScope, now: number): void {
  if (!scope.sessionID || !scope.project || !/^[a-f0-9]{32}$/.test(scope.policyRevision) || !Number.isFinite(now)) {
    throw new Error("Sesion/proyecto/politica de plan no evaluable.");
  }
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validInteractionID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function randomID(): string {
  return randomBytes(16).toString("hex");
}

function uniqueSorted<T extends object>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), { ...item } as T])).values()]
    .sort((left, right) => compareText(key(left), key(right)));
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
