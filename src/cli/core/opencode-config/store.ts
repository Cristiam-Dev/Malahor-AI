import fs from "node:fs";
import path from "node:path";
import { replaceAtomically } from "./io";
import type { ConfigLocation, ConfigTransaction } from "./types";

export function backupsRoot(location: ConfigLocation): string {
  return location.backupsDir ?? path.join(path.resolve(location.opencodeDir), ".malahor-config-backups");
}

export function writeTransaction(transactionDirectory: string, transaction: ConfigTransaction): void {
  replaceAtomically(path.join(transactionDirectory, "transaction.json"), `${JSON.stringify(transaction, null, 2)}\n`, `${transaction.id}-tx`);
}

export function scanTransactions(location: ConfigLocation): ConfigTransaction[] {
  const root = backupsRoot(location);
  if (!fs.existsSync(root)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const transactions: ConfigTransaction[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, "transaction.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ConfigTransaction;
      if (parsed.version !== 1 || typeof parsed.id !== "string" || typeof parsed.state !== "string") throw new Error("transaction.json invalido");
      transactions.push(parsed);
    } catch {
      transactions.push(brokenTransaction(path.join(root, entry.name), entry.name));
    }
  }

  return transactions.sort((left, right) => right.createdAt - left.createdAt);
}

export function pendingTransactions(location: ConfigLocation): ConfigTransaction[] {
  return scanTransactions(location).filter((transaction) => transaction.state === "prepared" || transaction.state === "recovery-required");
}

function brokenTransaction(directory: string, id: string): ConfigTransaction {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(directory).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  return {
    version: 1,
    id,
    createdAt: mtimeMs,
    updatedAt: mtimeMs,
    directory,
    sourcePath: "",
    targetPath: "",
    disabledPath: "",
    sourceHash: "",
    targetHash: "",
    mergedHash: "",
    sourceMode: 0,
    targetMode: 0,
    state: "recovery-required",
    note: "transaction.json ilegible; revisar manualmente",
  };
}
