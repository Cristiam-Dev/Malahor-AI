import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import plugin from "../src/plugin/index";
import {
  cleanupHorielP4Suite,
  createHorielP4Sandbox,
  type HorielP4Sandbox,
} from "./fixtures/horiel-integration";

const SUITE = "plugin";

interface McpEditor {
  get(name: string): Record<string, unknown> | undefined;
  set(name: string, config: Record<string, unknown>): void;
}

function prepareManagedRuntimes(sandbox: HorielP4Sandbox, horiel: boolean): void {
  for (const name of ["mnemo", "docs", ...(horiel ? ["horiel"] : [])]) {
    const directory = path.join(sandbox.home, name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "index.js"), `// synthetic ${name} runtime\n`, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(sandbox.home, "projects.json"), `${JSON.stringify({
    malahor: {
      context: "memory",
      roots: [sandbox.projectRoot],
      defaultRoot: sandbox.projectRoot,
    },
  }, null, 2)}\n`, { mode: 0o600 });
}

async function withPluginEnvironment<T>(sandbox: HorielP4Sandbox, operation: () => Promise<T>): Promise<T> {
  const values: Record<string, string> = {
    MALAHOR_HOME: sandbox.home,
    MALAHOR_OPENCODE_DIR: sandbox.opencode,
    MALAHOR_OPENCODE_DETECT: "0",
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function setupTransform(
  sandbox: HorielP4Sandbox,
  initial: Record<string, Record<string, unknown>> = {},
): Promise<{
  state: Record<string, Record<string, unknown>>;
  sets: string[];
}> {
  const state = structuredClone(initial);
  const sets: string[] = [];
  await withPluginEnvironment(sandbox, async () => {
    const cleanup = await plugin.setup({
      location: {
        directory: sandbox.projectRoot,
        project: { canonical: "malahor" },
      },
      mcp: {
        transform(callback: (editor: McpEditor) => void) {
          callback({
            get: (name) => state[name],
            set: (name, config) => {
              state[name] = config;
              sets.push(name);
            },
          });
          return { dispose: () => undefined };
        },
      },
    });
    if (typeof cleanup === "function") await cleanup();
  });
  return { state, sets };
}

function environmentOf(config: Record<string, unknown> | undefined): Record<string, string> {
  const environment = config?.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("Managed Horiel MCP must declare an environment object.");
  }
  return environment as Record<string, string>;
}

function environmentValue(environment: Record<string, string>, pattern: RegExp): string | undefined {
  return Object.entries(environment).find(([key]) => pattern.test(key))?.[1];
}

afterAll(() => {
  cleanupHorielP4Suite(SUITE);
});

describe("Plugin V2 Horiel dormido P4", () => {
  test("runtime gestionado registra Horiel disabled y mantiene Mnemo/docs activos", async () => {
    const sandbox = createHorielP4Sandbox(SUITE, "managed-runtime");
    prepareManagedRuntimes(sandbox, true);
    const { state, sets } = await setupTransform(sandbox, {
      foreign: { type: "local", command: ["node", "/synthetic/foreign.js"] },
    });

    expect(sets).toContain("mnemo");
    expect(sets).toContain("docs");
    expect(sets).toContain("horiel");
    expect(sets).not.toContain("foreign");
    expect(state.mnemo).toMatchObject({
      type: "local",
      command: ["node", path.join(sandbox.home, "mnemo", "index.js")],
      disabled: false,
      codemode: false,
    });
    expect(state.docs).toMatchObject({
      type: "local",
      command: ["node", path.join(sandbox.home, "docs", "index.js")],
      disabled: false,
      codemode: false,
    });
    expect(state.horiel).toMatchObject({
      type: "local",
      command: ["node", path.join(sandbox.home, "horiel", "index.js")],
      disabled: true,
      codemode: false,
    });
    const environment = environmentOf(state.horiel);
    expect(environment.MALAHOR_HORIEL_BOUND).toBe("1");
    expect(environment.MALAHOR_HORIEL_PROJECT).toBe("malahor");
    expect(environment.MALAHOR_HORIEL_ENABLED).toBeUndefined();
    expect(Object.keys(environment).some((key) => /HORIEL.*ENABLED/i.test(key))).toBe(false);

    const database = environmentValue(environment, /HORIEL.*DATABASE/i);
    const snapshots = environmentValue(environment, /HORIEL.*SNAPSHOT/i);
    expect(database).toBeDefined();
    expect(snapshots).toBeDefined();
    for (const target of [database!, snapshots!]) {
      const relative = path.relative(path.join(sandbox.home, "horiel"), path.resolve(target));
      expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(false);
    }
    expect(state.foreign).toEqual({ type: "local", command: ["node", "/synthetic/foreign.js"] });
  });

  test("ausencia del runtime Horiel no altera el registro activo de Mnemo", async () => {
    const sandbox = createHorielP4Sandbox(SUITE, "runtime-absent");
    prepareManagedRuntimes(sandbox, false);
    const { state, sets } = await setupTransform(sandbox);

    expect(sets).toContain("mnemo");
    expect(sets).toContain("docs");
    expect(sets).not.toContain("horiel");
    expect(state.horiel).toBeUndefined();
    expect(state.mnemo).toMatchObject({ disabled: false, codemode: false });
    expect(state.docs).toMatchObject({ disabled: false, codemode: false });
  });

  test("una definicion Horiel ajena se preserva sin impedir Mnemo ni docs", async () => {
    const sandbox = createHorielP4Sandbox(SUITE, "foreign-definition");
    prepareManagedRuntimes(sandbox, true);
    const foreign = {
      type: "remote",
      url: "https://synthetic.invalid/horiel",
      headers: { Authorization: "synthetic-placeholder" },
      disabled: false,
    };
    const { state, sets } = await setupTransform(sandbox, { horiel: foreign });

    expect(sets).not.toContain("horiel");
    expect(state.horiel).toEqual(foreign);
    expect(sets).toContain("mnemo");
    expect(sets).toContain("docs");
    expect(state.mnemo).toMatchObject({ disabled: false });
    expect(state.docs).toMatchObject({ disabled: false });
  });
});
