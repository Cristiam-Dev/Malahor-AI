import { createHash } from "node:crypto";

import { detectPayloadSecretKinds } from "./hooks/secret-scan";

export const TASK_CLASSIFICATION_SCHEMA = 1 as const;
export const TASK_DECISION_SCHEMA = 1 as const;

export type SignalLevel = "low" | "medium" | "high" | "unknown";
export type TaskRouteV1 = "inspect" | "direct" | "recognize" | "diagnose" | "sdd" | "clarify";
export type TaskRequestedEffect = "none" | "mutation" | "unknown";
export type TaskMode = "advisor" | "assistant" | "executor";

export interface TaskSignalsV1 {
  specification: SignalLevel;
  discovery: SignalLevel;
  scope: SignalLevel;
  openDecisions: SignalLevel;
  reversibility: SignalLevel;
  verifiability: SignalLevel;
}

export interface TaskClosureV1 {
  action: "known" | "discoverable" | "unknown";
  targets: "known" | "discoverable" | "unknown";
  verification: "objective" | "judgment" | "unknown";
  discovery: "none" | "bounded-read-only" | "open";
  openDecisionCount: number;
}

export interface TaskProofV1 {
  effect: string;
  targets: string;
  verification: string;
}

export interface TaskAssessmentV1 {
  schema: typeof TASK_CLASSIFICATION_SCHEMA;
  understood: boolean;
  requestedEffect: TaskRequestedEffect;
  userRequestedPlanning: boolean;
  symptomOrCauseUnknown: boolean;
  signals: TaskSignalsV1;
  closure: TaskClosureV1;
  proof: TaskProofV1;
  previousDecisionRef?: string;
}

export interface TaskDecisionV1 {
  schema: typeof TASK_DECISION_SCHEMA;
  route: TaskRouteV1;
  reasonCodes: string[];
  riskGate: "none" | "policy-evaluation-required";
  decisionRef: string;
}

export interface TaskClassificationContext {
  sessionID: string;
  messageID: string;
  project: string;
  root: string;
  mode: TaskMode;
  policyRevision: string;
}

const SIGNAL_LEVELS = new Set<SignalLevel>(["low", "medium", "high", "unknown"]);
const REQUESTED_EFFECTS = new Set<TaskRequestedEffect>(["none", "mutation", "unknown"]);
const CLOSURE_ACTION = new Set<TaskClosureV1["action"]>(["known", "discoverable", "unknown"]);
const CLOSURE_TARGETS = new Set<TaskClosureV1["targets"]>(["known", "discoverable", "unknown"]);
const CLOSURE_VERIFICATION = new Set<TaskClosureV1["verification"]>(["objective", "judgment", "unknown"]);
const CLOSURE_DISCOVERY = new Set<TaskClosureV1["discovery"]>(["none", "bounded-read-only", "open"]);
const PLACEHOLDERS = [
  "lo necesario",
  "los archivos relacionados",
  "el archivo relacionado",
  "mejorarlo",
  "mejorar esto",
  "tbd",
  "todo",
  "pendiente",
  "algo",
  "lo que haga falta",
];
const MAX_TEXT = 2_000;
const MAX_OPEN_DECISIONS = 64;
const MAX_PREVIOUS_REF = 256;

export class TaskClassificationError extends Error {
  readonly code: "TASK_ASSESSMENT_INVALID" | "TASK_DECISION_STALE" | "TASK_ROUTE_MISMATCH";

  constructor(code: TaskClassificationError["code"], message: string) {
    super(message);
    this.name = "TaskClassificationError";
    this.code = code;
  }
}

