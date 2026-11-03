import { parentPort, workerData } from "node:worker_threads";

import { CodeMode, Tool, toolError } from "@opencode/codemode";
import { Effect } from "effect";

import {
  CodeModeBoundaryError,
  codeModeUtf8Bytes,
  sanitizeCodeModeBoundary,
  safeCodeModeMessage,
  type CodeModeJson,
} from "./code-mode-redaction";

export const CODE_MODE_RPC_VERSION = 1 as const;

export const CODE_MODE_LIMITS = Object.freeze({
  codeBytes: 16 * 1024,
  interpreterMs: 10_000,
  watchdogMs: 11_000,
  callMs: 3_000,
  maxToolCalls: 12,
  maxConcurrentCalls: 4,
  callInputBytes: 8 * 1024,
  callOutputBytes: 64 * 1024,
  aggregateOutputBytes: 256 * 1024,
  resultBytes: 64 * 1024,
  maxDepth: 16,
  maxProperties: 128,
  maxItems: 2_000,
  globResults: 100,
  grepResults: 100,
  readLines: 2_000,
});

export const CODE_MODE_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  codeRangeSizeMb: 32,
  stackSizeMb: 2,
});

export const CODE_MODE_LOGICAL_TOOLS = ["read", "glob", "grep"] as const;
export type CodeModeLogicalTool = typeof CODE_MODE_LOGICAL_TOOLS[number];

export const CODE_MODE_FAILURE_CODES = [
  "CATALOG_REF_INVALID",
  "CATALOG_DRIFT",
  "SCOPE_DRIFT",
  "POLICY_DRIFT",
  "TOOL_NOT_DISCOVERED",
  "INVALID_INPUT",
  "R0_ONLY",
  "PERMISSION_DENIED",
  "AUDIT_UNAVAILABLE",
  "REDACTION_UNSAFE",
  "QUOTA_EXCEEDED",
  "CANCELLED",
  "SANDBOX_FAILURE",
] as const;
export type CodeModeFailureCode = typeof CODE_MODE_FAILURE_CODES[number];

export interface CodeModeWorkerData {
  role: "malahor-code-mode-worker";
  protocol: 1;
}

interface StartMessage {
  version: 1;
  type: "start";
  executionRef: string;
  code: string;
  tools: CodeModeLogicalTool[];
}

interface ResultMessage {
  version: 1;
  type: "result";
  executionRef: string;
  callID: string;
  index: number;
  ok: boolean;
  value?: unknown;
  error?: { code: CodeModeFailureCode; message: string };
}

interface CancelMessage {
  version: 1;
  type: "cancel";
  executionRef: string;
}

interface PendingCall {
  tool: CodeModeLogicalTool;
  index: number;
  resolve(value: CodeModeJson): void;
  reject(error: Error): void;
}

export function isCodeModeWorkerData(value: unknown): value is CodeModeWorkerData {
  return exactRecord(value, ["role", "protocol"])
    && value.role === "malahor-code-mode-worker"
    && value.protocol === CODE_MODE_RPC_VERSION;
}

