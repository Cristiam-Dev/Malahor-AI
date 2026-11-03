import type { MalahorMode } from "./config";
import type { PlanLevel, PlanState } from "./planning";

export type PlanRiskLevel = "low" | "medium" | "high";
export type PlanRiskCategory = "security" | "data" | "architecture" | "destructive";
export type PlanPresentationView = "summary" | "technical";

export interface PlanPresentationStep {
  title: string;
  description: string;
}

export interface PlanPresentationImpact {
  area: string;
  description: string;
}

export interface PlanPresentationRisk {
  level: PlanRiskLevel;
  categories: PlanRiskCategory[];
  summary: string;
  details: string;
}

export interface PlanPresentationInput {
  objective: string;
  outcome: string;
  steps: PlanPresentationStep[];
  impact: PlanPresentationImpact[];
  risk: PlanPresentationRisk;
  exclusions: string[];
  completionCriteria: string[];
}

export interface PlanPresentationOptions {
  view?: PlanPresentationView;
}

export interface PlanExecutionProgressPresentation {
  total: number;
  succeeded: number;
  ready: number;
  waiting: number;
  blocked: number;
  inFlight: number;
  failed: number;
}

export interface PlanRevisionDeltaPresentation {
  preserved: readonly string[];
  changed: readonly string[];
  added: readonly string[];
  removed: readonly string[];
  planChanged?: boolean;
}

export interface PlanActionStatePresentation {
  key: string;
  state: string;
  dependsOn: readonly string[];
}

export interface PlanRevisionPresentationContext {
  parentRevision: string;
  progress: PlanExecutionProgressPresentation;
  delta: PlanRevisionDeltaPresentation;
  actions?: readonly PlanActionStatePresentation[];
}

const MAX_STEPS = 5;
const MAX_ITEMS = 30;
const RISK_LEVELS = new Set<PlanRiskLevel>(["low", "medium", "high"]);
const RISK_CATEGORIES = new Set<PlanRiskCategory>([
  "security", "data", "architecture", "destructive",
]);

export function normalizePlanPresentation(
  value: unknown,
  mode: MalahorMode,
  level: PlanLevel = 1,
): PlanPresentationInput {
  if (!isRecord(value)) throw new Error("El plan necesita una presentacion humana estructurada.");

  const objective = normalizedText(value.objective, "objetivo", 1_000);
  const outcome = normalizedText(value.outcome, "resultado", 1_000);
  const steps = normalizedSteps(value.steps);
  const impact = normalizedImpact(value.impact);
  const risk = normalizedRisk(value.risk);
  const exclusions = normalizedList(value.exclusions, "exclusiones");
  const completionCriteria = normalizedList(value.completionCriteria, "criterios de finalizacion");

  if (mode === "advisor") {
    if (steps.length !== 0 || impact.length !== 0) {
      throw new Error("Asesor solo presenta concepto: sin pasos ni impacto ejecutable.");
    }
  } else if (level !== 0) {
    if (steps.length === 0) throw new Error("La presentacion del plan requiere una ruta con pasos breves.");
    if (impact.length === 0) throw new Error("La presentacion debe declarar su impacto por area.");
  }
  if (completionCriteria.length === 0) {
    throw new Error("La presentacion debe declarar criterios de finalizacion.");
  }
  if (level === 0 && (steps.length > 2 || impact.length > 1 || exclusions.length > 3
    || completionCriteria.length > 3 || risk.level !== "low" || risk.categories.length > 0)) {
    throw new Error("Nivel 0 exige presentacion minima, riesgo bajo y ninguna categoria critica.");
  }

  return { objective, outcome, steps, impact, risk, exclusions, completionCriteria };
}

export function validPlanPresentation(
  value: unknown,
  mode: MalahorMode,
  level: PlanLevel = 1,
): value is PlanPresentationInput {
  try {
    if (!isRecord(value)) return false;
    return samePresentation(value, normalizePlanPresentation(value, mode, level));
  } catch {
    return false;
  }
}

export function renderPlanPresentation(
  state: PlanState,
  options: PlanPresentationOptions | PlanPresentationView = {},
): string {
  const view = typeof options === "string" ? options : options.view ?? "summary";
  return view === "technical" ? renderTechnicalView(state) : renderSummaryView(state);
}

