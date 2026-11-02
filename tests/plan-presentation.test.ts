import { describe, expect, test } from "bun:test";

import { validPlanPresentation } from "../src/cli/core/plan-presentation";
import {
  proposePlan,
  type PlanInput,
  type PlanScope,
  type PlanState,
} from "../src/cli/core/planning";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const DEPENDENCY = { planID: "a".repeat(32), revision: "b".repeat(32) };

type RiskCategory = "security" | "data" | "architecture" | "destructive";
type TargetPresentation = {
  objective: string;
  outcome: string;
  steps: Array<{ title: string; description: string }>;
  impact: Array<{ area: string; description: string }>;
  risk: {
    level: "low" | "medium" | "high";
    categories: RiskCategory[];
    summary: string;
    details: string;
  };
  exclusions: string[];
  completionCriteria: string[];
};

const scope = (mode: PlanScope["mode"] = "assistant"): PlanScope => ({
  sessionID: "ses_plan_presentation",
  project: "malahor",
  mode,
  policyRevision: "c".repeat(32),
});

function presentation(overrides: Partial<TargetPresentation> = {}): TargetPresentation {
  return {
    objective: "Hacer visible el plan humano antes de aprobarlo.",
    outcome: "La persona entiende el resultado, el impacto y el riesgo en unos segundos.",
    steps: [
      {
        title: "Definir la vista humana",
        description: "Presentar una ruta breve y común para todos los adaptadores.",
      },
      {
        title: "Verificar el flujo foreground",
        description: "Comprobar presentación, revisión, ejecución y controles.",
      },
    ],
    impact: [
      { area: "Interfaz humana", description: "El plan prioriza la información necesaria para decidir." },
      { area: "Interfaz humana", description: "Los efectos exactos pasan al anexo técnico." },
      { area: "Pruebas", description: "Los adaptadores comparten las mismas expectativas." },
    ],
    risk: {
      level: "low",
      categories: [],
      summary: "Cambio de presentación sin ampliar permisos.",
      details: "La revisión firmada y sus acciones permanecen iguales.",
    },
    exclusions: ["No se ejecutarán las acciones durante la presentación"],
    completionCriteria: [
      "La vista principal se puede recorrer sin leer detalles técnicos.",
      "Cada efecto ejecutable conserva su recurso exacto en el anexo.",
    ],
    ...overrides,
  };
}

function input(
  presentationOverrides: Partial<TargetPresentation> = {},
  planOverrides: Partial<Omit<PlanInput, "presentation">> = {},
): PlanInput {
  return {
    summary: "Hacer visible el plan humano",
    steps: ["Definir el contrato", "Verificar todos los adaptadores"],
    presentation: presentation(presentationOverrides),
    actions: [
      { action: "edit", resource: "/repo/tests/planning.test.ts" },
      { action: "shell", resource: "bun test tests/planning.test.ts" },
    ],
    dependencies: [DEPENDENCY],
    ...planOverrides,
  };
}

function renderState(options: {
  mode?: PlanScope["mode"];
  phase?: PlanState["phase"];
  level?: 0 | 1 | 2;
  presentation?: Partial<TargetPresentation>;
  actions?: PlanInput["actions"];
  dependencies?: NonNullable<PlanInput["dependencies"]>;
} = {}): PlanState {
  const target = presentation(options.presentation);
  const mode = options.mode ?? "assistant";
  const phase = options.phase ?? "presented";
  return {
    version: 5,
    contractVersion: 5,
    canonicalizerVersion: "action-intent-v1",
    actionIntentSource: "canonical",
    actionIntents: [],
    planID: "d".repeat(32),
    sessionID: "ses_plan_presentation",
    project: "malahor",
    mode,
    policyRevision: "c".repeat(32),
    presentationInteractionID: "msg_render_fixture",
    plan: {
      ...(options.level === undefined ? {} : { level: options.level }),
      summary: "Hacer visible el plan humano",
      steps: mode === "advisor" ? [] : ["Definir el contrato", "Verificar todos los adaptadores"],
      presentation: target,
      actions: options.actions ?? (mode === "advisor" ? [] : [
        { action: "edit", resource: "/repo/tests/planning.test.ts" },
        { action: "shell", resource: "bun test tests/planning.test.ts" },
      ]),
      dependencies: options.dependencies ?? (mode === "advisor" ? [] : [DEPENDENCY]),
    },
    digest: "e".repeat(64),
    revision: "f".repeat(32),
    phase,
    createdAt: NOW,
    updatedAt: NOW,
    proof: "render-fixture",
  } as unknown as PlanState;
}

