import type { Readable, Writable } from "node:stream";

import { HorielError } from "../core";
import type { HorielToolDispatcher } from "./dispatch";
import { horielToolDefinitions, type HorielToolDefinition } from "./tool-definitions";

const MAX_MESSAGE_BYTES = 1024 * 1024;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface RunHorielMcpServerInput {
  dispatcher: HorielToolDispatcher;
  definitions?: HorielToolDefinition[];
  input?: Readable;
  output?: Writable;
}

export async function runHorielMcpServer(options: RunHorielMcpServerInput): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const definitions = options.definitions ?? horielToolDefinitions;
  let buffer = Buffer.alloc(0);
  let droppingOversized = false;
  let queue = Promise.resolve();

  const enqueue = (operation: () => Promise<void> | void): void => {
    queue = queue.then(operation).catch(() => {
      writeError(output, null, -32603, "Internal Horiel MCP error.");
    });
  };

  input.on("data", (raw: Buffer | string) => {
    let chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (droppingOversized) {
      const boundary = chunk.indexOf(10);
      if (boundary === -1) return;
      droppingOversized = false;
      chunk = chunk.subarray(boundary + 1);
    }
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      const boundary = buffer.indexOf(10);
      if (boundary === -1) break;
      const line = buffer.subarray(0, boundary);
      buffer = buffer.subarray(boundary + 1);
      if (line.length > MAX_MESSAGE_BYTES) {
        enqueue(() => writeError(output, null, -32700, "Horiel MCP message exceeds 1 MiB."));
      } else if (line.toString("utf8").replace(/\r$/, "").trim()) {
        enqueue(() => handleLine(line, options.dispatcher, definitions, output));
      }
    }
    if (buffer.length > MAX_MESSAGE_BYTES) {
      buffer = Buffer.alloc(0);
      droppingOversized = true;
      enqueue(() => writeError(output, null, -32700, "Horiel MCP message exceeds 1 MiB."));
    }
  });

  await new Promise<void>((resolve, reject) => {
    input.once("end", () => {
      if (!droppingOversized && buffer.toString("utf8").trim()) {
        const finalLine = buffer;
        enqueue(() => handleLine(finalLine, options.dispatcher, definitions, output));
      }
      queue.then(resolve, reject);
    });
    input.once("error", reject);
  });
}

async function handleLine(
  line: Buffer,
  dispatcher: HorielToolDispatcher,
  definitions: HorielToolDefinition[],
  output: Writable,
): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line.toString("utf8")) as JsonRpcRequest;
  } catch {
    writeError(output, null, -32700, "Invalid JSON-RPC payload.");
    return;
  }
  if (!isRecord(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    writeError(output, requestId(request), -32600, "Invalid JSON-RPC request.");
    return;
  }

  const id = requestId(request);
  if (request.method === "notifications/initialized") return;
  try {
    switch (request.method) {
      case "initialize":
        writeResult(output, id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "horiel", version: "1" },
        });
        return;
      case "ping":
        writeResult(output, id, {});
        return;
      case "tools/list":
        writeResult(output, id, { tools: definitions });
        return;
      case "resources/list":
        writeResult(output, id, { resources: [] });
        return;
      case "resources/templates/list":
        writeResult(output, id, { resourceTemplates: [] });
        return;
      case "prompts/list":
        writeResult(output, id, { prompts: [] });
        return;
      case "tools/call": {
        const params = request.params;
        if (!isRecord(params) || typeof params.name !== "string"
          || (params.arguments !== undefined && !isRecord(params.arguments))) {
          writeError(output, id, -32602, "Invalid Horiel tool call.", "invalid_input");
          return;
        }
        const envelope = isRecord(params._meta) && typeof params._meta.approval === "string"
          ? { approval: params._meta.approval }
          : {};
        const result = await dispatcher(params.name, (params.arguments ?? {}) as Record<string, unknown>, envelope);
        writeResult(output, id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
        return;
      }
      default:
        writeError(output, id, -32601, "JSON-RPC method is not supported.");
    }
  } catch (error) {
    const code = error instanceof HorielError ? error.code : "unavailable";
    const message = error instanceof HorielError ? error.message : "Horiel integration is unavailable.";
    writeError(output, id, -32000, message, code);
  }
}

function writeResult(output: Writable, id: string | number | null, result: unknown): void {
  output.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(
  output: Writable,
  id: string | number | null,
  code: number,
  message: string,
  domainCode?: string,
): void {
  output.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(domainCode ? { data: { code: domainCode } } : {}),
    },
  })}\n`);
}

function requestId(value: unknown): string | number | null {
  if (!isRecord(value)) return null;
  return typeof value.id === "string" || typeof value.id === "number" || value.id === null ? value.id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
