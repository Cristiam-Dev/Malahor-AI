import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertInsideSandbox } from "./boundary";
import { fsyncDirectory, fsyncFile } from "./canonical";
import { migrationFailure, normalizeMigrationFailure } from "./errors";

export interface MigrationLock {
  release(): void;
}

export function acquireMigrationLock(input: {
  sandboxRoot: string;
  transactionDirectory: string;
  migrationId: string;
  allowStaleRecovery?: boolean;
}): MigrationLock {
  const lockPath = path.join(input.transactionDirectory, "migration.lock");
  assertInsideSandbox(input.sandboxRoot, lockPath);
  const token = randomBytes(24).toString("hex");
  try {
    writeLock(lockPath, input.migrationId, token);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw normalizeMigrationFailure(error, "busy", "Horiel migration lock is unavailable.");
    }
    if (!input.allowStaleRecovery || !recoverStaleLock(lockPath, input.migrationId)) {
      return migrationFailure("busy", "Horiel migration is already running.");
    }
    try {
      writeLock(lockPath, input.migrationId, token);
    } catch (retryError) {
      throw normalizeMigrationFailure(retryError, "busy", "Horiel migration lock is unavailable.");
    }
  }
  try {
    if (process.platform !== "win32") fs.chmodSync(lockPath, 0o600);
    fsyncFile(lockPath);
    fsyncDirectory(input.transactionDirectory);
  } catch (error) {
    throw normalizeMigrationFailure(error, "busy", "Horiel migration lock is unavailable.");
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: unknown };
        if (value.token !== token) return;
        fs.rmSync(lockPath, { force: true });
        fsyncDirectory(input.transactionDirectory);
      } catch {
        // Never remove a lock that cannot be proven to belong to this holder.
      }
    },
  };
}

function writeLock(lockPath: string, migrationId: string, token: string): void {
  fs.writeFileSync(lockPath, `${JSON.stringify({ migrationId, pid: process.pid, token })}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function recoverStaleLock(lockPath: string, migrationId: string): boolean {
  try {
    const stats = fs.lstatSync(lockPath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) return false;
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      migrationId?: unknown;
      pid?: unknown;
    };
    if (value.migrationId !== migrationId || !Number.isSafeInteger(value.pid)
      || Number(value.pid) < 1 || processIsAlive(Number(value.pid))) return false;
    fs.rmSync(lockPath, { force: true });
    fsyncDirectory(path.dirname(lockPath));
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}
