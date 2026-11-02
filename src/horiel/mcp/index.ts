import { HorielError } from "../core";
import { createHorielRuntime } from "../integration";
import { createHorielToolDispatcher } from "./dispatch";
import { runHorielMcpServer } from "./server";

async function main(): Promise<void> {
  const runtime = await createHorielRuntime(process.env);
  try {
    const dispatcher = createHorielToolDispatcher({ core: runtime.core, guard: runtime.guard });
    await runHorielMcpServer({ dispatcher });
  } finally {
    await runtime.close();
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof HorielError ? error.code : "unavailable";
  process.stderr.write(`Horiel MCP startup failed (${code}).\n`);
  process.exitCode = 1;
}
