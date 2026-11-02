import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  HORIEL_P4_REPOSITORY_ROOT,
  HORIEL_P4_SANDBOX_ROOT,
  assertHorielP4SandboxPath,
  cleanupHorielP4Suite,
  createHorielP4Sandbox,
} from "./fixtures/horiel-integration";

const SUITE = "boundary";

const EXPECTED_P4_MODULES = [
  "src/horiel/integration/runtime.ts",
  "src/horiel/integration/guardrails.ts",
  "src/horiel/integration/index.ts",
  "src/horiel/mcp/tool-definitions.ts",
  "src/horiel/mcp/dispatch.ts",
  "src/horiel/mcp/server.ts",
  "src/horiel/mcp/index.ts",
  "src/horiel/cli/memory.ts",
] as const;

const ACTIVATION_FORBIDDEN = [
  "src/cli/index.ts",
  "src/cli/commands/install.ts",
  "src/cli/commands/update.ts",
  "src/cli/commands/doctor.ts",
  "src/cli/commands/uninstall.ts",
  "src/cli/core/injector.ts",
] as const;

function source(relative: string): string {
  return fs.readFileSync(path.join(HORIEL_P4_REPOSITORY_ROOT, relative), "utf8");
}

function typeScriptFiles(relativeDirectory: string): string[] {
  const root = path.join(HORIEL_P4_REPOSITORY_ROOT, relativeDirectory);
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        output.push(path.relative(HORIEL_P4_REPOSITORY_ROOT, target).replaceAll(path.sep, "/"));
      }
    }
  };
  visit(root);
  return output.sort();
}

function importSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const expression = /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g;
  for (const match of content.matchAll(expression)) specifiers.push(match[1]!);
  return specifiers;
}

function expectNoImport(relative: string, forbidden: RegExp): void {
  for (const specifier of importSpecifiers(source(relative))) {
    expect(specifier, `${relative} imports forbidden boundary ${specifier}`).not.toMatch(forbidden);
  }
}

afterAll(() => {
  cleanupHorielP4Suite(SUITE);
});

describe("Frontera de integración Horiel P4", () => {
  test("materializa solo los modulos P4 previstos", () => {
    const missing = EXPECTED_P4_MODULES.filter((relative) => (
      !fs.existsSync(path.join(HORIEL_P4_REPOSITORY_ROOT, relative))
    ));
    expect(missing).toEqual([]);
  });

  test("Core y SQLite no importan integration, MCP, CLI, plugin ni Mnemo", () => {
    const coreFiles = typeScriptFiles("src/horiel/core");
    const sqliteFiles = typeScriptFiles("src/horiel/sqlite");
    expect(coreFiles.length).toBeGreaterThan(0);
    expect(sqliteFiles.length).toBeGreaterThan(0);
    for (const relative of coreFiles) {
      expectNoImport(relative, /(?:^|\/)(?:sqlite|integration|mcp|cli|plugin|mnemo)(?:\/|$)/i);
    }
    for (const relative of sqliteFiles) {
      expectNoImport(relative, /(?:^|\/)(?:integration|mcp|cli|plugin|mnemo)(?:\/|$)/i);
    }
  });

  test("integration, MCP y seam CLI no dependen de src/mnemo ni crean un segundo dominio", () => {
    const integrationFiles = typeScriptFiles("src/horiel/integration");
    const mcpFiles = typeScriptFiles("src/horiel/mcp");
    const cliFiles = typeScriptFiles("src/horiel/cli");
    expect(integrationFiles.length).toBeGreaterThan(0);
    expect(mcpFiles.length).toBeGreaterThan(0);
    expect(cliFiles).toEqual(["src/horiel/cli/memory.ts"]);
    for (const relative of [...integrationFiles, ...mcpFiles, ...cliFiles]) {
      expectNoImport(relative, /(?:^|\/)mnemo(?:\/|$)/i);
    }
    for (const relative of [...mcpFiles, ...cliFiles]) {
      if (relative === "src/horiel/mcp/index.ts") continue;
      expectNoImport(relative, /(?:^|\/)sqlite(?:\/|$)/i);
    }
  });

  test("parser, install, update, doctor, uninstall e injector no activan ni seleccionan Horiel", () => {
    for (const relative of ACTIVATION_FORBIDDEN) {
      const content = source(relative);
      expect(content, `${relative} must stay unaware of Horiel in P4`).not.toMatch(/MALAHOR_HORIEL|\bhoriel\b/i);
    }
  });

  test("runtime explicito abre write pero no contiene ruta create ni selector de proveedor", () => {
    const runtime = source("src/horiel/integration/runtime.ts");
    expect(runtime).toMatch(/openHorielSqliteStore/);
    expect(runtime).toMatch(/access\s*:\s*["']write["']/);
    expect(runtime).not.toMatch(/access\s*:\s*["']create["']/);
    expect(runtime).not.toMatch(/activeProvider|memoryProvider|providerMarker|selectionMarker/i);
  });

  test("todos los artefactos sinteticos P4 quedan bajo .sandbox/horiel-p4", () => {
    const sandbox = createHorielP4Sandbox(SUITE, "confinement");
    for (const target of [
      sandbox.root,
      sandbox.home,
      sandbox.opencode,
      sandbox.projectRoot,
      sandbox.databasePath,
      sandbox.snapshotDirectory,
      sandbox.bundleDirectory,
      sandbox.reportPath,
    ]) {
      expect(assertHorielP4SandboxPath(target)).toBe(path.resolve(target));
      const relative = path.relative(HORIEL_P4_SANDBOX_ROOT, target);
      expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(false);
    }
  });
});
