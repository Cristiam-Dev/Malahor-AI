import type { MalahorMode } from "./config";
import type { PlanState } from "./planning";

export interface PlanPresentationStep {
  title: string;
  what: string;
  why: string;
  expected: string;
}

export interface PlanPresentationInput {
  objective: string;
  rationale: string;
  steps: PlanPresentationStep[];
  changes: string[];
  exclusions: string[];
  completionCriteria: string[];
}

const MAX_STEPS = 30;
const MAX_ITEMS = 30;

export function normalizePlanPresentation(
  value: unknown,
  mode: MalahorMode,
): PlanPresentationInput {
  if (!isRecord(value)) throw new Error("El plan necesita una presentacion humana estructurada.");

  const objective = normalizedText(value.objective, "objetivo", 1_000);
  const rationale = normalizedText(value.rationale, "motivo", 2_000);
  const steps = normalizedSteps(value.steps);
  const changes = normalizedList(value.changes, "cambios");
  const exclusions = normalizedList(value.exclusions, "exclusiones");
  const completionCriteria = normalizedList(value.completionCriteria, "criterios de finalizacion");

  if (mode === "advisor") {
    if (steps.length !== 0 || changes.length !== 0) {
      throw new Error("Asesor solo presenta concepto: sin pasos ni cambios ejecutables.");
    }
  } else if (steps.length === 0) {
    throw new Error("La presentacion del plan requiere pasos explicados.");
  }
  if (exclusions.length === 0) {
    throw new Error("La presentacion debe declarar que queda fuera del alcance.");
  }
  if (completionCriteria.length === 0) {
    throw new Error("La presentacion debe declarar criterios de finalizacion.");
  }
  if (mode !== "advisor" && changes.length === 0) {
    throw new Error("La presentacion debe declarar que cambiara.");
  }

  return { objective, rationale, steps, changes, exclusions, completionCriteria };
}

export function validPlanPresentation(value: unknown, mode: MalahorMode): value is PlanPresentationInput {
  try {
    if (!isRecord(value)) return false;
    return samePresentation(value, normalizePlanPresentation(value, mode));
  } catch {
    return false;
  }
}

export function renderPlanPresentation(state: PlanState): string {
  const presentation = state.plan.presentation;
  const dependencies = state.plan.dependencies.length > 0
    ? state.plan.dependencies.map(({ planID, revision }) => `- ${planID}@${revision}`)
    : ["- Ninguna."];
  const actions = state.plan.actions.length > 0
    ? state.plan.actions.map(({ action, resource }) => `- ${action}: ${JSON.stringify(resource)}`)
    : ["- Ninguna acción ejecutable."];
  const steps = presentation.steps.length > 0
    ? presentation.steps.flatMap((step, index) => [
      `### ${index + 1}. ${step.title}`,
      `- **Qué:** ${step.what}`,
      `- **Por qué:** ${step.why}`,
      `- **Resultado esperado:** ${step.expected}`,
    ])
    : ["- Sin pasos ejecutables."];

  return [
    `Plan Malahor (${state.mode}) · ${state.planID.slice(0, 12)} · revisión ${state.revision.slice(0, 12)}`,
    `Estado: ${state.phase}`,
    "",
    "## Qué haremos",
    presentation.objective,
    "",
    "## Por qué",
    presentation.rationale,
    "",
    "## Pasos",
    ...steps,
    "",
    "## Qué cambiará",
    ...listOrNone(presentation.changes),
    "",
    "## Qué no cambiará",
    ...listOrNone(presentation.exclusions),
    "",
    "## Aprobaciones",
    ...approvalLines(state),
    "",
    "## Cómo sabremos que terminó",
    ...presentation.completionCriteria.map((item) => `- ${item}`),
    "",
    "## Dependencias",
    ...dependencies,
    "",
    "## Efectos exactos",
    ...actions,
    "",
    "## Siguiente acción",
    nextAction(state),
    "",
    "Vigencia: sin caducidad temporal; cambia solo por revisión, estado, proyecto, modo o política.",
  ].join("\n");
}