export function parseTaskAssessment(value: unknown): TaskAssessmentV1 {
  const record = exactRecord(value, [
    "schema", "understood", "requestedEffect", "userRequestedPlanning", "symptomOrCauseUnknown",
    "signals", "closure", "proof", "previousDecisionRef",
  ], "Evaluación de tarea inválida.");
  if (record.schema !== TASK_CLASSIFICATION_SCHEMA) {
    throw invalid("La versión de la evaluación de tarea no es válida.");
  }
  if (typeof record.understood !== "boolean" || typeof record.userRequestedPlanning !== "boolean"
    || typeof record.symptomOrCauseUnknown !== "boolean") {
    throw invalid("Los indicadores de comprensión de la tarea no son válidos.");
  }
  if (typeof record.requestedEffect !== "string"
    || !REQUESTED_EFFECTS.has(record.requestedEffect as TaskRequestedEffect)) {
    throw invalid("El efecto solicitado no es válido.");
  }
  const signals = parseSignals(record.signals);
  const closure = parseClosure(record.closure);
  const proof = parseProof(record.proof, record.understood === true);
  const previousDecisionRef = optionalText(record.previousDecisionRef, MAX_PREVIOUS_REF, "previousDecisionRef");
  if (previousDecisionRef !== undefined && !/^[a-f0-9]{64}$/.test(previousDecisionRef)) {
    throw invalid("previousDecisionRef no es un digest válido.");
  }
  const assessment: TaskAssessmentV1 = {
    schema: TASK_CLASSIFICATION_SCHEMA,
    understood: record.understood,
    requestedEffect: record.requestedEffect as TaskRequestedEffect,
    userRequestedPlanning: record.userRequestedPlanning,
    symptomOrCauseUnknown: record.symptomOrCauseUnknown,
    signals,
    closure,
    proof,
    ...(previousDecisionRef ? { previousDecisionRef } : {}),
  };
  const serialized = JSON.stringify(assessment);
  if (detectPayloadSecretKinds(serialized).length > 0) {
    throw invalid("La evaluación de tarea contiene material sensible.");
  }
  return assessment;
}

export function deriveTaskDecision(
  assessment: TaskAssessmentV1,
  context: TaskClassificationContext,
): TaskDecisionV1 {
  const reasonCodes: string[] = [];
  let route: TaskRouteV1;

  if (!assessment.understood) {
    route = "clarify";
    reasonCodes.push("not-understood");
  } else if (assessment.userRequestedPlanning) {
    route = "sdd";
    reasonCodes.push("user-requested-planning");
  } else if (assessment.requestedEffect === "none" && !assessment.symptomOrCauseUnknown) {
    route = "inspect";
    reasonCodes.push("no-effect");
  } else if (assessment.symptomOrCauseUnknown) {
    route = "diagnose";
    reasonCodes.push("cause-unknown");
  } else if (assessment.closure.openDecisionCount > 0
    || assessment.closure.action === "unknown"
    || assessment.closure.targets === "unknown"
    || assessment.closure.verification !== "objective"
    || assessment.closure.discovery === "open") {
    route = "sdd";
    reasonCodes.push(
      assessment.closure.openDecisionCount > 0 ? "open-decisions" : "closure-incomplete",
      ...(assessment.closure.action === "unknown" ? ["unknown-action"] : []),
      ...(assessment.closure.targets === "unknown" ? ["unknown-targets"] : []),
      ...(assessment.closure.verification !== "objective" ? ["non-objective-verification"] : []),
      ...(assessment.closure.discovery === "open" ? ["open-discovery"] : []),
    );
  } else if (assessment.closure.discovery === "bounded-read-only"
    || assessment.closure.action === "discoverable"
    || assessment.closure.targets === "discoverable") {
    route = "recognize";
    reasonCodes.push("bounded-discovery");
  } else {
    route = "direct";
    reasonCodes.push("closed-direct");
  }

  const riskGate = assessment.signals.reversibility === "high" || assessment.signals.scope === "high"
    ? "policy-evaluation-required" as const
    : "none" as const;
  if (riskGate !== "none") reasonCodes.push("risk-gate");

  const decision: Omit<TaskDecisionV1, "decisionRef"> = {
    schema: TASK_DECISION_SCHEMA,
    route,
    reasonCodes: [...new Set(reasonCodes)],
    riskGate,
  };
  return {
    ...decision,
    decisionRef: sha256(JSON.stringify({
      schema: TASK_CLASSIFICATION_SCHEMA,
      context: normalizeContext(context),
      assessment: normalizeAssessment(assessment),
      decision,
    })),
  };
}

export function isTaskRoute(value: unknown): value is TaskRouteV1 {
  return value === "inspect" || value === "direct" || value === "recognize"
    || value === "diagnose" || value === "sdd" || value === "clarify";
}

export function taskRouteLabel(route: TaskRouteV1): string {
  switch (route) {
    case "inspect": return "inspección";
    case "direct": return "ejecución directa";
    case "recognize": return "reconocimiento";
    case "diagnose": return "diagnóstico";
    case "sdd": return "especificación y plan";
    case "clarify": return "aclaración";
  }
}