/** Entry point ejecutado solo por el bundle cargado con workerData.role. */
export async function runCodeModeWorker(data: unknown = workerData): Promise<void> {
  if (!isCodeModeWorkerData(data) || !parentPort) return;
  const port = parentPort;
  const start = await waitForStart(port);
  const abort = new AbortController();
  const pending = new Map<string, PendingCall>();
  let nextIndex = 0;
  let aggregateBytes = 0;
  let brokerFailure: CodeModeFailureCode | undefined;
  let cancelled = false;

  const interrupt = (code: CodeModeFailureCode): void => {
    brokerFailure = code;
    if (code === "CANCELLED") cancelled = true;
    abort.abort();
    for (const call of pending.values()) call.reject(new Error(code));
    pending.clear();
  };

  const onMessage = (message: unknown): void => {
    if (isCancelMessage(message, start.executionRef)) {
      interrupt("CANCELLED");
      return;
    }
    const result = parseResultMessage(message, start.executionRef);
    if (!result) {
      interrupt("SANDBOX_FAILURE");
      return;
    }
    const call = pending.get(result.callID);
    if (!call || call.index !== result.index) {
      interrupt("SANDBOX_FAILURE");
      return;
    }
    pending.delete(result.callID);
    if (!result.ok) {
      const code = result.error?.code ?? "SANDBOX_FAILURE";
      brokerFailure = code;
      call.reject(new Error(code));
      if (fatalBrokerFailure(code)) interrupt(code);
      return;
    }
    try {
      const sanitized = sanitizeCodeModeBoundary(result.value, {
        limits: boundaryLimits(CODE_MODE_LIMITS.callOutputBytes),
        redactSecrets: true,
        dropHostMetadata: true,
        dropDangerousKeys: true,
        truncate: false,
      });
      aggregateBytes += sanitized.bytes;
      if (aggregateBytes > CODE_MODE_LIMITS.aggregateOutputBytes) {
        throw new CodeModeBoundaryError("QUOTA_EXCEEDED", "Aggregate output exceeded.");
      }
      call.resolve(sanitized.value);
    } catch (error) {
      const code: CodeModeFailureCode = error instanceof CodeModeBoundaryError && error.code === "QUOTA_EXCEEDED"
        ? "QUOTA_EXCEEDED"
        : "REDACTION_UNSAFE";
      call.reject(new Error(code));
      interrupt(code);
    }
  };
  port.on("message", onMessage);

  const rpc = (tool: CodeModeLogicalTool, input: unknown): Promise<CodeModeJson> => {
    if (abort.signal.aborted) return Promise.reject(new Error("CANCELLED"));
    const canonical = validateToolInput(tool, input);
    const inputBytes = codeModeUtf8Bytes(JSON.stringify(canonical));
    if (inputBytes > CODE_MODE_LIMITS.callInputBytes) return Promise.reject(new Error("QUOTA_EXCEEDED"));
    const index = nextIndex;
    nextIndex += 1;
    const callID = `call_${index}`;
    return new Promise<CodeModeJson>((resolve, reject) => {
      pending.set(callID, { tool, index, resolve, reject });
      try {
        port.postMessage({
          version: CODE_MODE_RPC_VERSION,
          type: "call",
          executionRef: start.executionRef,
          callID,
          index,
          tool,
          input: canonical,
        });
      } catch {
        pending.delete(callID);
        interrupt("SANDBOX_FAILURE");
        reject(new Error("SANDBOX_FAILURE"));
      }
    });
  };

  try {
    const tools: Record<string, ReturnType<typeof createRpcTool>> = {};
    for (const name of start.tools) tools[`repo.${name}`] = createRpcTool(name, rpc);
    let result: unknown = await Effect.runPromise(CodeMode.execute({
      code: start.code,
      tools,
      extensions: [],
      bindings: {},
      limits: {
        timeoutMs: CODE_MODE_LIMITS.interpreterMs,
        maxToolCalls: CODE_MODE_LIMITS.maxToolCalls,
        maxOutputBytes: CODE_MODE_LIMITS.resultBytes,
      },
    }), { signal: abort.signal });
    if (isRecord(result) && result.ok === false && isRecord(result.error)
      && result.error.kind === "ToolFailure" && brokerFailure) {
      result = workerFailureResult(brokerFailure);
    }
    const sanitized = sanitizeWorkerResult(result);
    port.postMessage({
      version: CODE_MODE_RPC_VERSION,
      type: "finish",
      executionRef: start.executionRef,
      result: sanitized.value,
      redacted: sanitized.redacted,
      redactions: sanitized.redactions,
      truncated: sanitized.truncated,
    });
  } catch {
    if (!cancelled) {
      const code = brokerFailure ?? (abort.signal.aborted ? "SANDBOX_FAILURE" : "SANDBOX_FAILURE");
      const sanitized = sanitizeWorkerResult(workerFailureResult(code));
      port.postMessage({
        version: CODE_MODE_RPC_VERSION,
        type: "finish",
        executionRef: start.executionRef,
        result: sanitized.value,
        redacted: sanitized.redacted,
        redactions: sanitized.redactions,
        truncated: sanitized.truncated,
      });
    }
  } finally {
    port.off("message", onMessage);
    for (const call of pending.values()) call.reject(new Error("CANCELLED"));
    pending.clear();
    port.close();
  }
}

