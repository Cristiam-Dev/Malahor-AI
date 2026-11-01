import fs from "node:fs";
import path from "node:path";

export interface CopyAssetsResult {
  source: string;
  destination: string;
  copied: boolean;
  replaced: boolean;
}

export function copyAssets(source: string, destination: string, dryRun: boolean): CopyAssetsResult {
  if (!fs.existsSync(source)) {
    throw new Error(`No existe directorio de assets: ${source}`);
  }

  if (dryRun) return { source, destination, copied: false, replaced: false };

  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, ".malahor-assets-stage-"));
  const payload = path.join(staging, "payload");
  const displaced = path.join(staging, "previous");
  const existed = fs.existsSync(destination);

  try {
    fs.cpSync(source, payload, { recursive: true, force: false, errorOnExist: true });
    if (existed) fs.renameSync(destination, displaced);
    try {
      fs.renameSync(payload, destination);
    } catch (error) {
      if (existed && fs.existsSync(displaced) && !fs.existsSync(destination)) {
        fs.renameSync(displaced, destination);
      }
      throw error;
    }
    fs.rmSync(displaced, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return { source, destination, copied: true, replaced: existed };
}
