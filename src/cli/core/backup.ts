import fs from "node:fs";
import path from "node:path";

export interface BackupResult {
  source: string;
  destination: string | null;
  created: boolean;
}

export function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function backupFile(source: string, backupsDir: string, dryRun: boolean): BackupResult {
  if (!fs.existsSync(source)) {
    return { source, destination: null, created: false };
  }

  const destination = path.join(backupsDir, `${path.basename(source)}.${timestamp()}.bak`);

  if (!dryRun) {
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(backupsDir, 0o700);
    fs.chmodSync(destination, 0o600);
  }

  return { source, destination, created: true };
}
