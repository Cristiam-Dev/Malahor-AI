import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NODE_SCENARIO_NAMES,
  assertNodeScenario,
  runNodeScenarioGroup,
} from "./fixtures/horiel-sqlite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "src");
const horielRoot = path.join(sourceRoot, "horiel");
const coreRoot = path.join(horielRoot, "core");
const sqliteRoot = path.join(horielRoot, "sqlite");

const requiredSqliteModules = [
  "index.ts",
  "schema.ts",
  "store.ts",
];

const nodeReport = runNodeScenarioGroup("boundary");

function TypeScriptFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
    }
  };
  visit(root);
  return files.sort();
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

function forbiddenSqliteDependency(specifier: string): boolean {
  const value = specifier.toLowerCase();
  if (value.includes("mnemo") || value.includes("engram")) return true;
  if (value.includes("modelcontextprotocol") || /(^|[/@.-])mcp([/@.-]|$)/.test(value)) return true;
  if (/(^|\/)cli(\/|$)/.test(value) || /(^|\/)plugin(\/|$)/.test(value)) return true;
  if (/(^|\/)runtime(\/|$)/.test(value)) return true;
  return [
    "node:child_process",
    "node:dgram",
    "node:dns",
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "undici",
    "ws",
  ].includes(value);
}

describe("Horiel P3 SQLite architecture boundary", () => {
  test("exposes the approved isolated SQLite modules and validates the barrel under Node", async () => {
    const actualModules = fs.existsSync(sqliteRoot)
      ? fs.readdirSync(sqliteRoot).filter((entry) => entry.endsWith(".ts")).sort()
      : [];
    for (const required of requiredSqliteModules) {
      expect(actualModules, `missing src/horiel/sqlite/${required}`).toContain(required);
    }
    assertNodeScenario(await nodeReport, NODE_SCENARIO_NAMES.boundary[0]);
  });

  test("keeps the P3 adapter free of Mnemo, MCP, CLI, plugin, runtime and network dependencies", () => {
    const violations: string[] = [];
    for (const file of TypeScriptFiles(sqliteRoot)) {
      const source = fs.readFileSync(file, "utf8");
      for (const specifier of moduleSpecifiers(source)) {
        if (forbiddenSqliteDependency(specifier)) {
          violations.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
        }
      }
      if (/\bfetch\s*\(|\bWebSocket\b|\bBun\s*\.\s*(?:connect|serve)\b/.test(source)) {
        violations.push(`${path.relative(repoRoot, file)} -> direct network API`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("keeps Core independent of SQLite", () => {
    const violations: string[] = [];
    for (const file of TypeScriptFiles(coreRoot)) {
      const source = fs.readFileSync(file, "utf8");
      for (const specifier of moduleSpecifiers(source)) {
        const value = specifier.toLowerCase();
        if (value === "node:sqlite" || /(^|\/)sqlite(?:\/|$)/.test(value)) {
          violations.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("does not activate Horiel from the existing runtime", () => {
    const violations: string[] = [];
    for (const file of TypeScriptFiles(sourceRoot)) {
      if (file.startsWith(`${horielRoot}${path.sep}`)) continue;
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
