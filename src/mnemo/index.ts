import { callTool, toolDefinitions } from "./tools";

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});

function readMessages(): void {
  while (buffer.length > 0) {
    const lineEnd = buffer.indexOf("\n");
    if (lineEnd === -1) return;

    const line = buffer.subarray(0, lineEnd).toString("utf8").replace(/\r$/, "");
    buffer = buffer.subarray(lineEnd + 1);

    if (!line.trim()) continue;
    handleMessage(JSON.parse(line) as RpcMessage);
  }
}

function handleMessage(message: RpcMessage): void {
  if (!message.method) return;

  try {
    switch (message.method) {
      case "initialize":
        respond(message.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mnemo", version: "0.0.0" },
        });
        return;
      case "notifications/initialized":
        return;
      case "tools/list":
        respond(message.id, { tools: toolDefinitions });
        return;
      case "tools/call":
        respond(message.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(callTool(message.params as { name: string; arguments?: Record<string, unknown> }), null, 2),
            },
          ],
        });
        return;
      case "ping":
        respond(message.id, {});
        return;
      case "resources/list":
        respond(message.id, { resources: [] });
        return;
      case "resources/templates/list":
        respond(message.id, { resourceTemplates: [] });
        return;
      case "prompts/list":
        respond(message.id, { prompts: [] });
        return;
      default:
        respondError(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    respondError(message.id, -32000, (error as Error).message);
  }
}

function respond(id: RpcMessage["id"], result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id: RpcMessage["id"], code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
