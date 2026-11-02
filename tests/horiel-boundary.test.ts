import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "src");
const coreRoot = path.join(sourceRoot, "horiel", "core");

const expectedCoreFiles = [
  "administration.ts",
  "context.ts",
  "errors.ts",
  "horiel.ts",
  "ids.ts",
  "index.ts",
  "memories.ts",
  "model.ts",
  "mutations.ts",
  "query.ts",
  "scopes.ts",
  "store.ts",
  "validation.ts",
];

const expectedRuntimeExports = [
  "HORIEL_LIMITS",
  "HORIEL_RANKING_VERSION",
  "HorielError",
  "createHorielCore",
  "formatHorielId",
  "isHorielId",
  "isScopeWithin",
  "normalizeTags",
  "parseScopePath",
  "scopeAncestors",
  "tokenizeSearchQuery",
  "validateMemoryDraft",
];

function TypeScriptFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(target);
    }
  };
  visit(root);
  return found.sort();
}

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

function runtimeModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?!type\b)[\s\S]*?\sfrom\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+(?!type\b)[\s\S]*?\sfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

function forbiddenCoreModule(specifier: string): boolean {
  const value = specifier.toLowerCase();
  if (value.includes("mnemo") || value.includes("sqlite")) return true;
  if (value.includes("modelcontextprotocol") || /(^|[/@.-])mcp([/@.-]|$)/.test(value)) return true;
  if (/(^|\/)cli(\/|$)/.test(value) || /(^|\/)plugin(\/|$)/.test(value)) return true;
  return [
    "node:child_process",
    "node:dgram",
    "node:dns",
    "node:fs",
    "node:fs/promises",
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "undici",
    "ws",
  ].includes(value);
}

describe("Horiel P2 architecture boundary", () => {
  test("requires the complete approved Core module set once the barrel exists", async () => {
    if (!fs.existsSync(coreRoot)) {
      let failure: unknown;
      try {
        await import("../src/horiel/core/index");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(String(failure)).toMatch(/cannot find|module|resolve/i);
      return;
    }

    const actual = fs.readdirSync(coreRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .sort();
    expect(actual).toEqual(expectedCoreFiles);

    const barrel = await import("../src/horiel/core/index");
    for (const exportedName of expectedRuntimeExports) {
      expect(barrel[exportedName as keyof typeof barrel], `missing barrel export ${exportedName}`).toBeDefined();
    }
  });

  test("keeps Core free of Mnemo, infrastructure, filesystem and network imports", () => {
    if (!fs.existsSync(coreRoot)) {
      expect(TypeScriptFiles(coreRoot)).toEqual([]);
      return;
    }

    const violations: string[] = [];
    for (const file of TypeScriptFiles(coreRoot)) {
      const source = fs.readFileSync(file, "utf8");
      for (const specifier of moduleSpecifiers(source)) {
        if (forbiddenCoreModule(specifier)) {
          violations.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
        }
      }
      if (/\bfetch\s*\(|\bWebSocket\b|\bBun\s*\.\s*(?:file|write|connect|serve)\b/.test(source)) {
        violations.push(`${path.relative(repoRoot, file)} -> direct filesystem/network API`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("does not activate Horiel from any existing runtime during P2", () => {
    const violations: string[] = [];
    for (const file of TypeScriptFiles(sourceRoot)) {
      if (file.startsWith(`${path.join(sourceRoot, "horiel")}${path.sep}`)) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const specifier of runtimeModuleSpecifiers(source)) {
        if (/(^|\/)horiel(?:\/|$)/i.test(specifier)) {
          violations.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
