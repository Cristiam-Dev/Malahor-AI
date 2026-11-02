import { createHash } from "node:crypto";

export interface TokenLedgerStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export type TokenUsageValue = number | "unavailable";

export interface TokenLedgerSummary {
  usage: Record<string, TokenUsageValue>;
  calls: { model: number; tool: number; mcp: number };
  planning: { revisions: number; retries: number; falseRejections: number; loopBlocks: number };
  tripsAvoided: number;
  success: boolean;
}

export interface TokenLedger {
  record(event: Record<string, unknown>): Promise<{ stored: boolean; droppedFields?: string[] }>;
  summary(): Promise<TokenLedgerSummary>;
}

interface StoredLedgerEvent {
  event: string;
  recordedAt: number;
  taskRef?: string;
  planID?: string;
  revision?: string;
  planDigest?: string;
  attemptID?: string;
  actionID?: string;
  decisionCode?: string;
  canonicalInputHash?: string;
  resultClass?: string;
  exitCode?: number;
  errorHash?: string;
  resourceDigests?: { before: string[]; after: string[] };
  durationMs?: number;
  inputBytes?: number;
  outputBytes?: number;
  usage?: Record<string, TokenUsageValue>;
  calls?: { model: number; tool: number; mcp: number };
  planning?: { revisions: number; retries: number; falseRejections: number; loopBlocks: number };
  tripsAvoided?: number;
  success?: boolean;
}

interface StoredLedger {
  schema: 1;
  kind: "malahor.token-ledger";
  projectRef: string;
  sessionRef: string;
  events: StoredLedgerEvent[];
}

const MAX_EVENTS = 1_000;
const USAGE_KEYS = [
  "instructionTokens",
  "contextTokens",
  "toolSchemaTokens",
  "toolResultTokensBeforeFilter",
  "toolResultTokensAfterFilter",
  "cachedTokens",
  "uncachedTokens",
] as const;
const ALLOWED_FIELDS = new Set([
  "event", "taskRef", "planID", "revision", "planDigest", "attemptID", "actionID",
  "decisionCode", "canonicalInputHash", "resultClass", "exitCode", "errorHash",
  "resourceDigests", "durationMs", "inputBytes", "outputBytes", "usage", "calls",
  "planning", "tripsAvoided", "success",
]);

export function createTokenLedger(input: {
  project: string;
  sessionRef: string;
  storage: TokenLedgerStorage;
  now?: () => number;
}): TokenLedger {
  if (!input || typeof input.project !== "string" || !input.project.trim()
    || typeof input.sessionRef !== "string" || !input.sessionRef.trim()
    || !isStorage(input.storage)) throw new Error("Configuración de token ledger no evaluable.");
  const projectRef = hashRef(input.project.trim());
  const sessionRef = safeRef(input.sessionRef);
  const key = `planning/v5/token-ledger/${projectRef}/${hashRef(sessionRef)}`;
  const now = input.now ?? Date.now;
  let queue = Promise.resolve();
  let loaded: StoredLedger | undefined;

  const withLedger = async <T>(operation: (ledger: StoredLedger) => Promise<T> | T): Promise<T> => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!loaded) loaded = await loadLedger(input.storage, key, projectRef, sessionRef);
      return await operation(loaded);
    } finally {
      release();
    }
  };

  return {
    record: (event) => withLedger(async (ledger) => {
      const droppedFields = Object.keys(event).filter((field) => !ALLOWED_FIELDS.has(field));
      const sanitized = sanitizeEvent(event, now);
      ledger.events.push(sanitized);
      if (ledger.events.length > MAX_EVENTS) ledger.events.splice(0, ledger.events.length - MAX_EVENTS);
      await input.storage.set(key, structuredClone(ledger));
      return { stored: true, ...(droppedFields.length ? { droppedFields } : {}) };
    }),
    summary: () => withLedger((ledger) => summarize(ledger.events)),
  };
}