function createRpcTool(
  name: CodeModeLogicalTool,
  rpc: (tool: CodeModeLogicalTool, input: unknown) => Promise<CodeModeJson>,
) {
  return Tool.make({
    description: toolDescription(name),
    input: toolInputSchema(name),
    output: {},
    execute: (input) => Effect.tryPromise({
      try: () => rpc(name, input),
      catch: (cause) => toolError("Broker rejected the read-only call.", cause),
    }),
  });
}

function toolDescription(name: CodeModeLogicalTool): string {
  if (name === "read") return "Read a bounded UTF-8 text file inside the registered project.";
  if (name === "glob") return "Find bounded relative project paths without hidden files.";
  return "Find bounded text matches inside the registered project.";
}

function toolInputSchema(name: CodeModeLogicalTool): Record<string, unknown> {
  if (name === "read") return {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: CODE_MODE_LIMITS.readLines },
    },
    required: ["path"],
    additionalProperties: false,
  };
  if (name === "glob") return {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: CODE_MODE_LIMITS.globResults },
    },
    required: ["pattern"],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      include: { type: "string" },
      literal: { type: "boolean" },
      caseSensitive: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: CODE_MODE_LIMITS.grepResults },
    },
    required: ["pattern"],
    additionalProperties: false,
  };
}

function validateToolInput(tool: CodeModeLogicalTool, value: unknown): Record<string, CodeModeJson> {
  const allowed = tool === "read" ? ["path", "offset", "limit"]
    : tool === "glob" ? ["pattern", "path", "limit"]
      : ["pattern", "path", "include", "literal", "caseSensitive", "limit"];
  if (!exactRecord(value, allowed, true)) throw new Error("INVALID_INPUT");
  const input = value as Record<string, unknown>;
  const required = tool === "read" ? "path" : "pattern";
  if (typeof input[required] !== "string" || !(input[required] as string).trim()) throw new Error("INVALID_INPUT");
  for (const key of ["path", "pattern", "include"]) {
    if (input[key] !== undefined && typeof input[key] !== "string") throw new Error("INVALID_INPUT");
  }
  for (const key of ["literal", "caseSensitive"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error("INVALID_INPUT");
  }
  const maximum = tool === "read" ? CODE_MODE_LIMITS.readLines
    : tool === "glob" ? CODE_MODE_LIMITS.globResults : CODE_MODE_LIMITS.grepResults;
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1
    || (input.limit as number) > maximum)) throw new Error("INVALID_INPUT");
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0)) {
    throw new Error("INVALID_INPUT");
  }
  return input as Record<string, CodeModeJson>;
}

async function waitForStart(port: NonNullable<typeof parentPort>): Promise<StartMessage> {
  return new Promise<StartMessage>((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      try {
        const parsed = parseStartMessage(message);
        port.off("message", onMessage);
        resolve(parsed);
      } catch (error) {
        port.off("message", onMessage);
        reject(error);
      }
    };
    port.on("message", onMessage);
  });
}