export function renderPlanRevisionPresentation(
  state: PlanState,
  revision: PlanRevisionPresentationContext,
  options: PlanPresentationOptions | PlanPresentationView = {},
): string {
  const view = typeof options === "string" ? options : options.view ?? "summary";
  const base = renderPlanPresentation(state, view);
  return view === "technical"
    ? `${base}\n\n${renderRevisionTechnical(revision, state)}`
    : insertBeforeNextAction(base, renderRevisionSummary(revision));
}

function renderRevisionSummary(revision: PlanRevisionPresentationContext): string {
  const progress = revision.progress;
  const delta = revision.delta;
  return [
    "## Progreso preservado",
    `- Completadas: ${progress.succeeded}; listas: ${progress.ready}; esperando: ${progress.waiting}; bloqueadas: ${progress.blocked}.`,
    `- En curso: ${progress.inFlight}; con fallo técnico pendiente: ${progress.failed}; total: ${progress.total}.`,
    "- El trabajo independiente ya confirmado se mantiene; los bloqueos y permisos pendientes no se trasladan a la revisión nueva.",
    ...(revision.actions && revision.actions.length > 0
      ? ["", "## Estado por acción", ...revision.actions.map(actionStateLine)]
      : []),
    "",
    "## Cambios de esta revisión",
    `- Preservadas: ${delta.preserved.length}.`,
    `- Cambiadas: ${delta.changed.length}.`,
    `- Añadidas: ${delta.added.length}.`,
    `- Retiradas: ${delta.removed.length}.`,
    `- Alcance o presentación firmada: ${delta.planChanged ? "actualizada" : "sin cambios adicionales"}.`,
    `- Punto de reanudación: ${revisionResumePoint(progress, delta)}.`,
  ].join("\n");
}

function renderRevisionTechnical(
  revision: PlanRevisionPresentationContext,
  state: PlanState,
): string {
  const progress = revision.progress;
  const delta = revision.delta;
  return [
    "## Recuperación incremental",
    "### Lineage",
    `- Revisión padre: ${revision.parentRevision}`,
    `- Revisión candidata: ${state.revision}`,
    `- Digest candidato: ${state.digest}`,
    "",
    "### Progreso del checkpoint padre",
    `- Total: ${progress.total}`,
    `- Completadas: ${progress.succeeded}`,
    `- Listas: ${progress.ready}`,
    `- Esperando: ${progress.waiting}`,
    `- Bloqueadas: ${progress.blocked}`,
    `- En curso: ${progress.inFlight}`,
    `- Fallidas: ${progress.failed}`,
    ...(revision.actions && revision.actions.length > 0
      ? ["", "### Estado por acción", ...revision.actions.map(actionStateLine)]
      : []),
    "",
    "### Delta firmado",
    ...revisionDeltaTechnicalLines("Preservadas", delta.preserved),
    ...revisionDeltaTechnicalLines("Cambiadas", delta.changed),
    ...revisionDeltaTechnicalLines("Añadidas", delta.added),
    ...revisionDeltaTechnicalLines("Retiradas", delta.removed),
    `- Alcance o presentación firmada: ${delta.planChanged ? "actualizada" : "sin cambios adicionales"}`,
  ].join("\n");
}

function actionStateLine(action: PlanActionStatePresentation): string {
  return `- ${action.key}: ${action.state}${action.dependsOn.length > 0 ? ` (depende de: ${action.dependsOn.join(", ")})` : ""}`;
}

function revisionDeltaTechnicalLines(label: string, actionIDs: readonly string[]): string[] {
  return actionIDs.length > 0
    ? [`- ${label}:`, ...actionIDs.map((actionID) => `  - ${actionID}`)]
    : [`- ${label}: ninguna`];
}

function revisionResumePoint(
  progress: PlanExecutionProgressPresentation,
  delta: PlanRevisionDeltaPresentation,
): string {
  if (progress.inFlight > 0) return "las llamadas en curso se reinician y vuelven a cruzar sus controles";
  if (progress.blocked > 0 || progress.failed > 0) {
    return "se conservan solo los éxitos idénticos y se reintentan las ramas cambiadas tras la aprobación";
  }
  if (delta.changed.length > 0 || delta.added.length > 0) {
    return "continúa después de los éxitos idénticos y comienza las acciones cambiadas o añadidas";
  }
  return "continúa desde el último éxito verificable";
}