function sanitizeEvent(value: Record<string, unknown>, now: () => number): StoredLedgerEvent {
  const event = safeLabel(value.event, "unknown");
  const candidateNow = now();
  const recordedAt = finiteNonNegative(candidateNow) ? candidateNow : Date.now();
  const output: StoredLedgerEvent = { event, recordedAt };
  const target = output as unknown as Record<string, unknown>;
  copyRef(value, target, "taskRef");
  copyRef(value, target, "planID");
  copyRef(value, target, "revision");
  copyRef(value, target, "planDigest");
  copyRef(value, target, "attemptID");
  copyRef(value, target, "actionID");
  copyLabel(value, target, "decisionCode");
  copyRef(value, target, "canonicalInputHash");
  copyLabel(value, target, "resultClass");
  copyRef(value, target, "errorHash");
  copyNumber(value, target, "exitCode", true);
  copyNumber(value, target, "durationMs");
  copyNumber(value, target, "inputBytes");
  copyNumber(value, target, "outputBytes");
  copyNumber(value, target, "tripsAvoided");
  if (typeof value.success === "boolean") output.success = value.success;

  if (isRecord(value.resourceDigests)) {
    output.resourceDigests = {
      before: safeRefList(value.resourceDigests.before),
      after: safeRefList(value.resourceDigests.after),
    };
  }
  if (isRecord(value.usage)) {
    const rawUsage = value.usage;
    output.usage = Object.fromEntries(USAGE_KEYS.map((key) => {
      const item = rawUsage[key];
      return [key, finiteNonNegative(item) ? item as number : "unavailable"];
    }));
  }
  if (isRecord(value.calls)) {
    output.calls = {
      model: count(value.calls.model),
      tool: count(value.calls.tool),
      mcp: count(value.calls.mcp),
    };
  }
  if (isRecord(value.planning)) {
    output.planning = {
      revisions: count(value.planning.revisions),
      retries: count(value.planning.retries),
      falseRejections: count(value.planning.falseRejections),
      loopBlocks: count(value.planning.loopBlocks),
    };
  }
  return output;
}

function summarize(events: StoredLedgerEvent[]): TokenLedgerSummary {
  const usage: Record<string, TokenUsageValue> = {};
  for (const key of USAGE_KEYS) {
    const values = events.map((event) => event.usage?.[key]).filter((item) => item !== undefined);
    const numeric = values.filter((item): item is number => typeof item === "number");
    usage[key] = numeric.length > 0 ? numeric.reduce((sum, item) => sum + item, 0) : "unavailable";
  }
  const summary: TokenLedgerSummary = {
    usage,
    calls: { model: 0, tool: 0, mcp: 0 },
    planning: { revisions: 0, retries: 0, falseRejections: 0, loopBlocks: 0 },
    tripsAvoided: 0,
    success: events.length > 0 && events.every((event) => event.success !== false),
  };
  for (const event of events) {
    summary.calls.model += event.calls?.model ?? 0;
    summary.calls.tool += event.calls?.tool ?? 0;
    summary.calls.mcp += event.calls?.mcp ?? 0;
    summary.planning.revisions += event.planning?.revisions ?? 0;
    summary.planning.retries += event.planning?.retries ?? 0;
    summary.planning.falseRejections += event.planning?.falseRejections ?? 0;
    summary.planning.loopBlocks += event.planning?.loopBlocks ?? 0;
    summary.tripsAvoided += event.tripsAvoided ?? 0;
  }
  return summary;
}

async function loadLedger(
  storage: TokenLedgerStorage,
  key: string,
  projectRef: string,
  sessionRef: string,
): Promise<StoredLedger> {
  const existing = await storage.get(key);
  if (existing === undefined) {
    return { schema: 1, kind: "malahor.token-ledger", projectRef, sessionRef, events: [] };
  }
  if (!isRecord(existing) || existing.schema !== 1 || existing.kind !== "malahor.token-ledger"
    || existing.projectRef !== projectRef || existing.sessionRef !== sessionRef || !Array.isArray(existing.events)) {
    throw new Error("Token ledger existente no verificable.");
  }
  return structuredClone(existing) as unknown as StoredLedger;
}

function copyRef(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (typeof source[key] === "string") target[key] = safeRef(source[key]);
}

function copyLabel(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (typeof source[key] === "string") target[key] = safeLabel(source[key], "unknown");
}

function copyNumber(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  signed = false,
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value) && (signed || value >= 0)) target[key] = value;
}

function safeRef(value: string): string {
  if (value.length <= 256 && !/[\u0000\r\n]/u.test(value)) return value;
  return `sha256:${hashRef(value)}`;
}

function safeRefList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 100).map(safeRef)
    : [];
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function finiteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hashRef(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isStorage(value: unknown): value is TokenLedgerStorage {
  return isRecord(value) && typeof value.get === "function" && typeof value.set === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
