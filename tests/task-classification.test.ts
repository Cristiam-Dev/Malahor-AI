import { describe, expect, test } from "bun:test";

import {
  TASK_CLASSIFICATION_SCHEMA,
  deriveTaskDecision,
  parseTaskAssessment,
  taskRouteLabel,
  type TaskAssessmentV1,
  type TaskClassificationContext,
} from "../src/cli/core/task-classification";

const context: TaskClassificationContext = {
  sessionID: "ses_task_classification",
  messageID: "msg_task_classification",
  project: "demo",
  root: "/tmp/demo",
  mode: "executor",
  policyRevision: "policy-1",
};

function assessment(overrides: Partial<TaskAssessmentV1> = {}): TaskAssessmentV1 {
  return {
    schema: TASK_CLASSIFICATION_SCHEMA,
    understood: true,
    requestedEffect: "mutation",
    userRequestedPlanning: false,
    symptomOrCauseUnknown: false,
    signals: {
      specification: "low",
      discovery: "low",
      scope: "low",
      openDecisions: "low",
      reversibility: "low",
      verifiability: "low",
    },
    closure: {
      action: "known",
      targets: "known",
      verification: "objective",
      discovery: "none",
      openDecisionCount: 0,
    },
    proof: {
      effect: "Reemplaza la línea exacta del archivo indicado.",
      targets: "src/example.ts",
      verification: "El test focalizado termina con código cero.",
    },
    ...overrides,
  };
}

describe("clasificación de tareas", () => {
  test("acepta una evaluación cerrada y deriva ejecución directa", () => {
    const parsed = parseTaskAssessment(assessment());
    const decision = deriveTaskDecision(parsed, context);

    expect(decision).toMatchObject({
      schema: 1,
      route: "direct",
      riskGate: "none",
    });
    expect(decision.reasonCodes).toContain("closed-direct");
    expect(decision.decisionRef).toMatch(/^[a-f0-9]{64}$/);
    expect(taskRouteLabel(decision.route)).toBe("ejecución directa");
  });

  test("deriva inspect, diagnose, recognize, sdd y clarify según el cierre", () => {
    const inspect = deriveTaskDecision(parseTaskAssessment(assessment({
      requestedEffect: "none",
      proof: { effect: "No hay efecto.", targets: "No aplica.", verification: "Respuesta revisada." },
    })), context);
    expect(inspect.route).toBe("inspect");

    const diagnose = deriveTaskDecision(parseTaskAssessment(assessment({
      symptomOrCauseUnknown: true,
    })), context);
    expect(diagnose.route).toBe("diagnose");

    const recognize = deriveTaskDecision(parseTaskAssessment(assessment({
      closure: {
        action: "discoverable",
        targets: "discoverable",
        verification: "objective",
        discovery: "bounded-read-only",
        openDecisionCount: 0,
      },
    })), context);
    expect(recognize.route).toBe("recognize");

    const sdd = deriveTaskDecision(parseTaskAssessment(assessment({
      closure: {
        action: "known",
        targets: "known",
        verification: "judgment",
        discovery: "none",
        openDecisionCount: 1,
      },
    })), context);
    expect(sdd.route).toBe("sdd");

    const clarify = deriveTaskDecision(parseTaskAssessment(assessment({
      understood: false,
      proof: { effect: "", targets: "", verification: "" },
    })), context);
    expect(clarify.route).toBe("clarify");
  });

  test("una petición explícita de planificación gana y el riesgo alto activa el gate", () => {
    const planned = deriveTaskDecision(parseTaskAssessment(assessment({
      userRequestedPlanning: true,
      signals: { ...assessment().signals, reversibility: "high" },
    })), context);
    expect(planned.route).toBe("sdd");
    expect(planned.reasonCodes).toContain("user-requested-planning");
    expect(planned.riskGate).toBe("policy-evaluation-required");
  });

  test("el decisionRef es estable y cambia con el contexto o la evaluación", () => {
    const parsed = parseTaskAssessment(assessment());
    const first = deriveTaskDecision(parsed, context);
    const second = deriveTaskDecision(parsed, context);
    const otherContext = deriveTaskDecision(parsed, { ...context, messageID: "msg_other" });
    const otherAssessment = deriveTaskDecision(parseTaskAssessment(assessment({
      signals: { ...assessment().signals, scope: "high" },
    })), context);

    expect(first.decisionRef).toBe(second.decisionRef);
    expect(first.decisionRef).not.toBe(otherContext.decisionRef);
    expect(first.decisionRef).not.toBe(otherAssessment.decisionRef);
  });

  test("rechaza placeholders, campos extra, enums inválidos y material sensible", () => {
    expect(() => parseTaskAssessment(assessment({
      proof: { effect: "lo necesario", targets: "src/a.ts", verification: "test" },
    }))).toThrow(/placeholder/i);
    expect(() => parseTaskAssessment({ ...assessment(), route: "direct" })).toThrow(/inválida/i);
    expect(() => parseTaskAssessment(assessment({
      signals: { ...assessment().signals, scope: "extreme" as never },
    }))).toThrow(/señal/i);
    expect(() => parseTaskAssessment(assessment({
      proof: { effect: ["", ["api", "key"].join("_"), "='", ["synthetic", "fixture", "credential"].join("-"), "'"].join(""), targets: "src/a.ts", verification: "test" },
    }))).toThrow(/sensible/i);
    expect(() => parseTaskAssessment(assessment({
      closure: { ...assessment().closure, openDecisionCount: -1 },
    }))).toThrow(/cierre/i);
  });
});