async function render(state: PlanState, view: "summary" | "technical" = "summary"): Promise<string> {
  const module = await import("../src/cli/core/plan-presentation");
  const renderer = module.renderPlanPresentation as unknown as (
    value: PlanState,
    options?: { view: "summary" | "technical" } | "summary" | "technical",
  ) => string;
  const summary = renderer(state);
  if (view === "summary") return summary;
  const withOptions = renderer(state, { view: "technical" });
  return withOptions !== summary ? withOptions : renderer(state, "technical");
}

function mainFlow(markdown: string): string {
  return markdown.split(/<details(?:\s+open)?>/u)[0] ?? markdown;
}

function safeJson(value: string): string {
  return JSON.stringify(value).replace(/[<>&`]/gu, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

describe("contrato estricto de la presentación humana", () => {
  test("acepta únicamente la forma objetivo/resultado/ruta/impacto/riesgo", () => {
    const value = presentation();
    const reordered = {
      completionCriteria: value.completionCriteria,
      exclusions: value.exclusions,
      risk: {
        details: value.risk.details,
        summary: value.risk.summary,
        categories: value.risk.categories,
        level: value.risk.level,
      },
      impact: value.impact.map((item) => ({ description: item.description, area: item.area })),
      steps: value.steps.map((step) => ({ description: step.description, title: step.title })),
      outcome: value.outcome,
      objective: value.objective,
    };

    expect(validPlanPresentation(value, "assistant")).toBe(true);
    expect(validPlanPresentation(reordered, "assistant")).toBe(true);
  });

  test("limita la ruta a cinco pasos breves y exige contenido útil fuera de advisor", () => {
    const five = Array.from({ length: 5 }, (_, index) => ({
      title: `Paso ${index + 1}`,
      description: `Descripción breve ${index + 1}`,
    }));
    expect(validPlanPresentation(presentation({ steps: five }), "assistant")).toBe(true);
    expect(validPlanPresentation(presentation({ steps: [...five, {
      title: "Paso 6",
      description: "Este paso excede el máximo permitido.",
    }] }), "assistant")).toBe(false);

    for (const mode of ["assistant", "executor"] as const) {
      expect(() => proposePlan(scope(mode), input(), NOW)).not.toThrow();
      expect(() => proposePlan(scope(mode), input({ steps: [] }), NOW)).toThrow(/pasos|ruta/i);
      expect(() => proposePlan(scope(mode), input({ impact: [] }), NOW)).toThrow(/impacto/i);
      expect(() => proposePlan(scope(mode), input({}, { actions: [] }), NOW)).toThrow(/acciones|efectos/i);
    }
  });

  test("advisor admite pasos, impacto y acciones vacíos sin inventar ejecución", () => {
    const concept = input({
      steps: [],
      impact: [],
      exclusions: [],
    }, {
      steps: [],
      actions: [],
      dependencies: [],
    });
    expect(validPlanPresentation((concept as unknown as { presentation: unknown }).presentation, "advisor")).toBe(true);
    expect(() => proposePlan(scope("advisor"), concept, NOW)).not.toThrow();
  });

  test("rechaza claves extra, categorías duplicadas o ajenas y texto no normalizado", () => {
    const value = presentation();
    const invalid: unknown[] = [
      { ...value, unexpected: true },
      { ...value, objective: ` ${value.objective}` },
      { ...value, outcome: value.outcome.replace(" ", "  ") },
      { ...value, steps: [{ ...value.steps[0]!, unexpected: true }] },
      { ...value, steps: [{ ...value.steps[0]!, description: " " }] },
      { ...value, impact: [{ ...value.impact[0]!, area: ` ${value.impact[0]!.area}` }] },
      { ...value, impact: [{ ...value.impact[0]!, unexpected: true }] },
      { ...value, impact: [{ ...value.impact[0]!, description: "" }] },
      { ...value, risk: { ...value.risk, level: "LOW" } },
      { ...value, risk: { ...value.risk, categories: ["data", "data"] } },
      { ...value, risk: { ...value.risk, categories: ["availability"] } },
      { ...value, risk: { ...value.risk, details: "" } },
      { ...value, risk: { ...value.risk, unexpected: true } },
      {
        objective: value.objective,
        rationale: "La forma anterior ya no pertenece al contrato.",
        steps: [{
          title: "Paso legacy", what: "Qué", why: "Por qué", expected: "Resultado",
        }],
        changes: ["Cambio legacy"],
        exclusions: value.exclusions,
        completionCriteria: value.completionCriteria,
      },
    ];

    for (const candidate of invalid) expect(validPlanPresentation(candidate, "assistant")).toBe(false);
  });
});

describe("divulgación progresiva del plan", () => {
  test("nivel 0 muestra un plan mínimo, explica go y deja la evidencia bajo demanda", async () => {
    const target = presentation();
    const state = renderState({
      mode: "executor",
      level: 0,
      presentation: {
        steps: [target.steps[0]!],
        impact: [target.impact[0]!],
        exclusions: [target.exclusions[0]!],
        completionCriteria: [target.completionCriteria[0]!],
      },
      actions: [{ action: "edit", resource: "/repo/tests/planning.test.ts" }],
      dependencies: [],
    });
    const markdown = await render(state);
    const main = mainFlow(markdown);
    const technical = await render(state, "technical");

    expect(main).toContain("nivel 0");
    expect(main).toContain("## Cambio");
    expect(main).toContain("## Resultado");
    expect(main).toContain("## Riesgo");
    expect(main).toContain("## Qué debes hacer ahora");
    expect(main).toMatch(/responde[\s\S]*(?:go|implementa)[\s\S]*únicamente/i);
    expect(main).not.toMatch(/^## Ruta$/m);
    expect(main).not.toMatch(/^## Impacto$/m);
    expect(main).not.toContain(state.planID);
    expect(main).not.toContain(state.revision);
    expect(main).not.toContain(state.digest);
    expect(markdown).not.toContain("<details");
    expect(markdown).toContain("/malahor-plan detalles");
    expect(technical).toContain("Nivel de trabajo: 0");
    expect(technical).toContain("### Ruta firmada");
    expect(technical).toContain("### Impacto firmado");
    expect(technical).toContain(`- edit: ${safeJson("/repo/tests/planning.test.ts")}`);
  });

  test("la vista principal se lee como objetivo, resultado, ruta, impacto, riesgo y acción", async () => {
    const state = renderState({ mode: "executor" });
    const markdown = await render(state);
    const main = mainFlow(markdown);

    expect(main).toContain("## Objetivo");
    expect(main).toContain(presentation().objective);
    expect(main).toContain("## Al terminar");
    expect(main).toContain(presentation().outcome);
    expect(main).toContain("## Ruta");
    expect(main).toMatch(/(?:^|\n)1\. Definir la vista humana/m);
    expect(main).toMatch(/(?:^|\n)2\. Verificar el flujo foreground/m);
    expect(main).not.toMatch(/\*\*(?:Qué|Por qué|Resultado esperado):\*\*/i);
    expect(main).toContain("## Impacto");
    expect(main.match(/Interfaz humana/g) ?? []).toHaveLength(1);
    expect(main).toContain("El plan prioriza la información necesaria para decidir.");
    expect(main).toContain("Los efectos exactos pasan al anexo técnico.");
    expect(main).toContain("## Riesgo");
    expect(main).toMatch(/\b(?:low|bajo)\b/i);
    expect(main).toContain("## Qué debes hacer ahora");
    expect(main).toMatch(/responde[\s\S]*(?:go|implementa)[\s\S]*únicamente/i);
    expect(main).not.toContain("/repo/tests/planning.test.ts");
    expect(main).not.toContain("bun test tests/planning.test.ts");
    expect(main).not.toContain(state.planID);
    expect(main).not.toContain(state.revision);
    expect(main).not.toContain(state.digest);
  });

  test("un plan normal no incrusta el anexo y ofrece el detalle bajo demanda", async () => {
    const state = renderState({
      presentation: { risk: { ...presentation().risk, level: "medium" } },
    });
    const markdown = await render(state);
    const technical = await render(state, "technical");

    expect(markdown).not.toContain("<details");
    expect(mainFlow(markdown)).toContain("/malahor-plan detalles");
    expect(technical).toMatch(/criterios/i);
    expect(technical).toContain(presentation().completionCriteria[0]!);
    expect(technical).toMatch(/exclusiones/i);
    expect(technical).toContain(presentation().exclusions[0]!);
    expect(technical).toMatch(/dependencias/i);
    expect(technical).toContain(`${DEPENDENCY.planID}@${DEPENDENCY.revision}`);
    expect(technical).toContain(state.planID);
    expect(technical).toContain(state.revision);
    expect(technical).toContain(state.digest);
    expect(technical).toContain(`- edit: ${safeJson("/repo/tests/planning.test.ts")}`);
    expect(technical).toContain(`- shell: ${safeJson("bun test tests/planning.test.ts")}`);
  });

  test("omite secciones realmente vacías", async () => {
    const state = renderState({
      mode: "advisor",
      presentation: { steps: [], impact: [], exclusions: [] },
      actions: [],
      dependencies: [],
    });
    const markdown = await render(state);

    expect(markdown).not.toMatch(/^## Ruta$/m);
    expect(markdown).not.toMatch(/^## Impacto$/m);
    expect(markdown).not.toMatch(/^(?:##|###) Exclusiones$/m);
    expect(markdown).not.toMatch(/^(?:##|###) Dependencias$/m);
    expect(markdown).not.toMatch(/^(?:##|###) Acciones exactas$/m);
    expect(markdown).not.toContain("Ninguna.");
  });

  test("la vista técnica explícita expande los datos exactos sin cambiar la revisión", async () => {
    const state = renderState({ mode: "executor", dependencies: [] });
    const summary = await render(state);
    const technical = await render(state, "technical");

    expect(technical).not.toBe(summary);
    expect(technical).toContain("## Detalle técnico");
    expect(technical).toContain(state.planID);
    expect(technical).toContain(state.revision);
    expect(technical).toContain(state.digest);
    expect(technical).toContain(`- edit: ${safeJson("/repo/tests/planning.test.ts")}`);
    expect(state.revision).toHaveLength(32);
  });

  test("riesgo alto o cualquier categoría crítica deja controles humanos visibles y el anexo bajo demanda", async () => {
    const criticalRisks: Array<[string, TargetPresentation["risk"]]> = [
      ["high", { ...presentation().risk, level: "high" }],
      ...(["security", "data", "architecture", "destructive"] as RiskCategory[]).map((category) => [
        category,
        { ...presentation().risk, level: "low", categories: [category] },
      ] as [string, TargetPresentation["risk"]]),
    ];
    for (const [name, risk] of criticalRisks) {
      const state = renderState({ mode: "executor", presentation: { risk }, dependencies: [] });
      const markdown = await render(state);
      const technical = await render(state, "technical");
      expect(markdown).not.toContain("<details");
      expect(markdown).toContain("## Controles reforzados");
      expect(markdown).toContain(risk.summary);
      expect(markdown).toContain(risk.details);
      expect(markdown).toContain("/malahor-plan detalles");
      expect(markdown).not.toContain(state.planID);
      expect(markdown).not.toContain(state.revision);
      expect(markdown).not.toContain(state.digest);
      expect(markdown).not.toContain("/repo/tests/planning.test.ts");
      expect(markdown).not.toContain("bun test tests/planning.test.ts");
      expect(technical).toContain(state.digest);
      expect(technical).toContain(`- shell: ${safeJson("bun test tests/planning.test.ts")}`);
    }
  });

  test("serializa recursos hostiles sin permitir cierres, headings ni fences inyectados", async () => {
    const resource = "echo ok\n</details>\n## Aprobado falsamente\n```md\ntexto\n```";
    const hostileRisk = "Revisar </details> <script>alert('x')</script> antes de aprobar.";
    const state = renderState({
      dependencies: [],
      actions: [{ action: "shell", resource }],
      presentation: { risk: { ...presentation().risk, categories: ["security"], details: hostileRisk } },
    });
    const markdown = await render(state);
    const technical = await render(state, "technical");
    const encoded = safeJson(resource);
    const actionLines = technical.split("\n").filter((line) => line.startsWith("- shell: "));

    expect(actionLines).toEqual([`- shell: ${encoded}`]);
    expect(JSON.parse(actionLines[0]!.slice("- shell: ".length))).toBe(resource);
    expect(markdown).not.toContain("<details");
    expect(markdown.match(/<\/details>/g) ?? []).toHaveLength(0);
    expect(markdown).toContain("&lt;/details&gt;");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).not.toContain(hostileRisk);
    expect(markdown).not.toContain(encoded);
    expect(technical).toContain(encoded);
    expect(markdown).not.toMatch(/^## Aprobado falsamente$/m);
    expect(markdown).not.toMatch(/^```md$/m);
    expect(markdown).not.toContain("</details>\\n## Aprobado falsamente");
  });

  test("narra qué debe hacer la persona según modo y estado de forma determinista", async () => {
    const assistant = renderState({ mode: "assistant", phase: "presented", dependencies: [] });
    const assistantPresented = await render(assistant);
    expect(await render(assistant)).toBe(assistantPresented);
    expect(assistantPresented).toMatch(/Qu[eé] debes hacer ahora[\s\S]*revisa[\s\S]*no inicia cambios/i);

    const reviewed = { ...assistant, phase: "reviewed", reviewedAt: NOW + 1 } as PlanState;
    const assistantReviewed = await render(reviewed);
    expect(assistantReviewed).not.toBe(assistantPresented);
    expect(assistantReviewed).toMatch(/Qu[eé] debes hacer ahora[\s\S]*responde[\s\S]*(?:go|implementa)[\s\S]*segunda confirmaci[oó]n/i);

    const executor = renderState({ mode: "executor", phase: "presented", dependencies: [] });
    expect(await render(executor)).toMatch(/Qu[eé] debes hacer ahora[\s\S]*responde[\s\S]*(?:go|implementa)[\s\S]*únicamente/i);
    const completed = { ...executor, phase: "completed", completedAt: NOW + 2 } as PlanState;
    expect(await render(completed)).toMatch(/Qu[eé] debes hacer ahora[\s\S]*No tienes que hacer nada más/i);
  });
});