function parseStartMessage(value: unknown): StartMessage {
  if (!exactRecord(value, ["version", "type", "executionRef", "code", "tools"])) throw new Error("SANDBOX_FAILURE");
  if (value.version !== CODE_MODE_RPC_VERSION || value.type !== "start"
    || typeof value.executionRef !== "string" || !/^exec_[A-Za-z0-9_-]{16,128}$/.test(value.executionRef)
    || typeof value.code !== "string" || codeModeUtf8Bytes(value.code) > CODE_MODE_LIMITS.codeBytes
    || !Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > CODE_MODE_LOGICAL_TOOLS.length) {
    throw new Error("SANDBOX_FAILURE");
  }
  const tools = value.tools.filter((item): item is CodeModeLogicalTool => (
    typeof item === "string" && CODE_MODE_LOGICAL_TOOLS.includes(item as CodeModeLogicalTool)
  ));
  if (tools.length !== value.tools.length || new Set(tools).size !== tools.length) throw new Error("SANDBOX_FAILURE");
  return { version: 1, type: "start", executionRef: value.executionRef, code: value.code, tools };
}

function parseResultMessage(value: unknown, executionRef: string): ResultMessage | undefined {
  if (!isRecord(value) || value.version !== CODE_MODE_RPC_VERSION || value.type !== "result" || value.executionRef !== executionRef
    || typeof value.callID !== "string" || !/^call_[0-9]+$/.test(value.callID)
    || !Number.isSafeInteger(value.index) || (value.index as number) < 0 || typeof value.ok !== "boolean") return undefined;
  if (value.ok === true) {
    if (!exactRecord(value, ["version", "type", "executionRef", "callID", "index", "ok", "value"])) return undefined;
  } else {
    if (!exactRecord(value, ["version", "type", "executionRef", "callID", "index", "ok", "error"])
      || !exactRecord(value.error, ["code", "message"])
      || typeof value.error.code !== "string" || !isFailureCode(value.error.code)
      || typeof value.error.message !== "string" || value.error.message.length > 240) return undefined;
  }
  return value as unknown as ResultMessage;
}

function isCancelMessage(value: unknown, executionRef: string): value is CancelMessage {
  return exactRecord(value, ["version", "type", "executionRef"])
    && value.version === CODE_MODE_RPC_VERSION
    && value.type === "cancel"
    && value.executionRef === executionRef;
}

function boundaryLimits(maxBytes: number) {
  return {
    maxDepth: CODE_MODE_LIMITS.maxDepth,
    maxProperties: CODE_MODE_LIMITS.maxProperties,
    maxItems: CODE_MODE_LIMITS.maxItems,
    maxBytes,
  };
}

function sanitizeWorkerResult(value: unknown) {
  try {
    return sanitizeCodeModeBoundary(value, {
      limits: boundaryLimits(CODE_MODE_LIMITS.resultBytes),
      redactSecrets: true,
      dropHostMetadata: true,
      dropDangerousKeys: true,
      truncate: false,
    });
  } catch (error) {
    const code: CodeModeFailureCode = error instanceof CodeModeBoundaryError && error.code === "QUOTA_EXCEEDED"
      ? "QUOTA_EXCEEDED"
      : "REDACTION_UNSAFE";
    return sanitizeCodeModeBoundary(workerFailureResult(code), {
      limits: boundaryLimits(CODE_MODE_LIMITS.resultBytes),
      redactSecrets: true,
      dropHostMetadata: true,
      dropDangerousKeys: true,
      truncate: false,
    });
  }
}

function workerFailureResult(code: CodeModeFailureCode): CodeModeJson {
  return {
    ok: false,
    error: { kind: code, message: "The confined execution failed." },
    toolCalls: [],
  };
}

function fatalBrokerFailure(code: CodeModeFailureCode): boolean {
  return [
    "AUDIT_UNAVAILABLE", "CATALOG_DRIFT", "SCOPE_DRIFT", "POLICY_DRIFT", "REDACTION_UNSAFE",
    "QUOTA_EXCEEDED", "SANDBOX_FAILURE", "CANCELLED",
  ].includes(code);
}

function isFailureCode(value: string): value is CodeModeFailureCode {
  return CODE_MODE_FAILURE_CODES.includes(value as CodeModeFailureCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], optional = false): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const own = Object.keys(value);
  if (own.some((key) => !keys.includes(key))) return false;
  return optional || keys.every((key) => Object.hasOwn(value, key));
}
