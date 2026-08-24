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
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.copyFileSync(source, destination);
  }

  return { source, destination, created: true };
}