function insertBeforeNextAction(base: string, section: string): string {
  const marker = "\n## Qué debes hacer ahora\n";
  const index = base.indexOf(marker);
  if (index < 0) return `${base}\n\n${section}`;
  return `${base.slice(0, index)}\n\n${section}${base.slice(index)}`;
}

function renderSummaryView(state: PlanState): string {
  if (planLevel(state) === 0) return renderLevelZeroSummary(state);
  const presentation = state.plan.presentation;
  const critical = requiresReinforcedControls(presentation.risk);
  const lines = [
    planSummaryHeading(state),
    `Estado: ${phaseStatus(state)}`,
    "",
    "## Objetivo",
    safeText(presentation.objective),
    "",
    "## Al terminar",
    safeText(presentation.outcome),
  ];

  if (presentation.steps.length > 0) {
    lines.push(
      "",
      "## Ruta",
      ...presentation.steps.map((step, index) =>
        `${index + 1}. ${safeText(step.title)} — ${safeText(step.description)}`),
    );
  }
  if (state.plan.actions.length > 0) {
    lines.push(
      "",
      "## Acciones",
      ...state.plan.actions.map(({ action, key, dependsOn }) =>
        `- ${key ?? "sin-clave"}: ${action}${dependsOn && dependsOn.length > 0 ? ` (depende de: ${dependsOn.join(", ")})` : " (sin dependencias)"}`),
    );
  }
  if (presentation.impact.length > 0) {
    lines.push("", "## Impacto", ...impactLines(presentation.impact));
  }
  lines.push(
    "",
    "## Riesgo",
    `- **Nivel:** ${riskLevelLabel(presentation.risk.level)}`,
    `- ${safeText(presentation.risk.summary)}`,
  );
  if (critical) lines.push("", ...reinforcedControlLines(presentation.risk));
  lines.push(
    "",
    "## Qué debes hacer ahora",
    nextAction(state),
    "",
    "Si necesitas revisar rutas, comandos, criterios o la identidad firmada, usa `/malahor-plan detalles`.",
  );
  return lines.join("\n");
}

function renderLevelZeroSummary(state: PlanState): string {
  const presentation = state.plan.presentation;
  const lines = [
    planSummaryHeading(state),
    `Estado: ${phaseStatus(state)}`,
    "",
    "## Cambio",
    safeText(presentation.objective),
    "",
    "## Resultado",
    safeText(presentation.outcome),
    "",
    "## Riesgo",
    `- **Nivel:** ${riskLevelLabel(presentation.risk.level)}`,
    `- ${safeText(presentation.risk.summary)}`,
    "",
    "## Qué debes hacer ahora",
    nextAction(state),
    "",
    "Si necesitas revisar las rutas, comandos o la identidad firmada, usa `/malahor-plan detalles`.",
  ];
  return lines.join("\n");
}

function renderTechnicalView(state: PlanState): string {
  return [
    planIdentity(state),
    `Estado: ${phaseStatus(state)}`,
    "",
    "## Detalle técnico",
    ...technicalBody(state),
  ].join("\n");
}

