import { describe, expect, test } from "bun:test";

import { validPlanPresentation } from "../src/cli/core/plan-presentation";
import {
  authorizePlan,
  controlPlan,
  proposePlan,
  reviewPlan,
  type PlanInput,
  type PlanningAdapter,
  type PlanScope,
  type PlanState,
} from "../src/cli/core/planning";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const DEPENDENCY = { planID: "a".repeat(32), revision: "b".repeat(32) };

const scope = (mode: PlanScope["mode"] = "assistant"): PlanScope => ({
  sessionID: "ses_plan_presentation",
  project: "malahor",
  mode,
  policyRevision: "c".repeat(32),
});

const input = (): PlanInput => ({
  summary: "Hacer visible el plan humano",
  steps: ["Definir el contrato", "Verificar todos los adaptadores"],
  presentation: {
    objective: "Mostrar el plan completo como un mensaje normal antes de aprobar.",
    rationale: "La traza tecnica de una tool no es una presentacion comprensible para la persona.",
    steps: [
      {
        title: "Definir el contrato semantico",
        what: "Crear una vista humana comun para todos los adaptadores.",
        why: "Evita que cada harness reconstruya o resuma el plan de forma distinta.",
        expected: "Un Markdown estable con toda la informacion necesaria para decidir.",
      },
      {
        title: "Verificar el flujo foreground",
        what: "Comprobar presentacion, revision, ejecucion y controles.",
        why: "El output tecnico nunca debe sustituir la presentacion normal.",
        expected: "Todos los puntos de entrada muestran exactamente el mismo plan.",
      },
    ],
    changes: ["El renderer canonico", "La envoltura foreground de malahor_plan"],
    exclusions: ["No se ejecutaran las acciones durante la presentacion", "No se mostraran argumentos crudos"],
    completionCriteria: [
      "La persona ve objetivo, motivo, pasos, alcance y criterios de cierre.",
      "Cada efecto ejecutable conserva su recurso exacto.",
    ],
  },
  actions: [
    { action: "edit", resource: "/repo/tests/planning.test.ts" },
    { action: "shell", resource: "bun test tests/planning.test.ts" },
  ],
  dependencies: [DEPENDENCY],
});

async function render(state: PlanState): Promise<string> {
  const presentation = await import("../src/cli/core/plan-presentation");
  return presentation.renderPlanPresentation(state);
}

