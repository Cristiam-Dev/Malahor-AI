import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveCanonicalProjectScope } from "../src/cli/core/project";
import { dbPath, saveDb } from "../src/mnemo/db";
import { contextForProject, memoryBrief } from "../src/mnemo/context";
import { callTool, toolDefinitions } from "../src/mnemo/tools";
import { cleanupTestEnv, fixtureDb, setupTestEnv, type TestEnvSnapshot } from "./mnemo-fixture";

let testEnv: TestEnvSnapshot;

beforeEach(() => {
  testEnv = setupTestEnv();
});

afterEach(() => {
  cleanupTestEnv(testEnv);
});

describe("Mnemo hierarchical scopes", () => {
  it("preserves hierarchy and canonicalizes aliases only at the root", () => {
    expect(resolveCanonicalProjectScope("Acme/Store/Checkout/Coupons")).toBe("acme/store/checkout/coupons");
    expect(resolveCanonicalProjectScope("MalaHor/Build", { malahor: ["MalaHor"] })).toBe("malahor/build");
    expect(resolveCanonicalProjectScope("flowin-backend")).toBe("flowin-backend");
  });

  it("inherits observations from the active scope, its parents, and global", () => {
    saveDb(fixtureDb());

    const context = contextForProject("acme/store/checkout/coupons", 8, dbPath());

    expect(context.scopeChain).toEqual([
      "global",
      "acme",
      "acme/store",
      "acme/store/checkout",
      "acme/store/checkout/coupons",
    ]);
    expect(context.observations.map((item) => item.project)).toContain("global");
    expect(context.observations.map((item) => item.project)).toContain("acme/store");
    expect(context.observations.map((item) => item.project)).toContain("acme/store/checkout/coupons");
    expect(context.latestSession?.project).toBe("acme/store");
  });

  it("builds a natural-language brief and recalls related memories from sibling scopes", () => {
    saveDb(fixtureDb());

    const brief = memoryBrief("Nueva feature de cupones, reutiliza la validacion de pagos", {
      project: "acme/store",
      scope: "acme/store/checkout/coupons",
      limit: 8,
      relatedLimit: 5,
    });

    expect(brief.scope).toBe("acme/store/checkout/coupons");
    expect(brief.scopeSource).toBe("requested");
    expect(brief.observations.some((item) => item.project === "acme/store")).toBe(true);
    expect(brief.relatedMemories.some((item) => item.project === "acme/store/checkout/payments")).toBe(true);
  });

  it("returns candidates instead of guessing when there is no clear scope", () => {
    saveDb(fixtureDb());

    const brief = memoryBrief("trabajar en payments", { relatedLimit: 5 });

    expect(brief.scope).toBeNull();
    expect(brief.scopeSource).toBe("unresolved");
    expect(brief.scopeSuggestions.length).toBeGreaterThan(0);
  });

  it("exposes mem_brief as an MCP tool for harness-driven natural-language retrieval", () => {
    saveDb(fixtureDb());

    const definition = toolDefinitions.find((tool) => tool.name === "mem_brief");
    const result = callTool({
      name: "mem_brief",
      arguments: {
        request: "Nueva feature de cupones, reutiliza validacion de pagos",
        project: "acme/store",
        scope: "acme/store/checkout/coupons",
      },
    }) as ReturnType<typeof memoryBrief>;

    expect(definition).toBeDefined();
    expect(result.scope).toBe("acme/store/checkout/coupons");
    expect(result.relatedMemories.some((item) => item.project === "acme/store/checkout/payments")).toBe(true);
  });

});
