import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import plugin from "../assets/opencode/plugins/malahor/index";
import { runContext } from "../src/cli/commands/context";
import { runUninstall } from "../src/cli/commands/uninstall";
import { loadProjectsFile } from "../src/cli/core/context";
import { prepareProjectDocsOnboarding } from "../src/cli/core/docs-onboarding";
import {
  removeMalahorMcpConfig,
  syncOpenCodeConfig,
} from "../src/cli/core/injector";
import { resolvePackagePaths } from "../src/cli/core/package";
import { resolvePaths, type MalahorPaths } from "../src/cli/core/paths";
import { validateInstallation } from "../src/cli/core/validate";

const ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "MALAHOR_HOME",
  "MALAHOR_CONFIG",
  "MALAHOR_OPENCODE_DIR",
  "MALAHOR_OPENCODE_DETECT",
] as const;

const EXECUTION = {
  intervention: "ejecutar",
  verification: true,
  revision: "a".repeat(32),
} as const;

let scratch: string;
let repo: string;
let home: string;
let paths: MalahorPaths;
let previousEnv: Record<string, string | undefined>;

function capture(run: () => void): string {
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  let output = "";
  try {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    run();
    return output;
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  }
}

async function captureAsync(run: () => void | Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  let output = "";
  try {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    await run();
    return output;
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  }
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    return await run();
  } finally {
    console.warn = originalWarn;
  }
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-docs-installation-"));
  repo = path.join(scratch, "repo");
  home = path.join(scratch, "malahor-home");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  paths = resolvePaths({
    HOME: path.join(scratch, "user"),
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    MALAHOR_HOME: home,
    MALAHOR_CONFIG: path.join(home, "config.jsonc"),
    MALAHOR_OPENCODE_DIR: path.join(scratch, "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  }, repo);
  fs.writeFileSync(paths.projectsFile, JSON.stringify({
    demo: { context: "memory", roots: [repo], defaultRoot: repo },
  }));

  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: path.join(scratch, "user"),
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    MALAHOR_HOME: home,
    MALAHOR_CONFIG: paths.configFile,
    MALAHOR_OPENCODE_DIR: paths.opencodeDir,
    MALAHOR_OPENCODE_DETECT: "0",
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("rutas y artefactos de instalacion docs", () => {
  test("separa runtime y vault, y el paquete apunta a dist/docs/index.js", () => {
    expect(paths.docsDir).toBe(path.join(home, "docs"));
    expect(paths.docsIndex).toBe(path.join(home, "docs", "index.js"));
    expect(paths.vaultDir).toBe(path.join(home, "vault"));
    expect(paths.docsIndex.startsWith(`${paths.vaultDir}${path.sep}`)).toBe(false);

    const packagePaths = resolvePackagePaths(process.cwd());
    expect(packagePaths.docsBuild).toBe(path.join(process.cwd(), "dist", "docs", "index.js"));
    expect(fs.existsSync(path.join(packagePaths.assetsDir, "vault-template", "README.md"))).toBe(true);

    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts.build).toContain("bun build src/docs/index.ts --outdir dist/docs --target=node");
    for (const command of ["install", "update"] as const) {
      const source = fs.readFileSync(path.join(process.cwd(), "src", "cli", "commands", `${command}.ts`), "utf8");
      expect(source).toContain("fs.copyFileSync(packagePaths.docsBuild, paths.docsIndex)");
      expect(source).toContain("prepareProjectDocsOnboarding");
      expect(source).toContain("explicitPath: options.docsPath");
      expect(source).toContain("initializeDocsProject");
    }
  });

  test("validateInstallation exige el runtime docs y el vault, sin confundirlos", () => {
    const missing = validateInstallation(paths, null, {
      mcpManagedByPlugin: true,
      configManagedByPlugin: true,
      agentHost: "unknown",
    });
    expect(missing.some((problem) => problem.includes("Docs MCP index falta"))).toBe(true);
    expect(missing.some((problem) => problem.includes("Vault documental falta"))).toBe(true);

    fs.mkdirSync(path.dirname(paths.docsIndex), { recursive: true });
    fs.writeFileSync(paths.docsIndex, "// docs runtime fixture\n");
    fs.mkdirSync(paths.vaultDir, { recursive: true });
    const present = validateInstallation(paths, null, {
      mcpManagedByPlugin: true,
      configManagedByPlugin: true,
      agentHost: "unknown",
    });
    expect(present.some((problem) => problem.includes("Docs MCP index falta"))).toBe(false);
    expect(present.some((problem) => problem.includes("Vault documental falta"))).toBe(false);
  });
});

describe("onboarding documental de proyectos", () => {
  test("proyectos nuevos usan el vault gestionado con --yes o sin TTY", async () => {
    const yesRoot = path.join(scratch, "yes-code");
    const noTtyRoot = path.join(scratch, "no-tty-code");
    fs.mkdirSync(yesRoot);
    fs.mkdirSync(noTtyRoot);

    const yes = await prepareProjectDocsOnboarding({
      paths,
      aliases: {},
      project: "yes-project",
      codeRoots: [yesRoot],
      yes: true,
      dryRun: false,
      interactive: true,
      ask: async () => { throw new Error("--yes no debe preguntar"); },
    });
    const noTty = await prepareProjectDocsOnboarding({
      paths,
      aliases: {},
      project: "no-tty-project",
      codeRoots: [noTtyRoot],
      yes: false,
      dryRun: false,
      interactive: false,
      ask: async () => { throw new Error("sin TTY no debe preguntar"); },
    });

    expect(yes).toMatchObject({ isNewProject: true, prompted: false, resolution: { source: "default" } });
    expect(noTty).toMatchObject({ isNewProject: true, prompted: false, resolution: { source: "default" } });
    expect(yes.resolution.projectRoot).toBe(path.join(paths.vaultDir, "projects", "yes-project"));
    expect(noTty.resolution.projectRoot).toBe(path.join(paths.vaultDir, "projects", "no-tty-project"));
  });

  test("acepta override explicito y permite inyectar el prompt para elegir carpeta personalizada", async () => {
    const explicitCode = path.join(scratch, "explicit-code");
    const promptCode = path.join(scratch, "prompt-code");
    const explicitDocs = path.join(scratch, "explicit-docs");
    const promptDocs = path.join(scratch, "prompt-docs");
    fs.mkdirSync(explicitCode);
    fs.mkdirSync(promptCode);

    const explicit = await prepareProjectDocsOnboarding({
      paths,
      aliases: {},
      project: "explicit-project",
      codeRoots: [explicitCode],
      explicitPath: explicitDocs,
      yes: true,
      dryRun: false,
      ask: async () => { throw new Error("un override explicito no debe preguntar"); },
    });
    const answers = ["2", promptDocs];
    const questions: string[] = [];
    const prompted = await prepareProjectDocsOnboarding({
      paths,
      aliases: {},
      project: "prompt-project",
      codeRoots: [promptCode],
      yes: false,
      dryRun: false,
      interactive: true,
      ask: async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      },
    });

    expect(explicit).toMatchObject({
      isNewProject: true,
      prompted: false,
      overridePath: explicitDocs,
      resolution: { source: "override", projectRoot: explicitDocs },
    });
    expect(prompted).toMatchObject({
      isNewProject: true,
      prompted: true,
      overridePath: promptDocs,
      resolution: { source: "override", projectRoot: promptDocs },
    });
    expect(questions).toHaveLength(2);
    expect(questions[0]).toContain("Vault gestionado por Malahor");
  });

  test("un proyecto existente no vuelve a preguntar y rechaza cambiar su override durante el alta", async () => {
    let asked = false;
    const existing = await prepareProjectDocsOnboarding({
      paths,
      aliases: {},
      project: "demo",
      codeRoots: [repo],
      yes: false,
      dryRun: false,
      interactive: true,
      ask: async () => { asked = true; return "2"; },
    });

    expect(existing).toMatchObject({ isNewProject: false, prompted: false });
    expect(asked).toBe(false);
    await expect(prepareProjectDocsOnboarding({
      paths,
      aliases: {},
      project: "demo",
      codeRoots: [repo],
      explicitPath: path.join(scratch, "different-docs"),
      yes: true,
      dryRun: false,
    })).rejects.toThrow(/ya tiene raiz documental.*preview y migracion/i);
  });

  test("context register inicializa el skeleton sin ejecutar install ni update", async () => {
    const codeRoot = path.join(scratch, "registered-code");
    const template = path.join(paths.assetsDir, "vault-template");
    fs.mkdirSync(codeRoot);
    fs.mkdirSync(template, { recursive: true });
    fs.writeFileSync(path.join(template, "README.md"), "---\ntype: vault\n---\n\n# Vault\n", "utf8");

    const output = await captureAsync(() => runContext({
      action: "register",
      args: ["registered-project", codeRoot],
      dryRun: false,
      limit: undefined,
      project: undefined,
      yes: true,
    }));
    const projectRoot = path.join(paths.vaultDir, "projects", "registered-project");
    const registered = loadProjectsFile(paths.projectsFile)["registered-project"];

    expect(output).toContain("Docs skeleton: initialized");
    expect(registered?.roots).toEqual([codeRoot]);
    expect(registered?.docs).toBeUndefined();
    expect(fs.existsSync(path.join(projectRoot, "README.md"))).toBe(true);
    for (const area of ["Product", "Design", "SDD", "Discovery"]) {
      expect(fs.statSync(path.join(projectRoot, area)).isDirectory()).toBe(true);
    }
  });
});

describe("registro MCP V1 y V2", () => {
  test("V1 registra Mnemo y docs y uninstall logico conserva MCPs ajenos", () => {
    fs.mkdirSync(path.dirname(paths.opencodeConfig), { recursive: true });
    fs.writeFileSync(paths.opencodeConfig, `${JSON.stringify({
      mcp: {
        foreign: { type: "remote", url: "https://example.invalid/mcp" },
        obsidian: { type: "local", command: ["legacy-obsidian"] },
      },
    }, null, 2)}\n`);

    const synced = syncOpenCodeConfig(paths, { execution: EXECUTION, manageMcp: true }, false);
    expect(synced.mcp?.mnemo).toEqual({ type: "local", command: ["node", paths.mnemoIndex], enabled: true });
    expect(synced.mcp?.docs).toEqual({ type: "local", command: ["node", paths.docsIndex], enabled: true });
    expect(synced.mcp?.foreign).toEqual({ type: "remote", url: "https://example.invalid/mcp" });
    expect(synced.mcp?.obsidian).toEqual({ type: "local", command: ["legacy-obsidian"] });

    const removed = removeMalahorMcpConfig(paths, false);
    expect(removed.mcp?.mnemo).toBeUndefined();
    expect(removed.mcp?.docs).toBeUndefined();
    expect(removed.mcp?.foreign).toEqual({ type: "remote", url: "https://example.invalid/mcp" });
    expect(removed.mcp?.obsidian).toEqual({ type: "local", command: ["legacy-obsidian"] });
  });

  test("el bundle V2 registra docs y Mnemo first-party sin registrar ni mutar Obsidian", async () => {
    fs.mkdirSync(path.dirname(paths.mnemoIndex), { recursive: true });
    fs.mkdirSync(path.dirname(paths.docsIndex), { recursive: true });
    fs.writeFileSync(paths.mnemoIndex, "// mnemo fixture\n");
    fs.writeFileSync(paths.docsIndex, "// docs fixture\n");
    const state: Record<string, Record<string, unknown>> = {
      foreign: { type: "remote", url: "https://example.invalid/mcp" },
      obsidian: { type: "remote", url: "https://obsidian.invalid/mcp", disabled: true },
    };
    const sets: string[] = [];

    const cleanup = await quietly(() => plugin.setup({
      location: { directory: repo },
      mcp: {
        transform: (callback: (editor: {
          get: (name: string) => Record<string, unknown> | undefined;
          set: (name: string, config: Record<string, unknown>) => void;
        }) => void) => callback({
          get: (name) => state[name],
          set: (name, config) => { state[name] = config; sets.push(name); },
        }),
      },
    }));
    try {
      expect(sets).toEqual(expect.arrayContaining(["mnemo", "docs"]));
      expect(state.docs).toMatchObject({
        type: "local",
        command: ["node", paths.docsIndex],
        disabled: false,
        codemode: false,
      });
      expect(state.mnemo).toMatchObject({ command: ["node", paths.mnemoIndex], disabled: false });
      expect(sets).not.toContain("obsidian");
      expect(state.obsidian).toEqual({ type: "remote", url: "https://obsidian.invalid/mcp", disabled: true });
      expect(state.foreign).toEqual({ type: "remote", url: "https://example.invalid/mcp" });
    } finally {
      if (typeof cleanup === "function") await cleanup();
    }
  });

  test("el bundle V2 no pisa una definicion docs ajena", async () => {
    fs.mkdirSync(path.dirname(paths.docsIndex), { recursive: true });
    fs.writeFileSync(paths.docsIndex, "// docs fixture\n");
    const foreign = { type: "local", command: ["node", path.join(scratch, "foreign-docs.js")], disabled: true };
    const state: Record<string, Record<string, unknown>> = { docs: foreign };
    const sets: string[] = [];

    const cleanup = await quietly(() => plugin.setup({
      location: { directory: repo },
      mcp: {
        transform: (callback: (editor: {
          get: (name: string) => Record<string, unknown> | undefined;
          set: (name: string, config: Record<string, unknown>) => void;
        }) => void) => callback({
          get: (name) => state[name],
          set: (name, config) => { state[name] = config; sets.push(name); },
        }),
      },
    }));
    try {
      expect(sets).not.toContain("docs");
      expect(state.docs).toEqual(foreign);
    } finally {
      if (typeof cleanup === "function") await cleanup();
    }
  });
});

describe("uninstall conserva la documentacion", () => {
  test("retira el runtime y registros MCP, pero conserva vault default y overrides externos", () => {
    const external = path.join(scratch, "external-docs", "demo");
    const vaultFile = path.join(paths.vaultDir, "projects", "demo", "kept.md");
    const externalFile = path.join(external, "kept.md");
    fs.mkdirSync(path.dirname(vaultFile), { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.mkdirSync(path.dirname(paths.docsIndex), { recursive: true });
    fs.mkdirSync(path.dirname(paths.opencodeConfig), { recursive: true });
    fs.writeFileSync(vaultFile, "vault sentinel", "utf8");
    fs.writeFileSync(externalFile, "external sentinel", "utf8");
    fs.writeFileSync(paths.docsIndex, "// docs runtime\n", "utf8");
    fs.writeFileSync(paths.projectsFile, JSON.stringify({
      demo: { context: "memory", roots: [repo], defaultRoot: repo, docs: { path: external } },
    }));
    fs.writeFileSync(paths.opencodeConfig, JSON.stringify({
      mcp: {
        mnemo: { type: "local", command: ["node", paths.mnemoIndex], enabled: true },
        docs: { type: "local", command: ["node", paths.docsIndex], enabled: true },
        foreign: { type: "remote", url: "https://example.invalid/mcp" },
        obsidian: { type: "remote", url: "https://obsidian.invalid/mcp", disabled: true },
      },
    }));

    const output = capture(() => runUninstall({ dryRun: false, yes: true }));
    const config = JSON.parse(fs.readFileSync(paths.opencodeConfig, "utf8"));
    expect(output).toContain("Managed MCP registrations (Mnemo + docs): removed; foreign definitions kept");
    expect(output).toContain(`Docs vault: kept (${paths.vaultDir})`);
    expect(output).toContain("external project overrides are never removed");
    expect(fs.existsSync(paths.docsIndex)).toBe(false);
    expect(fs.readFileSync(vaultFile, "utf8")).toBe("vault sentinel");
    expect(fs.readFileSync(externalFile, "utf8")).toBe("external sentinel");
    expect(config.mcp.mnemo).toBeUndefined();
    expect(config.mcp.docs).toBeUndefined();
    expect(config.mcp.foreign).toEqual({ type: "remote", url: "https://example.invalid/mcp" });
    expect(config.mcp.obsidian).toEqual({ type: "remote", url: "https://obsidian.invalid/mcp", disabled: true });
  });

  test("removal y uninstall conservan definiciones mnemo/docs ajenas y el vault", () => {
    const vaultFile = path.join(paths.vaultDir, "projects", "demo", "kept-foreign.md");
    const foreignMnemo = { type: "local", command: ["node", `${paths.mnemoIndex}.foreign`], enabled: true };
    const foreignDocs = { type: "local", command: ["node", `${paths.docsIndex}.foreign`], enabled: false };
    fs.mkdirSync(path.dirname(vaultFile), { recursive: true });
    fs.mkdirSync(path.dirname(paths.opencodeConfig), { recursive: true });
    fs.writeFileSync(vaultFile, "vault sentinel", "utf8");
    fs.writeFileSync(paths.opencodeConfig, JSON.stringify({
      mcp: { mnemo: foreignMnemo, docs: foreignDocs },
    }));

    const removed = removeMalahorMcpConfig(paths, false);
    expect(removed.mcp?.mnemo).toEqual(foreignMnemo);
    expect(removed.mcp?.docs).toEqual(foreignDocs);

    const output = capture(() => runUninstall({ dryRun: false, yes: true }));
    const config = JSON.parse(fs.readFileSync(paths.opencodeConfig, "utf8"));
    expect(output).toContain("foreign definitions kept");
    expect(config.mcp.mnemo).toEqual(foreignMnemo);
    expect(config.mcp.docs).toEqual(foreignDocs);
    expect(fs.readFileSync(vaultFile, "utf8")).toBe("vault sentinel");
  });
});
