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
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      buffer = Buffer.alloc(0);
      return;
    }

    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;

    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    handleMessage(JSON.parse(body) as RpcMessage);
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
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
