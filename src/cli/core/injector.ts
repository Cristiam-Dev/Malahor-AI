import fs from "node:fs";
import path from "node:path";
import type { MalahorPaths } from "./paths";

interface OpenCodeConfig {
  [key: string]: unknown;
  mcp?: Record<string, unknown>;
}

export function injectMnemoConfig(paths: MalahorPaths, dryRun: boolean): OpenCodeConfig {
  const current = readOpenCodeConfig(paths.opencodeConfig);
  const next: OpenCodeConfig = {
    ...current,
    mcp: {
      ...(current.mcp ?? {}),
      mnemo: {
        type: "local",
        command: ["node", paths.mnemoIndex],
        enabled: true,
      },
    },
  };

  if (!dryRun) {
    fs.mkdirSync(path.dirname(paths.opencodeConfig), { recursive: true });
    fs.writeFileSync(paths.opencodeConfig, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return next;
}

export function readOpenCodeConfig(filePath: string): OpenCodeConfig {
  if (!fs.existsSync(filePath)) {
    return { $schema: "https://opencode.ai/config.json" };
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return { $schema: "https://opencode.ai/config.json" };

  try {
    const parsed = JSON.parse(stripJsonComments(raw));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as OpenCodeConfig;
    }
  } catch (error) {
    throw new Error(`No se pudo leer ${filePath}: ${(error as Error).message}`);
  }

  throw new Error(`La configuracion ${filePath} no contiene un objeto JSON valido.`);
}

export function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
        output += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (!inString && current === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (!inString && current === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += current;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (current === "\\") {
      escaped = true;
      continue;
    }

    if (current === '"') {
      inString = !inString;
    }
  }

  return output;
}
