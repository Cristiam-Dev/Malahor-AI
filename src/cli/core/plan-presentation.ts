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
    `- Nivel: ${riskLevelLabel(presentation.risk.level)}`,
  ];
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
      ...state.plan.actions.map(({ action, resource }) => `- ${action}: ${safeJson(resource)}`),
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
