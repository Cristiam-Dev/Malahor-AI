import fs from "node:fs";
import path from "node:path";

export interface CopyAssetsResult {
  source: string;
  destination: string;
  copied: boolean;
}

export function copyAssets(source: string, destination: string, dryRun: boolean): CopyAssetsResult {
  if (!fs.existsSync(source)) {
    throw new Error(`No existe directorio de assets: ${source}`);
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, force: true });
  }

  return { source, destination, copied: !dryRun };
}