function parseSignals(value: unknown): TaskSignalsV1 {
  const record = exactRecord(value, [
    "specification", "discovery", "scope", "openDecisions", "reversibility", "verifiability",
  ], "Las señales de tarea son inválidas.");
  const keys = ["specification", "discovery", "scope", "openDecisions", "reversibility", "verifiability"] as const;
  for (const key of keys) {
    if (typeof record[key] !== "string" || !SIGNAL_LEVELS.has(record[key] as SignalLevel)) {
      throw invalid(`La señal ${key} no es válida.`);
    }
  }
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as TaskSignalsV1;
}

function parseClosure(value: unknown): TaskClosureV1 {
  const record = exactRecord(value, [
    "action", "targets", "verification", "discovery", "openDecisionCount",
  ], "El cierre de tarea es inválido.");
  if (typeof record.action !== "string" || !CLOSURE_ACTION.has(record.action as TaskClosureV1["action"])
    || typeof record.targets !== "string" || !CLOSURE_TARGETS.has(record.targets as TaskClosureV1["targets"])
    || typeof record.verification !== "string"
    || !CLOSURE_VERIFICATION.has(record.verification as TaskClosureV1["verification"])
    || typeof record.discovery !== "string"
    || !CLOSURE_DISCOVERY.has(record.discovery as TaskClosureV1["discovery"])
    || !Number.isSafeInteger(record.openDecisionCount)
    || (record.openDecisionCount as number) < 0
    || (record.openDecisionCount as number) > MAX_OPEN_DECISIONS) {
    throw invalid("El cierre de tarea no cumple el contrato cerrado.");
  }
  return {
    action: record.action as TaskClosureV1["action"],
    targets: record.targets as TaskClosureV1["targets"],
    verification: record.verification as TaskClosureV1["verification"],
    discovery: record.discovery as TaskClosureV1["discovery"],
    openDecisionCount: record.openDecisionCount as number,
  };
}

function parseProof(value: unknown, requireContent: boolean): TaskProofV1 {
  const record = exactRecord(value, ["effect", "targets", "verification"], "La prueba de cierre es inválida.");
  return {
    effect: proofText(record.effect, "effect", requireContent),
    targets: proofText(record.targets, "targets", requireContent),
    verification: proofText(record.verification, "verification", requireContent),
  };
}

function proofText(value: unknown, field: string, requireContent: boolean): string {
  if (typeof value !== "string" || value.length > MAX_TEXT || /[\u0000\r\n]/.test(value)) {
    throw invalid(`La prueba de cierre (${field}) no es válida.`);
  }
  const trimmed = value.trim();
  if (requireContent && !trimmed) throw invalid(`La prueba de cierre (${field}) está vacía.`);
  const normalized = trimmed.toLocaleLowerCase("es");
  if (PLACEHOLDERS.some((placeholder) => normalized === placeholder
    || normalized.includes(` ${placeholder} `) || normalized.startsWith(`${placeholder} `)
    || normalized.endsWith(` ${placeholder}`))) {
    throw invalid(`La prueba de cierre (${field}) contiene un placeholder.`);
  }
  return trimmed;
}

function optionalText(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max || /[\u0000\r\n]/.test(value)) {
    throw invalid(`${field} no es válido.`);
  }
  return value.trim() || undefined;
}

function normalizeContext(context: TaskClassificationContext): Record<string, string> {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    project: context.project,
    root: context.root,
    mode: context.mode,
    policyRevision: context.policyRevision,
  };
}

function normalizeAssessment(assessment: TaskAssessmentV1): TaskAssessmentV1 {
  return {
    schema: assessment.schema,
    understood: assessment.understood,
    requestedEffect: assessment.requestedEffect,
    userRequestedPlanning: assessment.userRequestedPlanning,
    symptomOrCauseUnknown: assessment.symptomOrCauseUnknown,
    signals: { ...assessment.signals },
    closure: { ...assessment.closure },
    proof: { ...assessment.proof },
    ...(assessment.previousDecisionRef ? { previousDecisionRef: assessment.previousDecisionRef } : {}),
  };
}

function exactRecord(value: unknown, keys: string[], message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(message);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))
    || keys.filter((key) => key !== "previousDecisionRef").some((key) => !(key in record))) {
    throw invalid(message);
  }
  return record;
}

function invalid(message: string): TaskClassificationError {
  return new TaskClassificationError("TASK_ASSESSMENT_INVALID", message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