function technicalBody(state: PlanState): string[] {
  const presentation = state.plan.presentation;
  const lines = [
    "### Riesgo y control",
    `- Nivel de trabajo: ${planLevel(state)}`,
    `- Contrato de autorización: V${state.version}`,
    `- Nivel: ${riskLevelLabel(presentation.risk.level)}`,
  ];
  if (state.version === 5) {
    lines.push(`- Canonicalizador: ${state.canonicalizerVersion}`);
  } else if (!["completed", "revoked", "superseded"].includes(state.phase)) {
    lines.push("- Compatibilidad: este V4 activo no puede ejecutarse; requiere una revisión V5 visible.");
  }
  if (presentation.risk.categories.length > 0) {
    lines.push(`- Categorías críticas: ${presentation.risk.categories.join(", ")}`);
  }
  lines.push(
    `- Resumen: ${safeText(presentation.risk.summary)}`,
    `- Detalles: ${safeText(presentation.risk.details)}`,
  );

  if (planLevel(state) === 0 && presentation.steps.length > 0) {
    lines.push(
      "",
      "### Ruta firmada",
      ...presentation.steps.map((step, index) =>
        `${index + 1}. ${safeText(step.title)} — ${safeText(step.description)}`),
    );
  }
  if (planLevel(state) === 0 && presentation.impact.length > 0) {
    lines.push("", "### Impacto firmado", ...impactLines(presentation.impact));
  }

  lines.push(
    "",
    "### Criterios de cierre",
    ...presentation.completionCriteria.map((item) => `- ${safeText(item)}`),
  );
  if (presentation.exclusions.length > 0) {
    lines.push("", "### Exclusiones", ...presentation.exclusions.map((item) => `- ${safeText(item)}`));
  }
  if (state.plan.dependencies.length > 0) {
    lines.push(
      "",
      "### Dependencias",
      ...state.plan.dependencies.map(({ planID, revision }) => `- ${planID}@${revision}`),
    );
  }
  if (state.plan.actions.length > 0) {
    lines.push(
      "",
      "### Acciones exactas",
      ...state.plan.actions.map(({ action, resource, key, dependsOn }) =>
        `- ${action}: ${safeJson(resource)} (clave: ${key ?? "sin-clave"}${dependsOn && dependsOn.length > 0 ? `; depende de: ${dependsOn.join(", ")}` : "; sin dependencias"})`),
    );
  }
  if (state.version === 5 && state.actionIntents.length > 0) {
    lines.push(
      "",
      "### Intents firmados",
      ...state.actionIntents.map((intent, index) => `- ${index + 1}. ${intent.kind}: ${intent.actionID}`),
    );
  }
  lines.push(
    "",
    "### Autorización",
    ...approvalLines(state),
    "",
    "### Identidad firmada",
    `- Plan: ${state.planID}`,
    `- Revisión: ${state.revision}`,
    `- Digest: ${state.digest}`,
    "",
    "### Vigencia",
    "- Sin caducidad temporal; cambia solo por revisión, estado, proyecto, modo o política.",
  );
  return lines;
}

function impactLines(impact: PlanPresentationImpact[]): string[] {
  const groups = new Map<string, string[]>();
  for (const item of impact) groups.set(item.area, [...(groups.get(item.area) ?? []), item.description]);
  return [...groups].map(([area, descriptions]) =>
    `- **${safeText(area)}:** ${descriptions.map(safeText).join(" ")}`);
}

function approvalLines(state: PlanState): string[] {
  if (["completed", "revoked", "superseded"].includes(state.phase)) {
    return [`- No hay aprobación pendiente; el plan está ${phaseLabel(state.phase)}.`];
  }
  if (state.mode === "advisor") return ["- No requiere aprobación: el modo asesor no ejecuta acciones."];
  if (["running", "paused", "blocked"].includes(state.phase)) {
    return ["- La ejecución ya fue autorizada para esta revisión y únicamente para sus acciones exactas."];
  }
  if (state.mode === "executor") {
    return ["- Requiere aprobación previa en un turno posterior antes de ejecutar las acciones exactas."];
  }
  if (state.phase === "presented") {
    return [
      "- Primera confirmación: revisar este plan; no autoriza la ejecución.",
      "- Segunda confirmación: en un turno posterior, autorizar únicamente sus acciones exactas.",
    ];
  }
  return [
    "- Primera confirmación completada: el plan fue revisado sin autorizar su ejecución.",
    "- Falta la segunda confirmación para ejecutar únicamente sus acciones exactas.",
  ];
}

