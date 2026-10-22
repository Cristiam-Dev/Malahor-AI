import { loadConfig } from "../core/config";
import { applyConsolidation, applyRollback, buildRollbackPlan } from "../core/opencode-config/apply";
import { applyV2ConfigMigration, previewV2ConfigMigration } from "../core/opencode-config/migrate";
import { previewConsolidation } from "../core/opencode-config/preview";
import type { ConfigConflict, ConfigLocation, ConfigSnapshot, ConsolidationPlan, RollbackPlan } from "../core/opencode-config/types";

export interface ConfigOptions {
  action: string;
  apply: boolean;
  dryRun: boolean;
  yes: boolean;
  confirm: string | undefined;
  json: boolean;
}

export function runConfig(options: ConfigOptions): void {
  switch (options.action || "status") {
    case "status":
      printStatus(options);
      return;
    case "consolidate":
      printConsolidate(options);
      return;
    case "rollback":
      printRollback(options);
      return;
    case "migrate":
      printMigrate(options);
      return;
    case "help":
    case "--help":
    case "-h":
      printConfigHelp();
      return;
    default:
      throw new Error(`Comando config invalido: ${options.action}. Usa status, consolidate, rollback, migrate o help.`);
  }
}

export function describePlan(plan: ConsolidationPlan): string[] {
  const lines: string[] = [`Directorio: ${plan.directory}`];

  if (plan.pending && plan.pending.length > 0) {
    lines.push(`Aviso: transacciones sin cerrar: ${plan.pending.join(", ")} (revisar backups)`);
  }

  switch (plan.state) {
    case "missing":
      lines.push("Estado: sin configuracion OpenCode; nada que consolidar.");
      break;
    case "single":
      lines.push(`Estado: un solo archivo (${plan.target ? "opencode.jsonc" : "opencode.json"}); no hay duplicados.`);
      break;
    case "blocked":
      lines.push("Estado: bloqueado; no se consolida automaticamente.");
      if (plan.issue) lines.push(`Motivo: ${plan.issue}`);
      for (const conflict of plan.merge?.conflicts ?? []) {
        lines.push(`- conflicto: ${conflict.path} (${reasonLabel(conflict.reason)})`);
      }
      break;
    case "ready":
      lines.push("Estado: listo para consolidar (opencode.json -> opencode.jsonc).");
      if (plan.source) lines.push(`Origen: ${plan.source.path} sha256=${shortHash(plan.source.hash)}`);
      if (plan.target) lines.push(`Destino: ${plan.target.path} sha256=${shortHash(plan.target.hash)}`);
      lines.push(`Claves a agregar: ${plan.merge?.additions.length ?? 0}`);
      for (const addition of plan.merge?.additions ?? []) lines.push(`- ${addition}`);
      lines.push(`Token: ${plan.confirmation ?? ""}`);
      lines.push("Para aplicar: malahor-ai config consolidate --apply --yes --confirm <token>");
      lines.push("Aviso: aplica sin sesiones activas de OpenCode; el bloqueo es cooperativo.");
      break;
  }

  return lines;
}

export function describeRollback(plan: RollbackPlan): string[] {
  const lines: string[] = [`Directorio: ${plan.directory}`];

  switch (plan.state) {
    case "missing":
      lines.push("Estado: no hay consolidacion aplicada que revertir.");
      break;
    case "blocked":
      lines.push("Estado: reversion bloqueada.");
      if (plan.issue) lines.push(`Motivo: ${plan.issue}`);
      break;
    case "ready":
      lines.push(`Estado: reversion lista (transaccion ${plan.transaction?.id ?? ""}).`);
      if (plan.transaction) {
        lines.push(`Restaurar: ${plan.transaction.targetPath} desde respaldo sha256=${shortHash(plan.transaction.targetHash)}`);
        lines.push(`Reactivar: ${plan.transaction.sourcePath} desde ${plan.transaction.disabledPath}`);
      }
      lines.push(`Token: ${plan.confirmation ?? ""}`);
      lines.push("Para revertir: malahor-ai config rollback --apply --yes --confirm <token>");
      break;
  }

  return lines;
}

export function planForJson(plan: ConsolidationPlan): Record<string, unknown> {
  return {
    state: plan.state,
    directory: plan.directory,
    source: snapshotForJson(plan.source),
    target: snapshotForJson(plan.target),
    additions: plan.merge?.additions ?? [],
    conflicts: plan.merge?.conflicts ?? [],
    confirmation: plan.state === "ready" ? plan.confirmation : undefined,
    issue: plan.issue,
    pending: plan.pending ?? [],
  };
}

export function rollbackForJson(plan: RollbackPlan): Record<string, unknown> {
  return {
    state: plan.state,
    directory: plan.directory,
    transaction: plan.transaction ? { id: plan.transaction.id, state: plan.transaction.state } : undefined,
    confirmation: plan.state === "ready" ? plan.confirmation : undefined,
    issue: plan.issue,
  };
}

function printStatus(options: ConfigOptions): void {
  const plan = previewConsolidation(location());

  if (options.json) {
    process.stdout.write(`${JSON.stringify(planForJson(plan), null, 2)}\n`);
  } else {
    process.stdout.write("\nmalahor-ai config\n=================\n");
    for (const line of describePlan(plan)) {
      process.stdout.write(`${line}\n`);
    }
  }

  if (plan.state === "blocked") {
    process.exitCode = 1;
  }
}

