import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";

import { loadConfig, type MalahorIntervention } from "./config";
import { timestamp } from "./backup";

export type ModeName = "asesor" | "asistente" | "ejecutor";

export interface ModePreview {
  configFile: string;
  current: ModeName;
  target: ModeName;
  changes: string[];
  /** Version optimista interna; nunca se copia ni se muestra al usuario. */
  version: string;
}

export const MODE_CHANGE_ACTION = "malahor_mode_change";

export function modeName(intervention: MalahorIntervention): ModeName {
  switch (intervention) {
    case "acompanar": return "asesor";
    case "guiar": return "asistente";
    case "ejecutar": return "ejecutor";
  }
}

export function parseModeName(value: string): MalahorIntervention {
  switch (value) {
    case "asesor": return "acompanar";
    case "asistente": return "guiar";
    case "ejecutor": return "ejecutar";
    default: throw new Error("Modo invalido. Usa asesor, asistente o ejecutor.");
  }
}

/** Preview de solo lectura; version liga internamente la confirmacion nativa al estado observado. */
export function previewModeChange(target: MalahorIntervention, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ModePreview {
  const config = loadConfig(env, cwd);
  if (env.MALAHOR_EXECUTION_INTERVENTION !== undefined) {
    throw new Error("MALAHOR_EXECUTION_INTERVENTION sobreescribe el archivo: retira el override antes de cambiar el modo persistido.");
  }
  if (env.MALAHOR_MODE !== undefined && !hasConfiguredIntervention(config.paths.configFile)) {
    throw new Error("MALAHOR_MODE sobreescribe el fallback del archivo: retira el override antes de cambiar el modo persistido.");
  }
  const raw = readConfig(config.paths.configFile);
  const current = modeName(config.execution.intervention);
  const changes = target === config.execution.intervention ? [] : [
    `execution.intervention: ${config.execution.intervention} -> ${target}`,
    `modo efectivo: ${current} -> ${modeName(target)}`,
    "Se renueva execution.revision para invalidar todos los planes anteriores.",
    "El campo mode legado, otras claves y la verificacion persistida no se modifican.",
  ];
  return {
    configFile: config.paths.configFile, current, target: modeName(target), changes,
    version: hash(JSON.stringify(["malahor.mode.v2", config.paths.configFile, hash(raw), target, config.execution.revision])),
  };
}

/** Escribe tras confirmacion del caller; version es concurrencia interna, no confirmacion humana. */
export function applyModeChange(
  target: MalahorIntervention, expectedVersion: string, beforeWrite: (configFile: string, backupsDir: string) => void,
  env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(),
): { mode: ModeName; backup: string | null; configFile: string } {
  const plan = previewModeChange(target, env, cwd);
  if (!/^[a-f0-9]{64}$/.test(expectedVersion) || expectedVersion !== plan.version) {
    throw new Error("La configuracion cambio desde la confirmacion: repite el comando.");
  }
  if (plan.changes.length === 0) return { mode: plan.target, backup: null, configFile: plan.configFile };

  const config = loadConfig(env, cwd);
  beforeWrite(plan.configFile, config.paths.backupsDir);
  fs.mkdirSync(path.dirname(plan.configFile), { recursive: true, mode: 0o700 });
  assertSafePath(plan.configFile);
  assertSafePath(config.paths.backupsDir);
  const lock = `${plan.configFile}.mode.lock`;
  let lockFd: number;
  try {
    lockFd = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    throw new Error(`Cambio de modo bloqueado (lock activo o directorio inexistente): ${(error as Error).message}`);
  }
  let temporary: string | undefined;
  try {
    const fresh = previewModeChange(target, env, cwd);
    if (fresh.version !== expectedVersion) throw new Error("La configuracion cambio: repite el comando.");
    const raw = readConfig(plan.configFile);
    const revision = randomBytes(16).toString("hex");
    const after = editExecution(raw, target, revision);
    const backup = fs.existsSync(plan.configFile)
      ? path.join(config.paths.backupsDir, `${path.basename(plan.configFile)}.${timestamp()}.${randomBytes(6).toString("hex")}.bak`)
      : null;
    if (backup) {
      fs.mkdirSync(config.paths.backupsDir, { recursive: true, mode: 0o700 });
      assertSafePath(config.paths.backupsDir);
      fs.copyFileSync(plan.configFile, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
    }
    temporary = `${plan.configFile}.${randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, after, { flag: "wx", mode: 0o600 });
    if (readConfig(plan.configFile) !== raw) throw new Error("La configuracion cambio durante el respaldo: no se aplica.");
    fs.renameSync(temporary, plan.configFile);
    temporary = undefined;
    return { mode: modeName(target), backup, configFile: plan.configFile };
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}

function readConfig(file: string): string {
  assertSafePath(file);
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("La configuracion de Malahor debe ser archivo regular, no symlink.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  return fs.readFileSync(file, "utf8");
}

function hasConfiguredIntervention(file: string): boolean {
  const raw = readConfig(file);
  if (!raw) return false;
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors) as { execution?: { intervention?: unknown } } | undefined;
  if (errors.length > 0) throw new Error("Configuracion JSONC invalida; no se modifica.");
  return parsed?.execution?.intervention !== undefined;
}

function assertSafePath(file: string): void {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Ruta con symlink no permitida: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) break;
  }
}

function editExecution(raw: string, target: MalahorIntervention, revision: string): string {
  const source = raw || "{}\n";
  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors);
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Configuracion JSONC invalida; no se modifica.");
  }
  const current = parsed as Record<string, unknown>;
  if (current.execution !== undefined && (!current.execution || typeof current.execution !== "object" || Array.isArray(current.execution))) {
    throw new Error("execution debe ser objeto; no se modifica.");
  }
  let after = source;
  for (const [key, value] of [["intervention", target], ["revision", revision]] as const) {
    after = applyEdits(after, modify(after, ["execution", key], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" },
    }));
  }
  return after.endsWith("\n") ? after : `${after}\n`;
}

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
