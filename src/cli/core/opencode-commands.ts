import fs from "node:fs";
import path from "node:path";

import type { MalahorPaths } from "./paths";

export const MALAHOR_COMMAND_FILES = ["recuperar-contexto.md", "guardar-contexto.md", "compactar-seguro.md"] as const;

export function syncOpenCodeCommands(sourceDir: string, paths: MalahorPaths, dryRun: boolean): { source: string; destination: string; files: number } {
  const destination = path.join(paths.opencodeDir, "commands");

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`No existe directorio de comandos OpenCode: ${sourceDir}`);
  }

  if (!dryRun) {
    fs.mkdirSync(destination, { recursive: true });
    for (const file of MALAHOR_COMMAND_FILES) {
      fs.copyFileSync(path.join(sourceDir, file), path.join(destination, file));
    }
  }

  return { source: sourceDir, destination, files: MALAHOR_COMMAND_FILES.length };
}

export function removeOpenCodeCommands(paths: MalahorPaths, dryRun: boolean): number {
  const destination = path.join(paths.opencodeDir, "commands");
  let removed = 0;

  for (const file of MALAHOR_COMMAND_FILES) {
    const filePath = path.join(destination, file);
    if (!fs.existsSync(filePath)) continue;
    removed += 1;
    if (!dryRun) fs.unlinkSync(filePath);
  }

  return removed;
}