function printConsolidate(options: ConfigOptions): void {
  const target = location();
  const wantsApply = options.apply && !options.dryRun;

  if (!wantsApply) {
    const plan = previewConsolidation(target);
    process.stdout.write("\nmalahor-ai config consolidate (preview)\n=======================================\n");
    for (const line of describePlan(plan)) {
      process.stdout.write(`${line}\n`);
    }
    process.stdout.write("Sin --apply (con --yes --confirm <token>) no se escribe nada.\n");
    if (plan.state === "blocked") {
      process.exitCode = 1;
    }
    return;
  }

  if (!options.yes || !options.confirm) {
    throw new Error("Aplicar requiere --yes y --confirm <token>; el token lo entrega el preview.");
  }

  const result = applyConsolidation(target, options.confirm);
  process.stdout.write("\nmalahor-ai config consolidate\n=============================\n");
  process.stdout.write(`Consolidacion aplicada: ${result.transaction.id}\n`);
  process.stdout.write(`Destino actualizado: ${result.transaction.targetPath}\n`);
  process.stdout.write(`Origen retirado (no borrado): ${result.transaction.disabledPath}\n`);
  process.stdout.write(`Respaldos: ${result.backupsDir}\n`);
  process.stdout.write("Para revertir: malahor-ai config rollback\n");
}

function printRollback(options: ConfigOptions): void {
  const target = location();
  const wantsApply = options.apply && !options.dryRun;

  if (!wantsApply) {
    const plan = buildRollbackPlan(target);
    process.stdout.write("\nmalahor-ai config rollback (preview)\n====================================\n");
    for (const line of describeRollback(plan)) {
      process.stdout.write(`${line}\n`);
    }
    process.stdout.write("Sin --apply (con --yes --confirm <token>) no se escribe nada.\n");
    if (plan.state === "blocked") {
      process.exitCode = 1;
    }
    return;
  }

  if (!options.yes || !options.confirm) {
    throw new Error("Revertir requiere --yes y --confirm <token>; el token lo entrega el preview.");
  }

  const transaction = applyRollback(target, options.confirm);
  process.stdout.write("\nmalahor-ai config rollback\n==========================\n");
  process.stdout.write(`Reversion aplicada: ${transaction.id}\n`);
  process.stdout.write(`Restaurados: ${transaction.targetPath} y ${transaction.sourcePath}\n`);
  process.stdout.write(`Respaldos conservados: ${transaction.directory}/.malahor-config-backups/${transaction.id}\n`);
}

function printMigrate(options: ConfigOptions): void {
  const paths = loadConfig().paths;
  const wantsApply = options.apply && !options.dryRun;
  const plan = previewV2ConfigMigration(paths);

  if (!wantsApply) {
    process.stdout.write("\nmalahor-ai config migrate (preview)\n==================================\n");
    process.stdout.write(`Archivo: ${plan.path}\nEstado: ${plan.state}\n`);
    for (const finding of plan.findings) {
      process.stdout.write(`- ${finding.path}: ${finding.removable ? "migrable" : "revision manual"} — ${finding.reason}\n`);
    }
    if (plan.confirmation) process.stdout.write(`Token: ${plan.confirmation}\nPara aplicar: malahor-ai config migrate --apply --yes --confirm <token>\n`);
    if (plan.issue) process.stdout.write(`Motivo: ${plan.issue}\n`);
    process.stdout.write("Sin --apply (con --yes --confirm <token>) no se escribe nada.\n");
    if (plan.state === "blocked") process.exitCode = 1;
    return;
  }

  if (!options.yes || !options.confirm) {
    throw new Error("Aplicar migracion requiere --yes y --confirm <token>; el token lo entrega el preview.");
  }

  const result = applyV2ConfigMigration(paths, options.confirm);
  process.stdout.write("\nmalahor-ai config migrate\n==========================\n");
  process.stdout.write(`Migracion aplicada: ${result.removed.join(", ")}\n`);
  process.stdout.write(`Backup: ${result.backup ?? "no creado"}\n`);
}

function location(): ConfigLocation {
  return { opencodeDir: loadConfig().paths.opencodeDir };
}

function snapshotForJson(snapshot: ConfigSnapshot | undefined): Record<string, unknown> | undefined {
  if (!snapshot) return undefined;
  return { path: snapshot.path, hash: snapshot.hash, mode: snapshot.mode, bytes: Buffer.byteLength(snapshot.text, "utf8") };
}

function reasonLabel(reason: ConfigConflict["reason"]): string {
  switch (reason) {
    case "security-review":
      return "permisos/seguridad; revision manual";
    case "semantic-alias":
      return "alias V1/V2 ambiguo; revision manual";
    case "invalid-input":
      return "entrada invalida";
    default:
      return "valores distintos; revision manual";
  }
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function printConfigHelp(): void {
  process.stdout.write(`malahor-ai config

  Comandos:
  config status                     Revisa opencode.json vs opencode.jsonc (solo lectura)
  config consolidate                Preview de la consolidacion (no escribe)
  config consolidate --apply --yes --confirm <token>
  config rollback                   Preview de la reversion
  config rollback --apply --yes --confirm <token>
  config migrate                    Preview de restos Malahor legacy en V2
  config migrate --apply --yes --confirm <token>

La consolidacion conserva comentarios, respalda ambos originales y retira opencode.json
por renombrado reversible; nunca borra archivos ni fusiona reglas de seguridad.
`);
}
