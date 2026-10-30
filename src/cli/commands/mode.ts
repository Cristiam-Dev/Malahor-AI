import { createInterface } from "node:readline/promises";

import { applyModeChange, modeName, parseModeName, previewModeChange } from "../core/mode";
import { assertModeWriteAllowed } from "../core/mode-hooks";
import { loadConfig } from "../core/config";

export interface ModeOptions {
  action: string;
  args: string[];
  approval?: string;
  yes: boolean;
}

export async function runMode(options: ModeOptions): Promise<void> {
  const { action, args } = options;
  if (action === "status" && args.length === 0) {
    const config = loadConfig();
    process.stdout.write(`Modo efectivo: ${modeName(config.execution.intervention)} (${config.execution.intervention})\nArchivo: ${config.paths.configFile}\n`);
    return;
  }
  if ((action !== "preview" && action !== "set") || args.length !== 1) {
    throw new Error("Uso: malahor-ai mode status | preview <asesor|asistente|ejecutor> | set <modo> [--yes]");
  }
  const target = parseModeName(args[0]);
  if (action === "preview") {
    if (options.yes || options.approval) throw new Error("preview no acepta confirmacion ni aprobacion.");
    const plan = previewModeChange(target);
    process.stdout.write(`Modo actual: ${plan.current}\nModo propuesto: ${plan.target}\nArchivo: ${plan.configFile}\n`);
    for (const change of plan.changes) process.stdout.write(`- ${change}\n`);
    process.stdout.write(plan.changes.length ? `Para aplicar: malahor-ai mode set ${plan.target}\n` : "Sin cambios.\n");
    return;
  }
  const env = process.env;
  const cwd = process.cwd();
  const plan = previewModeChange(target, env, cwd);
  process.stdout.write(`Modo actual: ${plan.current}\nModo propuesto: ${plan.target}\nArchivo: ${plan.configFile}\n`);
  for (const change of plan.changes) process.stdout.write(`- ${change}\n`);
  if (plan.changes.length === 0) {
    process.stdout.write("Sin cambios.\n");
    return;
  }
  if (!options.yes) await confirmInTerminal();
  const result = applyModeChange(target, plan.version, (file, backups) =>
    assertModeWriteAllowed(file, backups, cwd, env, "cli", options.approval), env, cwd);
  process.stdout.write(`Modo persistido: ${result.mode}\nArchivo: ${result.configFile}\nRespaldo: ${result.backup ?? "archivo nuevo"}\nActivo desde el siguiente turno; no necesitas abrir otra sesion.\n`);
}

async function confirmInTerminal(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Cambiar el modo sin TTY requiere --yes; los guardrails siguen vigentes.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("¿Aplicar este cambio de modo? [s/N]: ")).trim().toLowerCase();
    if (!["s", "si", "sí", "y", "yes"].includes(answer)) throw new Error("Cambio de modo cancelado.");
  } finally {
    rl.close();
  }
}
