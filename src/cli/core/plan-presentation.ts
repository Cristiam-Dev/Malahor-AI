import type { MalahorMode } from "./config";
import type { PlanState } from "./planning";

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
  } else {
    if (steps.length === 0) throw new Error("La presentacion del plan requiere una ruta con pasos breves.");
    if (impact.length === 0) throw new Error("La presentacion debe declarar su impacto por area.");
  }
  if (completionCriteria.length === 0) {
    throw new Error("La presentacion debe declarar criterios de finalizacion.");
  }

  return { objective, outcome, steps, impact, risk, exclusions, completionCriteria };
}

export function validPlanPresentation(value: unknown, mode: MalahorMode): value is PlanPresentationInput {
  try {
    if (!isRecord(value)) return false;
    return samePresentation(value, normalizePlanPresentation(value, mode));
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
  const presentation = state.plan.presentation;
  const critical = requiresVisibleDetails(presentation.risk);
  const lines = [
    planIdentity(state),
    `Estado: ${state.phase}`,
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
    "",
    "## Acción requerida",
    nextAction(state),
    "",
    critical
      ? "Los detalles críticos están abiertos por defecto. También puedes consultarlos con `/malahor-plan detalles`."
      : "Despliega el anexo técnico cuando necesites rutas, comandos o evidencias exactas. Si tu cliente no lo muestra, usa `/malahor-plan detalles`.",
    "",
    `<details${critical ? " open" : ""}>`,
    "<summary>Ver detalle técnico</summary>",
    "",
    ...technicalBody(state),
    "",
    "</details>",
    "",
    "Vigencia: sin caducidad temporal; cambia solo por revisión, estado, proyecto, modo o política.",
  );
  return lines.join("\n");
}

function renderTechnicalView(state: PlanState): string {
  return [
    planIdentity(state),
    `Estado: ${state.phase}`,
    "",
    "## Detalle técnico",
    ...technicalBody(state),
    "",
    "Vigencia: sin caducidad temporal; cambia solo por revisión, estado, proyecto, modo o política.",
  ].join("\n");
}

function technicalBody(state: PlanState): string[] {
  const presentation = state.plan.presentation;
  const lines = [
    "### Riesgo y control",
    `- Nivel: ${riskLevelLabel(presentation.risk.level)}`,
  ];
  if (presentation.risk.categories.length > 0) {
    lines.push(`- Categorías críticas: ${presentation.risk.categories.join(", ")}`);
  }
  lines.push(
    `- Resumen: ${safeText(presentation.risk.summary)}`,
    `- Detalles: ${safeText(presentation.risk.details)}`,
  );

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
  if (state.phase === "completed") return "Plan terminado; no hay ninguna acción pendiente.";
  if (state.phase === "revoked") return "Plan revocado; no hay ninguna acción ejecutable.";
  if (state.phase === "superseded") return "Plan reemplazado por una revisión posterior; no lo ejecutes.";
  if (state.phase === "paused") return "Solicita reanudar este mismo plan cuando corresponda.";
  if (state.phase === "blocked") return "Resuelve sus dependencias y solicita reanudarlo; nunca arrancará automáticamente.";
  if (state.phase === "running") return "Continúa únicamente con las acciones exactas autorizadas y conserva los demás guardrails.";
  if (state.mode === "advisor") return "Revisa el concepto; el modo asesor no ejecuta cambios.";
  if (state.mode === "assistant" && state.phase === "presented") {
    return "Completa la primera confirmación para revisar el plan; esta confirmación no autoriza la ejecución.";
  }
  if (state.mode === "assistant") {
    return "En un turno posterior, responde `go` o `implementa` para solicitar la segunda confirmación.";
  }
  return "En un turno posterior, responde `go` o `implementa` para solicitar la aprobación previa.";
}

function planIdentity(state: PlanState): string {
  return `Plan Malahor (${state.mode}) · ${state.planID.slice(0, 12)} · revisión ${state.revision.slice(0, 12)}`;
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

function requiresVisibleDetails(risk: PlanPresentationRisk): boolean {
  return risk.level === "high" || risk.categories.length > 0;
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
