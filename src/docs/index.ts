import { loadConfig } from "../cli/core/config";
import { openDocsClient } from "./client";
import { resolveDocsProject } from "./resolver";
import { appendDoc, listDocs, moveDoc, readDoc, searchDocs, writeDoc } from "./store";
import { docsToolDefinitions } from "./tool-definitions";

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const MAX_MESSAGE_BYTES = 3 * 1024 * 1024;
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
  if (buffer.length > MAX_MESSAGE_BYTES) {
    buffer = Buffer.alloc(0);
    respondError(null, -32700, "Mensaje JSON-RPC excede 3 MiB.");
  }
});

function readMessages(): void {
  while (buffer.length > 0) {
    const lineEnd = buffer.indexOf("\n");
    if (lineEnd === -1) return;
    const lineBytes = buffer.subarray(0, lineEnd);
    buffer = buffer.subarray(lineEnd + 1);
    if (!lineBytes.length) continue;
    if (lineBytes.length > MAX_MESSAGE_BYTES) {
      respondError(null, -32700, "Mensaje JSON-RPC excede 3 MiB.");
      continue;
    }
    try { handleMessage(JSON.parse(decodeMessage(lineBytes).replace(/\r$/, "")) as RpcMessage); }
    catch (error) { respondError(null, -32700, error instanceof SyntaxError ? "JSON-RPC invalido." : "Mensaje no procesable."); }
  }
}

function handleMessage(message: RpcMessage): void {
  if (!message.method) return;
  try {
    switch (message.method) {
      case "initialize":
        respond(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "malahor-docs", version: "1.0.0" } });
        return;
      case "notifications/initialized": return;
      case "tools/list": respond(message.id, { tools: docsToolDefinitions }); return;
      case "tools/call": {
        try {
          respond(message.id, { content: [{ type: "text", text: JSON.stringify(callTool(message.params), null, 2) }] });
        } catch (error) {
          respond(message.id, {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          });
        }
        return;
      }
      case "ping": respond(message.id, {}); return;
      case "resources/list": respond(message.id, { resources: [] }); return;
      case "resources/templates/list": respond(message.id, { resourceTemplates: [] }); return;
      case "prompts/list": respond(message.id, { prompts: [] }); return;
      default: respondError(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    respondError(message.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

export function callTool(params: Record<string, unknown> | undefined): unknown {
  const name = requiredString(params?.name, "name");
  const args = requiredRecord(params?.arguments, "arguments");
  assertToolArguments(name, args);
  const project = requiredString(args.project, "project");
  const config = loadConfig({ ...process.env, MALAHOR_OPENCODE_DETECT: "0" }, process.cwd());
  const resolution = resolveDocsProject(config.paths, config.projects.aliases, project);
  switch (name) {
    case "resolve": return resolution;
    case "list": return listDocs(resolution, optionalString(args.path, "path") ?? "");
    case "read": return readDoc(resolution, requiredString(args.path, "path"));
    case "search": return searchDocs(resolution, requiredString(args.query, "query"), optionalLimit(args.limit) ?? 20);
    case "write": return writeDoc(resolution, requiredString(args.path, "path"), requiredString(args.content, "content"), writeOptions(args));
    case "append": return appendDoc(resolution, requiredString(args.path, "path"), requiredString(args.content, "content"), writeOptions(args));
    case "move": return moveDoc(resolution, requiredString(args.source, "source"), requiredString(args.destination, "destination"), requiredString(args.ifMatch, "ifMatch"));
    case "open": return openDocsClient(resolution, {
      path: optionalString(args.path, "path"),
      app: optionalString(args.app, "app"),
      configuredClient: config.docs.client,
    });
    default: throw new Error(`Tool docs desconocida: ${name}`);
  }
}

function writeOptions(args: Record<string, unknown>): { ifMatch?: string; ifNoneMatch?: "*" } {
  const ifMatch = optionalString(args.ifMatch, "ifMatch");
  if (args.ifNoneMatch !== undefined && args.ifNoneMatch !== "*") throw new Error("ifNoneMatch solo acepta '*'.");
  const ifNoneMatch = args.ifNoneMatch === "*" ? "*" as const : undefined;
  return { ...(ifMatch ? { ifMatch } : {}), ...(ifNoneMatch ? { ifNoneMatch } : {}) };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || (!value && name !== "content")) throw new Error(`${name} debe ser string${name === "content" ? "" : " no vacio"}.`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} debe ser string.`);
  return value;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("limit debe ser un entero entre 1 y 50.");
  }
  return value;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} debe ser un objeto.`);
  return value as Record<string, unknown>;
}

function assertToolArguments(name: string, args: Record<string, unknown>): void {
  const allowed: Record<string, readonly string[]> = {
    resolve: ["project"],
    list: ["project", "path"],
    read: ["project", "path"],
    search: ["project", "query", "limit"],
    write: ["project", "path", "content", "ifMatch", "ifNoneMatch"],
    append: ["project", "path", "content", "ifMatch", "ifNoneMatch"],
    move: ["project", "source", "destination", "ifMatch"],
    open: ["project", "path", "app"],
  };
  const keys = allowed[name];
  if (!keys) throw new Error(`Tool docs desconocida: ${name}`);
  const unknown = Object.keys(args).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`Argumentos desconocidos para docs_${name}: ${unknown.join(", ")}.`);
}

function decodeMessage(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function respond(id: RpcMessage["id"], result: unknown): void {
  if (id === undefined) return;
  writeMessage({ jsonrpc: "2.0", id, result });
}
function respondError(id: RpcMessage["id"], code: number, message: string): void {
  if (id === undefined) return;
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}
function writeMessage(message: unknown): void { process.stdout.write(`${JSON.stringify(message)}\n`); }
