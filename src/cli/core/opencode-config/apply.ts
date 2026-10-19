import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { digest, replaceAtomically, snapshot, writeExclusive, withConfigLock } from "./io";
import { previewConsolidation } from "./preview";
import { backupsRoot, scanTransactions, writeTransaction } from "./store";
import type { ApplyResult, ConfigLocation, ConfigTransaction, RollbackPlan } from "./types";

export function applyConsolidation(location: ConfigLocation, confirm: string): ApplyResult {
  const directory = path.resolve(location.opencodeDir);

  return withConfigLock(directory, () => {
    const plan = previewConsolidation(location);

    if (plan.state !== "ready" || !plan.source || !plan.target || !plan.merge || !plan.confirmation) {
      throw new Error(plan.state === "blocked"
        ? `Consolidacion bloqueada: ${plan.issue ?? "hay conflictos que requieren revision manual"}.`
        : "No hay un par opencode.json + opencode.jsonc que consolidar.");
    }

    if (plan.pending && plan.pending.length > 0) {
      throw new Error(`Hay transacciones sin cerrar (${plan.pending.join(", ")}); revisalas antes de consolidar.`);
    }

    if (confirm !== plan.confirmation) {
      throw new Error("El token de confirmacion no coincide con el estado actual; ejecuta `malahor-ai config` de nuevo.");
    }

    const sourceNow = snapshot(plan.source.path);
    const targetNow = snapshot(plan.target.path);

    if (sourceNow?.hash !== plan.source.hash || targetNow?.hash !== plan.target.hash) {
      throw new Error("La configuracion cambio entre el preview y la aplicacion; no se escribio nada.");
    }

    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const transactionDirectory = path.join(backupsRoot(location), id);
    fs.mkdirSync(transactionDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(transactionDirectory, 0o700);

    const sourceBackup = path.join(transactionDirectory, "opencode.json.backup");
    const targetBackup = path.join(transactionDirectory, "opencode.jsonc.backup");
    writeExclusive(sourceBackup, plan.source.text);
    writeExclusive(targetBackup, plan.target.text);

    if (snapshot(sourceBackup)?.hash !== plan.source.hash || snapshot(targetBackup)?.hash !== plan.target.hash) {
      throw new Error("Los respaldos no se pudieron verificar; se aborta sin tocar la configuracion.");
    }

    let transaction: ConfigTransaction = {
      version: 1,
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      directory,
      sourcePath: plan.source.path,
      targetPath: plan.target.path,
      disabledPath: `${plan.source.path}.disabled-${id}`,
      sourceHash: plan.source.hash,
      targetHash: plan.target.hash,
      mergedHash: digest(plan.merge.text),
      sourceMode: plan.source.mode,
      targetMode: plan.target.mode,
      state: "prepared",
    };
    writeTransaction(transactionDirectory, transaction);

    try {
      replaceAtomically(plan.target.path, plan.merge.text, id, plan.target.mode);
      if (snapshot(plan.target.path)?.hash !== transaction.mergedHash) {
        throw new Error("La verificacion posterior a la escritura fallo.");
      }
      fs.renameSync(plan.source.path, transaction.disabledPath);
      if (snapshot(transaction.disabledPath)?.hash !== transaction.sourceHash) {
        throw new Error("La verificacion del archivo retirado fallo.");
      }
    } catch (error) {
      const recovered = recoverOriginal(transaction, transactionDirectory);
      transaction = {
        ...transaction,
        state: recovered ? "rolled-back" : "recovery-required",
        updatedAt: Date.now(),
        note: recovered ? (error as Error).message : `${(error as Error).message}; recuperacion manual requerida`,
      };
      writeTransaction(transactionDirectory, transaction);
      throw new Error(recovered
        ? `La consolidacion fallo y se restauro el estado original (${(error as Error).message}).`
        : `La consolidacion fallo y no se pudo restaurar automaticamente (${(error as Error).message}); revisa ${transactionDirectory}.`);
    }

    transaction = { ...transaction, state: "applied", updatedAt: Date.now() };
    writeTransaction(transactionDirectory, transaction);

    return { transaction, backupsDir: transactionDirectory };
  });
}

export function buildRollbackPlan(location: ConfigLocation): RollbackPlan {
  const directory = path.resolve(location.opencodeDir);
  const transactions = scanTransactions(location);
  const pending = transactions.filter((transaction) => transaction.state === "prepared" || transaction.state === "recovery-required");

  if (pending.length > 0) {
    return { state: "blocked", directory, issue: `Hay transacciones sin cerrar (${pending.map((transaction) => transaction.id).join(", ")}); revisalas antes de revertir.` };
  }

  const applied = transactions.filter((transaction) => transaction.state === "applied");
  if (applied.length === 0) {
    return { state: "missing", directory, issue: "No hay una consolidacion aplicada que revertir." };
  }
  if (applied.length > 1) {
    return { state: "blocked", directory, issue: `Estado inesperado: ${applied.length} consolidaciones aplicadas (${applied.map((transaction) => transaction.id).join(", ")}); revision manual.` };
  }

  const transaction = applied[0];
  const transactionDirectory = path.join(backupsRoot(location), transaction.id);
  const sourceBackup = path.join(transactionDirectory, "opencode.json.backup");
  const targetBackup = path.join(transactionDirectory, "opencode.jsonc.backup");
  const issue = rollbackIssue(transaction, sourceBackup, targetBackup);

  if (issue) {
    return { state: "blocked", directory, transaction, issue };
  }

  const confirmation = `ROLLBACK:${digest(JSON.stringify({ id: transaction.id, target: transaction.mergedHash, source: transaction.sourceHash }))}`;
  return { state: "ready", directory, transaction, sourceBackup, targetBackup, confirmation };
}

export function applyRollback(location: ConfigLocation, confirm: string): ConfigTransaction {
  const directory = path.resolve(location.opencodeDir);

  return withConfigLock(directory, () => {
    const plan = buildRollbackPlan(location);

    if (plan.state !== "ready" || !plan.transaction || !plan.sourceBackup || !plan.targetBackup || !plan.confirmation) {
      throw new Error(plan.issue ?? "No hay una reversion disponible.");
    }
    if (confirm !== plan.confirmation) {
      throw new Error("El token de confirmacion no coincide con el estado actual; ejecuta `malahor-ai config rollback` de nuevo.");
    }

    const transaction = plan.transaction;
    const transactionDirectory = path.dirname(plan.sourceBackup);
    const targetBackup = snapshot(plan.targetBackup);

    if (!targetBackup || targetBackup.hash !== transaction.targetHash) {
      throw new Error("Respaldo de opencode.jsonc no verificado; reversion abortada.");
    }

    let next: ConfigTransaction;

    try {
      replaceAtomically(transaction.targetPath, targetBackup.text, `${transaction.id}-rb`, transaction.targetMode);
      if (snapshot(transaction.targetPath)?.hash !== transaction.targetHash) {
        throw new Error("No se pudo restaurar opencode.jsonc.");
      }
      if (fs.existsSync(transaction.sourcePath)) {
        throw new Error("opencode.json reaparecio durante la reversion.");
      }
      fs.renameSync(transaction.disabledPath, transaction.sourcePath);
      if (snapshot(transaction.sourcePath)?.hash !== transaction.sourceHash) {
        throw new Error("No se pudo restaurar opencode.json.");
      }
    } catch (error) {
      next = { ...transaction, state: "recovery-required", updatedAt: Date.now(), note: (error as Error).message };
      writeTransaction(transactionDirectory, next);
      throw new Error(`La reversion fallo a medias (${(error as Error).message}); revisa ${transactionDirectory} y restaura manualmente.`);
    }

    next = { ...transaction, state: "rolled-back", updatedAt: Date.now() };
    writeTransaction(transactionDirectory, next);

    return next;
  });
}

function recoverOriginal(transaction: ConfigTransaction, transactionDirectory: string): boolean {
  try {
    const targetBackup = snapshot(path.join(transactionDirectory, "opencode.jsonc.backup"));
    if (!targetBackup || targetBackup.hash !== transaction.targetHash) return false;

    if (snapshot(transaction.targetPath)?.hash !== transaction.targetHash) {
      replaceAtomically(transaction.targetPath, targetBackup.text, `${transaction.id}-recover`, transaction.targetMode);
    }
    if (snapshot(transaction.targetPath)?.hash !== transaction.targetHash) return false;

    if (fs.existsSync(transaction.disabledPath)) {
      if (fs.existsSync(transaction.sourcePath)) return false;
      fs.renameSync(transaction.disabledPath, transaction.sourcePath);
    }

    return snapshot(transaction.sourcePath)?.hash === transaction.sourceHash;
  } catch {
    return false;
  }
}

function rollbackIssue(transaction: ConfigTransaction, sourceBackup: string, targetBackup: string): string | undefined {
  if (snapshot(sourceBackup)?.hash !== transaction.sourceHash || snapshot(targetBackup)?.hash !== transaction.targetHash) {
    return "Los respaldos no coinciden con la transaccion; revision manual.";
  }
  if (snapshot(transaction.targetPath)?.hash !== transaction.mergedHash) {
    return "opencode.jsonc cambio despues de la consolidacion; revierte manualmente para no perder cambios nuevos.";
  }
  if (!fs.existsSync(transaction.disabledPath) || snapshot(transaction.disabledPath)?.hash !== transaction.sourceHash) {
    return "El opencode.json retirado no coincide con la transaccion; revision manual.";
  }
  if (fs.existsSync(transaction.sourcePath)) {
    return "opencode.json reaparecio despues de la consolidacion; revisa antes de revertir.";
  }
  return undefined;
}