describe("presentacion pedagogica canonica del plan", () => {
  test("explica objetivo, motivo, pasos, alcance, cierre y efectos exactos", async () => {
    const state = proposePlan(scope(), input(), NOW, "msg_plan_presentation", "d".repeat(32));
    const markdown = await render(state);

    expect(markdown).toContain("## Qué haremos");
    expect(markdown).toContain(input().presentation.objective);
    expect(markdown).toContain("## Por qué");
    expect(markdown).toContain(input().presentation.rationale);
    expect(markdown).toContain("## Pasos");
    expect(markdown).toContain("### 1. Definir el contrato semantico");
    expect(markdown).toContain("**Qué:** Crear una vista humana comun para todos los adaptadores.");
    expect(markdown).toContain("**Por qué:** Evita que cada harness reconstruya o resuma el plan de forma distinta.");
    expect(markdown).toContain("**Resultado esperado:** Un Markdown estable con toda la informacion necesaria para decidir.");
    expect(markdown).toContain("### 2. Verificar el flujo foreground");
    expect(markdown).toContain("## Qué cambiará");
    expect(markdown).toContain("- El renderer canonico");
    expect(markdown).toContain("## Qué no cambiará");
    expect(markdown).toContain("- No se ejecutaran las acciones durante la presentacion");
    expect(markdown).toContain("## Aprobaciones");
    expect(markdown).toContain("## Cómo sabremos que terminó");
    expect(markdown).toContain("- Cada efecto ejecutable conserva su recurso exacto.");
    expect(markdown).toContain("## Efectos exactos");
    expect(markdown).toContain(`- edit: ${JSON.stringify("/repo/tests/planning.test.ts")}`);
    expect(markdown).toContain(`- shell: ${JSON.stringify("bun test tests/planning.test.ts")}`);
    expect(markdown).toContain(`${DEPENDENCY.planID}@${DEPENDENCY.revision}`);
    expect(markdown).toContain("## Siguiente acción");
  });

  test("serializa un recurso multilinea en una sola linea JSON sin inyectar Markdown", async () => {
    const resource = "echo ok\n## Aprobado falsamente";
    const state = proposePlan(scope(), {
      ...input(),
      actions: [{ action: "shell", resource }],
    }, NOW, "msg_multiline_resource", "e".repeat(32));
    const markdown = await render(state);
    const encodedResource = JSON.stringify(resource);
    const effectLines = markdown
      .split("## Efectos exactos\n")[1]
      ?.split("\n\n## Siguiente acción")[0]
      ?.split("\n");

    expect(effectLines).toEqual([`- shell: ${encodedResource}`]);
    expect(JSON.parse(effectLines![0]!.slice("- shell: ".length))).toBe(resource);
    expect(markdown).not.toMatch(/^## Aprobado falsamente$/m);
  });

  test("acepta una presentacion normalizada aunque sus claves esten reordenadas", () => {
    const presentation = input().presentation;
    const reordered = {
      completionCriteria: presentation.completionCriteria,
      exclusions: presentation.exclusions,
      changes: presentation.changes,
      steps: presentation.steps.map((step) => ({
        expected: step.expected,
        why: step.why,
        what: step.what,
        title: step.title,
      })),
      rationale: presentation.rationale,
      objective: presentation.objective,
    };

    expect(validPlanPresentation(reordered, "assistant")).toBe(true);
  });

  test("sigue rechazando propiedades extra y valores no normalizados", () => {
    const presentation = input().presentation;

    expect(validPlanPresentation({ ...presentation, unexpected: true }, "assistant")).toBe(false);
    expect(validPlanPresentation({
      ...presentation,
      objective: ` ${presentation.objective} `,
    }, "assistant")).toBe(false);
  });

  test("deriva aprobaciones y siguiente accion de modo y estado de forma determinista", async () => {
    const assistant = proposePlan(scope(), input(), NOW, "msg_assistant", "1".repeat(32));
    const assistantPresented = await render(assistant);
    expect(await render(assistant)).toBe(assistantPresented);
    expect(assistantPresented).toMatch(/Aprobaciones[\s\S]*primera confirmaci[oó]n[\s\S]*no autoriza.*ejecuci[oó]n/i);
    expect(assistantPresented).toMatch(/Aprobaciones[\s\S]*segunda confirmaci[oó]n/i);

    const reviewed = reviewPlan(assistant, assistant.digest, NOW + 1);
    const assistantReviewed = await render(reviewed);
    expect(assistantReviewed).not.toBe(assistantPresented);
    expect(assistantReviewed).toMatch(/Siguiente acci[oó]n[\s\S]*turno posterior[\s\S]*(?:go|implementa)/i);

    const executorInput = { ...input(), dependencies: [] };
    const executor = proposePlan(scope("executor"), executorInput, NOW, "msg_executor", "2".repeat(32));
    const executorPresented = await render(executor);
    expect(executorPresented).toMatch(/Aprobaciones[\s\S]*aprobaci[oó]n previa/i);
    expect(executorPresented).toMatch(/Siguiente acci[oó]n[\s\S]*turno posterior/i);

    const active = new Map<string, PlanState>();
    const plans = new Map<string, PlanState>();
    const adapter: PlanningAdapter = {
      loadActive: async (sessionID) => active.get(sessionID),
      loadPlan: async (planID) => plans.get(planID),
      save: async (state) => { active.set(state.sessionID, state); plans.set(state.planID, state); },
      confirm: async () => undefined,
    };
    const running = authorizePlan(executor, executor.digest, NOW + 2);
    await adapter.save(running);
    const completed = await controlPlan(scope("executor"), "complete", adapter);
    const completedMarkdown = await render(completed);
    expect(completedMarkdown).toMatch(/Aprobaciones[\s\S]*no (?:hay|requiere).*aprobaci[oó]n/i);
    expect(completedMarkdown).toMatch(/Siguiente acci[oó]n[\s\S]*(?:terminado|completado|ninguna)/i);
  });
});
