import { describe, expect, test } from "bun:test";

interface LedgerStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

interface TokenLedger {
  record(event: Record<string, unknown>): Promise<{ stored: boolean; droppedFields?: string[] }>;
  summary(): Promise<{
    usage: Record<string, number | "unavailable">;
    calls: { model: number; tool: number; mcp: number };
    planning: { revisions: number; retries: number; falseRejections: number; loopBlocks: number };
    tripsAvoided: number;
    success: boolean;
  }>;
}

interface TokenLedgerApi {
  createTokenLedger(input: {
    project: string;
    sessionRef: string;
    storage: LedgerStorage;
    now?: () => number;
  }): TokenLedger;
}

async function loadTokenLedgerApi(): Promise<TokenLedgerApi> {
  const modulePath = "../src/plugin/token-ledger";
  try {
    return await import(modulePath) as unknown as TokenLedgerApi;
  } catch (cause) {
    throw new Error(`API normativa ausente: ${modulePath} (ledger sin payloads).`, { cause });
  }
}

function storageFixture(): { records: Map<string, unknown>; storage: LedgerStorage } {
  const records = new Map<string, unknown>();
  return {
    records,
    storage: {
      get: async (key) => records.get(key),
      set: async (key, value) => { records.set(key, structuredClone(value)); },
    },
  };
}

function metadataEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "attempt.completed",
    taskRef: "sha256:task",
    planID: "1".repeat(32),
    revision: "2".repeat(32),
    attemptID: "att_0001",
    actionID: "3".repeat(64),
    decisionCode: "AUTHORIZED",
    canonicalInputHash: "sha256:canonical-input",
    resultClass: "failure",
    exitCode: 1,
    errorHash: "sha256:redacted-error",
    resourceDigests: { before: ["sha256:before"], after: ["sha256:after"] },
    durationMs: 25,
    inputBytes: 128,
    outputBytes: 256,
    usage: {
      instructionTokens: 100,
      contextTokens: 200,
      toolSchemaTokens: 300,
      toolResultTokensBeforeFilter: 400,
      toolResultTokensAfterFilter: 80,
      cachedTokens: "unavailable",
      uncachedTokens: "unavailable",
    },
    calls: { model: 1, tool: 2, mcp: 1 },
    tripsAvoided: 1,
    planning: { revisions: 1, retries: 1, falseRejections: 1, loopBlocks: 0 },
    success: false,
    ...overrides,
  };
}

describe("A3: token ledger local y minimizado", () => {
  test("expone la API normativa del ledger", async () => {
    const api = await loadTokenLedgerApi();
    const fixture = storageFixture();
    const ledger = api.createTokenLedger({
      project: "malahor",
      sessionRef: "sha256:session",
      storage: fixture.storage,
    });

    expect(typeof api.createTokenLedger).toBe("function");
    expect(typeof ledger.record).toBe("function");
    expect(typeof ledger.summary).toBe("function");
  });

  test("persiste solo metadata, hashes y contadores; nunca prompts, contenido, comandos, secretos o payloads", async () => {
    const api = await loadTokenLedgerApi();
    const fixture = storageFixture();
    const ledger = api.createTokenLedger({
      project: "malahor",
      sessionRef: "sha256:session",
      storage: fixture.storage,
      now: () => Date.parse("2026-11-02T18:00:00.000Z"),
    });
    const forbidden = {
      prompt: "FORBIDDEN_PROMPT_SENTINEL",
      content: "FORBIDDEN_FILE_CONTENT_SENTINEL",
      command: "FORBIDDEN_FULL_COMMAND_SENTINEL",
      secret: "FORBIDDEN_SECRET_SENTINEL",
      payload: { raw: "FORBIDDEN_PAYLOAD_SENTINEL" },
      toolResult: "FORBIDDEN_TOOL_RESULT_SENTINEL",
    };

    let rejection: unknown;
    try {
      const result = await ledger.record(metadataEvent(forbidden));
      expect(result.droppedFields).toEqual(expect.arrayContaining(Object.keys(forbidden)));
    } catch (error) {
      rejection = error;
    }

    if (rejection !== undefined) expect(rejection).toMatchObject({ code: "LEDGER_PAYLOAD_FORBIDDEN" });
    const persisted = JSON.stringify([...fixture.records.entries()]);
    for (const sentinel of Object.values(forbidden).flatMap((value) =>
      typeof value === "string" ? [value] : Object.values(value))) {
      expect(persisted).not.toContain(String(sentinel));
    }
    expect(persisted).not.toContain("FORBIDDEN_");
  });

  test("marca usage no disponible sin inventar precisión y conserva los contadores observables", async () => {
    const api = await loadTokenLedgerApi();
    const fixture = storageFixture();
    const ledger = api.createTokenLedger({
      project: "malahor",
      sessionRef: "sha256:session",
      storage: fixture.storage,
    });
    await ledger.record(metadataEvent());
    const summary = await ledger.summary();

    expect(summary.usage).toMatchObject({
      instructionTokens: 100,
      contextTokens: 200,
      toolSchemaTokens: 300,
      toolResultTokensBeforeFilter: 400,
      toolResultTokensAfterFilter: 80,
      cachedTokens: "unavailable",
      uncachedTokens: "unavailable",
    });
    expect(summary.calls).toEqual({ model: 1, tool: 2, mcp: 1 });
    expect(summary.planning).toEqual({ revisions: 1, retries: 1, falseRejections: 1, loopBlocks: 0 });
    expect(summary.tripsAvoided).toBe(1);
    expect(summary.success).toBe(false);
  });

  test("el ledger guarda intentos por hash y no incorpora el attemptID al digest del plan", async () => {
    const api = await loadTokenLedgerApi();
    const fixture = storageFixture();
    const ledger = api.createTokenLedger({
      project: "malahor",
      sessionRef: "sha256:session",
      storage: fixture.storage,
    });
    const planDigest = "a".repeat(64);
    await ledger.record(metadataEvent({ attemptID: "att_0001", planDigest }));
    await ledger.record(metadataEvent({ attemptID: "att_0002", planDigest }));

    const persisted = JSON.stringify([...fixture.records.values()]);
    expect(persisted).toContain("att_0001");
    expect(persisted).toContain("att_0002");
    expect(persisted.match(new RegExp(planDigest, "g"))?.length).toBeGreaterThanOrEqual(1);
    expect(await ledger.summary()).toMatchObject({ planning: { retries: 2 } });
  });
});