function nextAction(state: PlanState): string {
  if (state.version === 4 && !["completed", "revoked", "superseded"].includes(state.phase)) {
    return "No ejecutes esta revisión: usa un contrato V4 legado. Puedes consultarla o revocarla; para continuar presenta una revisión V5 equivalente y vuelve a aprobarla.";
  }
  if (state.phase === "completed") {
    return "No tienes que hacer nada más: el trabajo de este plan terminó. Si necesitas otro cambio, solicítalo como una tarea nueva.";
  }
  if (state.phase === "revoked") {
    return "Este plan fue cancelado y ya no puede ejecutarse. Si todavía necesitas el cambio, pide un plan nuevo con el alcance actualizado.";
  }
  if (state.phase === "superseded") {
    return "No apruebes ni ejecutes esta versión: fue reemplazada por una revisión posterior. Revisa únicamente el plan más reciente.";
  }
  if (state.phase === "paused") {
    return "La ejecución está detenida. Cuando quieras continuar exactamente con este alcance, solicita reanudar el plan; cualquier cambio requiere una revisión nueva.";
  }
  if (state.phase === "blocked") {
    return "El plan no puede continuar porque aún tiene dependencias pendientes. Resuélvelas y solicita reanudarlo; Malahor nunca lo iniciará automáticamente.";
  }
  if (state.phase === "running") {
    return "El plan ya está aprobado. Malahor puede continuar únicamente con el alcance firmado; no necesitas responder salvo que quieras pausarlo o cambiarlo.";
  }
  if (state.mode === "advisor") {
    return "Revisa la recomendación y decide si quieres convertirla en una tarea ejecutable. En modo asesor no se realizan cambios.";
  }
  if (state.mode === "assistant" && state.phase === "presented") {
    return "Revisa el alcance y completa la primera confirmación. Ese paso solo registra que lo has revisado: no inicia cambios. Después podrás responder `go` en un turno nuevo para pedir la autorización de ejecución.";
  }
  if (state.mode === "assistant") {
    return "Si el plan te parece correcto, responde `go` o `implementa` en un turno nuevo. Malahor abrirá la segunda confirmación y, si la aceptas, ejecutará únicamente este alcance.";
  }
  return "Si el alcance te parece correcto, responde `go` o `implementa` en un turno nuevo. Malahor pedirá la aprobación de esta revisión y, si se concede, ejecutará únicamente lo descrito; esa respuesta no autoriza operaciones adicionales ni evita otros guardrails.";
}

function planSummaryHeading(state: PlanState): string {
  return `Plan de trabajo Malahor · nivel ${planLevel(state)}`;
}

function planIdentity(state: PlanState): string {
  return `Plan Malahor (${state.mode} · nivel ${planLevel(state)}) · ${state.planID.slice(0, 12)} · revisión ${state.revision.slice(0, 12)}`;
}

function phaseStatus(state: PlanState): string {
  if (state.version === 4 && !["completed", "revoked", "superseded"].includes(state.phase)) {
    return "bloqueado: requiere revisión V5";
  }
  if (state.phase === "presented") {
    return state.mode === "assistant" ? "esperando tu revisión" : state.mode === "executor"
      ? "esperando tu aprobación" : "presentado para consulta";
  }
  if (state.phase === "reviewed") return "revisado; esperando autorización para ejecutar";
  if (state.phase === "running") return "aprobado y en ejecución";
  if (state.phase === "paused") return "en pausa";
  if (state.phase === "blocked") return "bloqueado por dependencias";
  if (state.phase === "completed") return "completado";
  if (state.phase === "revoked") return "cancelado";
  return "reemplazado por otra revisión";
}

function planLevel(state: PlanState): PlanLevel {
  return state.plan.level === 0 || state.plan.level === 2 ? state.plan.level : 1;
}

function phaseLabel(phase: PlanState["phase"]): string {
  if (phase === "completed") return "completado";
  if (phase === "revoked") return "revocado";
  return "reemplazado";
}

function riskLevelLabel(level: PlanRiskLevel): string {
  if (level === "low") return "bajo";
  if (level === "medium") return "medio";
  return "alto";
}

function requiresReinforcedControls(risk: PlanPresentationRisk): boolean {
  return risk.level === "high" || risk.categories.length > 0;
}

function reinforcedControlLines(risk: PlanPresentationRisk): string[] {
  const lines = [
    "## Controles reforzados",
    `- ${safeText(risk.details)}`,
  ];
  if (risk.categories.length > 0) {
    lines.push(`- **Áreas sensibles:** ${risk.categories.map(riskCategoryLabel).join(", ")}.`);
  }
  lines.push("- La ejecución se detendrá si cambia el alcance o falla un guardrail obligatorio.");
  return lines;
}

function riskCategoryLabel(category: PlanRiskCategory): string {
  if (category === "security") return "seguridad";
  if (category === "data") return "datos";
  if (category === "architecture") return "arquitectura";
  return "destrucción";
}