function approvalLines(state: PlanState): string[] {
  if (["completed", "revoked", "superseded"].includes(state.phase)) {
    return [`- No hay ninguna aprobación pendiente; el plan está ${phaseLabel(state.phase)}.`];
  }
  if (state.mode === "advisor") {
    return ["- No requiere aprobación: el modo asesor no ejecuta acciones."];
  }
  if (state.phase === "running" || state.phase === "paused" || state.phase === "blocked") {
    return ["- La ejecución ya fue autorizada para esta revisión y únicamente para sus efectos exactos."];
  }
  if (state.mode === "executor") {
    return ["- Requiere una aprobación previa en un turno posterior antes de ejecutar los efectos exactos."];
  }
  if (state.phase === "presented") {
    return [
      "- Primera confirmación: revisar este plan; no autoriza la ejecución.",
      "- Segunda confirmación: en un turno posterior, autorizar únicamente sus efectos exactos.",
    ];
  }
  return [
    "- Primera confirmación completada: el plan fue revisado sin autorizar su ejecución.",
    "- Falta la segunda confirmación para ejecutar únicamente sus efectos exactos.",
  ];
}

function nextAction(state: PlanState): string {
  if (state.phase === "completed") return "Plan terminado; no hay ninguna acción pendiente.";
  if (state.phase === "revoked") return "Plan revocado; no hay ninguna acción ejecutable.";
  if (state.phase === "superseded") return "Plan reemplazado por una revisión posterior; no lo ejecutes.";
  if (state.phase === "paused") return "Solicita reanudar este mismo plan cuando corresponda.";
  if (state.phase === "blocked") return "Resuelve sus dependencias y solicita reanudarlo; nunca arrancará automáticamente.";
  if (state.phase === "running") return "Ejecuta únicamente los efectos exactos declarados y conserva los demás guardrails.";
  if (state.mode === "advisor") return "Ninguna ejecución: presenta el concepto y termina el turno.";
  if (state.mode === "assistant" && state.phase === "presented") {
    return "Completa la primera confirmación de revisión; no ejecutes acciones en este turno.";
  }
  return "Muestra esta presentación completa y termina el turno. En un turno posterior, el usuario puede responder `go` o `implementa` para solicitar la aprobación correspondiente.";
}

function phaseLabel(phase: PlanState["phase"]): string {
  if (phase === "completed") return "completado";
  if (phase === "revoked") return "revocado";
  return "reemplazado";
}

function normalizedSteps(value: unknown): PlanPresentationStep[] {
  if (!Array.isArray(value) || value.length > MAX_STEPS) {
    throw new Error("Pasos de presentacion invalidos o demasiado extensos.");
  }
  return value.map((step) => {
    if (!isRecord(step)) throw new Error("Paso de presentacion invalido.");
    return {
      title: normalizedText(step.title, "titulo de paso", 200),
      what: normalizedText(step.what, "que del paso", 1_200),
      why: normalizedText(step.why, "por que del paso", 1_200),
      expected: normalizedText(step.expected, "resultado esperado", 1_200),
    };
  });
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

function listOrNone(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- Ninguno."];
}

function samePresentation(value: Record<string, unknown>, normalized: PlanPresentationInput): boolean {
  if (!hasExactKeys(value, [
    "objective", "rationale", "steps", "changes", "exclusions", "completionCriteria",
  ])) return false;
  return value.objective === normalized.objective
    && value.rationale === normalized.rationale
    && sameSteps(value.steps, normalized.steps)
    && sameStrings(value.changes, normalized.changes)
    && sameStrings(value.exclusions, normalized.exclusions)
    && sameStrings(value.completionCriteria, normalized.completionCriteria);
}

function sameSteps(value: unknown, normalized: PlanPresentationStep[]): boolean {
  return Array.isArray(value) && value.length === normalized.length && value.every((step, index) => {
    if (!isRecord(step) || !hasExactKeys(step, ["title", "what", "why", "expected"])) return false;
    const expected = normalized[index]!;
    return step.title === expected.title && step.what === expected.what
      && step.why === expected.why && step.expected === expected.expected;
  });
}

function sameStrings(value: unknown, normalized: string[]): boolean {
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
