import {
  TaskClassificationError,
  deriveTaskDecision,
  parseTaskAssessment,
  type TaskClassificationContext,
  type TaskDecisionV1,
  type TaskMode,
  type TaskRouteV1,
} from "../cli/core/task-classification";

export interface TaskClassificationScope {
  sessionID: string;
  project: string;
  policyRevision: string;
  mode: TaskMode;
  root: string;
}

export interface TaskClassificationCall {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
}

export interface TaskClassificationRecord {
  decision: TaskDecisionV1;
  scope: TaskClassificationScope;
  messageID: string;
}

export interface TaskClassifier {
  classify(value: unknown, scope: TaskClassificationScope, call: TaskClassificationCall): TaskDecisionV1;
  current(sessionID: string, route?: TaskRouteV1): TaskClassificationRecord | undefined;
  requireRoute(sessionID: string, route: TaskRouteV1, scope: TaskClassificationScope): TaskDecisionV1;
  invalidate(sessionID: string): void;
}

export function createTaskClassifier(): TaskClassifier {
  const decisions = new Map<string, TaskClassificationRecord>();

  return {
    classify(value, scope, call) {
      if (call.agent !== "malahor" || call.sessionID !== scope.sessionID) {
        throw new TaskClassificationError("TASK_ROUTE_MISMATCH", "Solo el primario puede clasificar su propia sesión.");
      }
      const assessment = parseTaskAssessment(value);
      const context: TaskClassificationContext = {
        sessionID: scope.sessionID,
        messageID: call.messageID,
        project: scope.project,
        root: scope.root,
        mode: scope.mode,
        policyRevision: scope.policyRevision,
      };
      const decision = deriveTaskDecision(assessment, context);
      decisions.set(scope.sessionID, {
        decision,
        scope: normalizeScope(scope),
        messageID: call.messageID,
      });
      return decision;
    },

    current(sessionID, route) {
      const record = decisions.get(sessionID);
      if (!record || (route !== undefined && record.decision.route !== route)) return undefined;
      return structuredClone(record);
    },

    requireRoute(sessionID, route, scope) {
      const record = decisions.get(sessionID);
      if (!record) {
        throw new TaskClassificationError("TASK_DECISION_STALE", "No hay una clasificación vigente para esta sesión.");
      }
      if (!sameScope(record.scope, scope) || record.decision.route !== route) {
        throw new TaskClassificationError("TASK_ROUTE_MISMATCH", "La clasificación no autoriza esta ruta en el scope actual.");
      }
      return structuredClone(record.decision);
    },

    invalidate(sessionID) {
      decisions.delete(sessionID);
    },
  };
}

interface TaskClassificationToolCall {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
}

interface TaskClassificationToolEditor {
  namespace(input: { name: string; description: string }): void;
  add(input: Record<string, unknown>): void;
}

export interface TaskClassificationTools {
  transform(callback: (editor: TaskClassificationToolEditor) => void): Promise<{ dispose?: () => Promise<void> | void } | void>;
}

const TASK_ASSESSMENT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    schema: { type: "number", enum: [1] },
    understood: { type: "boolean" },
    requestedEffect: { type: "string", enum: ["none", "mutation", "unknown"] },
    userRequestedPlanning: { type: "boolean" },
    symptomOrCauseUnknown: { type: "boolean" },
    signals: {
      type: "object",
      properties: {
        specification: { type: "string", enum: ["low", "medium", "high", "unknown"] },
        discovery: { type: "string", enum: ["low", "medium", "high", "unknown"] },
        scope: { type: "string", enum: ["low", "medium", "high", "unknown"] },
        openDecisions: { type: "string", enum: ["low", "medium", "high", "unknown"] },
        reversibility: { type: "string", enum: ["low", "medium", "high", "unknown"] },
        verifiability: { type: "string", enum: ["low", "medium", "high", "unknown"] },
      },
      required: ["specification", "discovery", "scope", "openDecisions", "reversibility", "verifiability"],
      additionalProperties: false,
    },
    closure: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["known", "discoverable", "unknown"] },
        targets: { type: "string", enum: ["known", "discoverable", "unknown"] },
        verification: { type: "string", enum: ["objective", "judgment", "unknown"] },
        discovery: { type: "string", enum: ["none", "bounded-read-only", "open"] },
        openDecisionCount: { type: "number", minimum: 0, maximum: 64 },
      },
      required: ["action", "targets", "verification", "discovery", "openDecisionCount"],
      additionalProperties: false,
    },
    proof: {
      type: "object",
      properties: {
        effect: { type: "string" },
        targets: { type: "string" },
        verification: { type: "string" },
      },
      required: ["effect", "targets", "verification"],
      additionalProperties: false,
    },
    previousDecisionRef: { type: "string" },
  },
  required: ["schema", "understood", "requestedEffect", "userRequestedPlanning", "symptomOrCauseUnknown", "signals", "closure", "proof"],
  additionalProperties: false,
};

export async function registerTaskClassificationTool(
  tools: TaskClassificationTools,
  classifier: TaskClassifier,
  resolveScope: (sessionID: string) => Promise<TaskClassificationScope | undefined>,
): Promise<{ dispose?: () => Promise<void> | void } | void> {
  return tools.transform((editor) => {
    editor.namespace({ name: "malahor", description: "Clasificación read-only de tareas" });
    editor.add({
      name: "task_classify",
      description: "Clasifica una tarea por cierre y consecuencias y deriva una ruta; no autoriza ninguna tool.",
      input: TASK_ASSESSMENT_INPUT_SCHEMA,
      options: { namespace: "malahor", codemode: false },
      execute: async (value: unknown, call: TaskClassificationToolCall) => {
        const scope = await resolveScope(call.sessionID);
        if (!scope) throw new Error("Proyecto o sesión no evaluable para clasificar la tarea.");
        const decision = classifier.classify(value, scope, call);
        return {
          content: `Ruta: ${decision.route}. Razones: ${decision.reasonCodes.join(", ") || "ninguna"}.`,
          metadata: {
            kind: "malahor.task.decision",
            version: 1,
            route: decision.route,
            reasonCodes: decision.reasonCodes,
            riskGate: decision.riskGate,
            decisionRef: decision.decisionRef,
          },
        };
      },
    });
  });
}

function normalizeScope(scope: TaskClassificationScope): TaskClassificationScope {
  return {
    sessionID: scope.sessionID,
    project: scope.project,
    policyRevision: scope.policyRevision,
    mode: scope.mode,
    root: scope.root,
  };
}

function sameScope(left: TaskClassificationScope, right: TaskClassificationScope): boolean {
  return left.sessionID === right.sessionID
    && left.project === right.project
    && left.policyRevision === right.policyRevision
    && left.mode === right.mode
    && left.root === right.root;
}