function safeJson(value: string): string {
  return JSON.stringify(value).replace(/[<>&`]/gu, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

function safeText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function normalizedSteps(value: unknown): PlanPresentationStep[] {
  if (!Array.isArray(value) || value.length > MAX_STEPS) {
    throw new Error("Pasos de presentacion invalidos o demasiado extensos.");
  }
  return value.map((step) => {
    if (!isRecord(step)) throw new Error("Paso de presentacion invalido.");
    return {
      title: normalizedText(step.title, "titulo de paso", 160),
      description: normalizedText(step.description, "descripcion de paso", 500),
    };
  });
}

function normalizedImpact(value: unknown): PlanPresentationImpact[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new Error("Lista de impacto invalida o demasiado extensa.");
  }
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("Elemento de impacto invalido.");
    return {
      area: normalizedText(item.area, "area de impacto", 120),
      description: normalizedText(item.description, "descripcion de impacto", 500),
    };
  });
}

function normalizedRisk(value: unknown): PlanPresentationRisk {
  if (!isRecord(value)) throw new Error("Riesgo de presentacion invalido.");
  if (typeof value.level !== "string" || !RISK_LEVELS.has(value.level as PlanRiskLevel)) {
    throw new Error("Nivel de riesgo invalido.");
  }
  if (!Array.isArray(value.categories) || value.categories.length > RISK_CATEGORIES.size) {
    throw new Error("Categorias de riesgo invalidas.");
  }
  const categories = value.categories.map((category) => {
    if (typeof category !== "string" || !RISK_CATEGORIES.has(category as PlanRiskCategory)) {
      throw new Error("Categoria de riesgo invalida.");
    }
    return category as PlanRiskCategory;
  });
  if (new Set(categories).size !== categories.length) throw new Error("Categorias de riesgo duplicadas.");
  return {
    level: value.level as PlanRiskLevel,
    categories,
    summary: normalizedText(value.summary, "resumen de riesgo", 500),
    details: normalizedText(value.details, "detalles de riesgo", 1_500),
  };
}

function normalizedList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new Error(`Lista de ${label} invalida o demasiado extensa.`);
  }
  return value.map((item) => normalizedText(item, label, 1_000));
}

function normalizedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`Campo de ${label} invalido.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > max) throw new Error(`Campo de ${label} invalido o demasiado extenso.`);
  return normalized;
}

function samePresentation(value: Record<string, unknown>, normalized: PlanPresentationInput): boolean {
  if (!hasExactKeys(value, [
    "objective", "outcome", "steps", "impact", "risk", "exclusions", "completionCriteria",
  ])) return false;
  return value.objective === normalized.objective
    && value.outcome === normalized.outcome
    && sameSteps(value.steps, normalized.steps)
    && sameImpact(value.impact, normalized.impact)
    && sameRisk(value.risk, normalized.risk)
    && sameStrings(value.exclusions, normalized.exclusions)
    && sameStrings(value.completionCriteria, normalized.completionCriteria);
}

function sameSteps(value: unknown, normalized: PlanPresentationStep[]): boolean {
  return Array.isArray(value) && value.length === normalized.length && value.every((step, index) => {
    if (!isRecord(step) || !hasExactKeys(step, ["title", "description"])) return false;
    const expected = normalized[index]!;
    return step.title === expected.title && step.description === expected.description;
  });
}

function sameImpact(value: unknown, normalized: PlanPresentationImpact[]): boolean {
  return Array.isArray(value) && value.length === normalized.length && value.every((item, index) => {
    if (!isRecord(item) || !hasExactKeys(item, ["area", "description"])) return false;
    const expected = normalized[index]!;
    return item.area === expected.area && item.description === expected.description;
  });
}

function sameRisk(value: unknown, normalized: PlanPresentationRisk): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["level", "categories", "summary", "details"])) return false;
  return value.level === normalized.level
    && sameStrings(value.categories, normalized.categories)
    && value.summary === normalized.summary
    && value.details === normalized.details;
}

function sameStrings(value: unknown, normalized: readonly string[]): boolean {
  return Array.isArray(value) && value.length === normalized.length
    && value.every((item, index) => item === normalized[index]);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
