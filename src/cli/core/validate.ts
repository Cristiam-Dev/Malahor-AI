import fs from "node:fs";
import path from "node:path";

import { readOpenCodeConfig } from "./injector";
import { MALAHOR_COMMAND_FILES } from "./opencode-commands";
import type { MalahorPackagePaths } from "./package";
import type { MalahorPaths } from "./paths";

// Validacion interna agent-safe: se corre antes de aplicar politica para no bloquear
// a un agente con una instalacion a medias. Devuelve la lista de problemas encontrados.
export function validateInstallation(paths: MalahorPaths, packagePaths: MalahorPackagePaths | null): string[] {
  const problems: string[] = [];

  if (!fs.existsSync(paths.malahorHome)) {
    problems.push(`Malahor home falta: ${paths.malahorHome}`);
  }
  if (!fs.existsSync(paths.mnemoIndex)) {
    problems.push(`Mnemo index falta: ${paths.mnemoIndex} (corre \`bun run build\` o usa --bootstrap)`);
  }
  if (!fs.existsSync(paths.assetsDir)) {
    problems.push(`Assets faltan: ${paths.assetsDir}`);
  }
  if (!fs.existsSync(paths.agentsMd)) {
    problems.push(`AGENTS.md falta: ${paths.agentsMd}`);
  }

  const commandsDir = path.join(paths.opencodeDir, "commands");
  const missingCommands = MALAHOR_COMMAND_FILES.filter((file) => !fs.existsSync(path.join(commandsDir, file)));
  if (missingCommands.length > 0) {
    problems.push(`Comandos OpenCode faltan: ${missingCommands.join(", ")}`);
  }

  try {
    const config = readOpenCodeConfig(paths.opencodeConfig);
    const mcp = asRecord(config.mcp);
    const mnemo = mcp ? asRecord(mcp.mnemo) : undefined;

    if (!mnemo || mnemo.type !== "local" || !Array.isArray(mnemo.command) || mnemo.enabled !== true) {
      problems.push("mcp.mnemo no esta configurado correctamente");
    }

    const compaction = asRecord(config.compaction);
    if (!compaction || compaction.auto !== true) {
      problems.push("compaction.auto no esta habilitado");
    }
  } catch (error) {
    problems.push(`opencode.jsonc ilegible: ${(error as Error).message}`);
  }

  if (packagePaths && !fs.existsSync(packagePaths.mnemoBuild)) {
    problems.push(`Build mnemo del paquete falta: ${packagePaths.mnemoBuild}`);
  }

  return problems;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}
