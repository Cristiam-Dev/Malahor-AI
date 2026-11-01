import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify } from "jsonc-parser/lib/esm/main.js";

import { timestamp } from "./backup";
import { readConfigFile, type MalahorConfig } from "./config";
import type { DocsClient } from "../../docs/client";

/** Solo instalacion/update: conserva JSONC y comparte el lock con mode set. */
export function saveExecutionPolicy(config: MalahorConfig, dryRun: boolean): boolean {
  return saveConfigSection(config, "execution", { ...config.execution }, dryRun);
}

/** Preferencia global del host; conserva comentarios y crea backup como mode set. */
export function saveDocsClient(config: MalahorConfig, client: DocsClient, dryRun: boolean): boolean {
  return saveConfigSection(config, "docs", { client }, dryRun);
}

function saveConfigSection(
  config: MalahorConfig,
  section: "execution" | "docs",
  values: Record<string, unknown>,
  dryRun: boolean,
): boolean {
  if (dryRun) return true;
  const file = config.paths.configFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.mode.lock`;
  const descriptor = fs.openSync(lock, "wx", 0o600);
  let temporary: string | undefined;
  try {
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error("La configuracion debe ser un archivo regular.");
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const current = readConfigFile(file) as unknown as Record<string, unknown>;
    const existing = current[section] as Record<string, unknown> | undefined;
    if (Object.entries(values).every(([key, value]) => existing?.[key] === value)) return true;
    let next = raw || "{}\n";
    for (const [key, value] of Object.entries(values)) {
      next = applyEdits(next, modify(next, [section, key], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: next.includes("\r\n") ? "\r\n" : "\n" },
      }));
    }
    if (!next.endsWith("\n")) next += "\n";
    if (raw) {
      fs.mkdirSync(config.paths.backupsDir, { recursive: true, mode: 0o700 });
      const backup = path.join(config.paths.backupsDir, `${path.basename(file)}.${timestamp()}.${randomBytes(6).toString("hex")}.bak`);
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
    }
    temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, next, { flag: "wx", mode: 0o600 });
    if ((fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "") !== raw) throw new Error("La configuracion cambio durante la actualizacion.");
    fs.renameSync(temporary, file);
    temporary = undefined;
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
  return true;
}
