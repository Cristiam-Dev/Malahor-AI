import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import plugin from "../assets/opencode/plugins/malahor/index";

const SANDBOX_ENV = [
  "HOME", "XDG_CONFIG_HOME", "MALAHOR_HOME", "MALAHOR_CONFIG", "MALAHOR_OPENCODE_DIR", "MALAHOR_OPENCODE_DETECT",
] as const;
const originalEnv = Object.fromEntries(SANDBOX_ENV.map((key) => [key, process.env[key]]));
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-plugin-scaffold-"));
  process.env.HOME = path.join(home, "user");
  process.env.XDG_CONFIG_HOME = path.join(home, "user", ".config");
  process.env.MALAHOR_HOME = home;
  process.env.MALAHOR_CONFIG = path.join(home, "config.jsonc");
  process.env.MALAHOR_OPENCODE_DIR = path.join(home, "opencode");
  process.env.MALAHOR_OPENCODE_DETECT = "0";
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(process.env.MALAHOR_OPENCODE_DIR, { recursive: true });
  fs.mkdirSync(path.join(home, "mnemo"), { recursive: true });
  fs.writeFileSync(path.join(home, "mnemo", "index.js"), "// mnemo\n", "utf8");
  fs.mkdirSync(path.join(home, "docs"), { recursive: true });
  fs.writeFileSync(path.join(home, "docs", "index.js"), "// docs\n", "utf8");
});

afterEach(() => {
  for (const key of SANDBOX_ENV) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function stateFile(): string {
  return path.join(home, "plugin-state.json");
}

function readState(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as Record<string, unknown>;
}

function v2Context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: { hook: () => undefined, get: async () => undefined, synthetic: async () => undefined },
    mcp: { transform: () => undefined },
    agent: { transform: () => undefined },
    command: { transform: () => undefined },
    skill: { transform: () => undefined },
    permission: { hook: () => undefined, assert: async () => undefined },
    tool: { hook: () => undefined, transform: () => undefined },
    shell: { hook: () => undefined },
    event: { subscribe: () => (async function* () {})() },
    storage: { get: async () => undefined, set: async () => undefined },
    ...overrides,
  };
}

async function withoutWarnings(run: () => Promise<void>): Promise<void> {
  const original = console.warn;
  console.warn = () => undefined;
  try {
    await run();
  } finally {
    console.warn = original;
  }
}

describe("scaffold del plugin", () => {
  test("importar no escribe estado", () => {
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  test("V2 completo registra hooks criticos y stream de eventos", async () => {
    await plugin.setup(v2Context());

    const state = readState();
    expect(state.host).toBe("v2");
    expect(state.plugin).toBe("malahor");
    expect(state.schema).toBe(1);
    expect(state.criticalGaps).toEqual([]);
    expect(state.degraded).toEqual([]);
    expect(state.capabilities).toMatchObject({
      session: true,
      permission: true,
      mcp: true,
      agent: true,
      command: true,
      skill: true,
      tool: true,
      event: true,
      storage: true,
      "permission.evaluate": true,
      "tool.execute.before": true,
      "planning.v2": true,
      "planning.authority": true,
      "mode.command": true,
      "plan.command": true,
      "shell.create.before": true,
      "session.prompt.before": true,
      "session.context.before": true,
      "session.http-request.before": true,
    });

    if (process.platform !== "win32") {
      expect(fs.statSync(stateFile()).mode & 0o777).toBe(0o600);
    }
  });

  test("bundle expone planning.v2 e instruye separar presentacion y aprobacion en turnos", async () => {
    const repo = path.join(home, "repo");
    const sessionID = "ses_bundle_planning";
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({
      demo: { context: "memory", roots: [repo], defaultRoot: repo },
    }));
    fs.writeFileSync(process.env.MALAHOR_CONFIG!, JSON.stringify({
      execution: { intervention: "ejecutar", verification: true },
    }));

    type Hook = (input: Record<string, unknown>) => Promise<void> | void;
    const hooks = new Map<string, Hook[]>();
    const hook = (name: string, callback: Hook) => {
      hooks.set(name, [...(hooks.get(name) ?? []), callback]);
      return { dispose: () => undefined };
    };
    const values = new Map<string, unknown>();
    const cleanup = await plugin.setup(v2Context({
      location: { directory: repo },
      session: {
        hook,
        get: async ({ sessionID: requested }: { sessionID: string }) =>
          requested === sessionID ? { location: { directory: repo } } : undefined,
        synthetic: async () => undefined,
      },
      storage: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => { values.set(key, value); },
      },
    }));
    try {
      const input: Record<string, unknown> = {
        sessionID, agent: "malahor", system: [{ type: "text", text: "base" }],
      };
      for (const callback of hooks.get("context") ?? []) await callback(input);

      const state = readState();
      const capabilities = state.capabilities as Record<string, unknown>;
      expect(capabilities["planning.v2"]).toBe(true);
      expect(capabilities["planning.v1"]).toBeUndefined();
      const text = (input.system as Array<{ text: string }>).map((item) => item.text).join("\n");
      expect(text.match(/malahor-planning:v3/g) ?? []).toHaveLength(1);
      expect(text).not.toContain("malahor-planning:v1");
      expect(text).toMatch(/plan completo/i);
      expect(text).toMatch(/termina(?:r)? (?:este )?turno/i);
      expect(text).toMatch(/solicitud posterior/i);
      expect(text).toMatch(/\bgo\b/i);
      expect(text).toMatch(/\bimplementa\b/i);
      expect(text).toMatch(/go previo.*no aprueba.*plan.*no visto/is);
      expect(text).toMatch(/documentaci[oó]n mediante docs_\*/i);
      expect(text).toMatch(/Obsidian MCP ni fallback al repositorio/i);
    } finally {
      if (typeof cleanup === "function") await cleanup();
    }
  });

  test("V2 parcial separa degradadas de brechas criticas", async () => {
    await withoutWarnings(async () => {
      await plugin.setup(v2Context({ mcp: undefined, storage: undefined }));
    });

    const state = readState();
    expect(state.criticalGaps).toContain("planning.v2");
    expect(state.degraded).toContain("mcp");
    expect(state.degraded).toContain("storage");
  });

  test("V2 sin permission.hook reporta brecha critica y no lanza", async () => {
    await withoutWarnings(async () => {
      await plugin.setup(v2Context({ permission: undefined }));
    });

    const state = readState();
    expect(state.criticalGaps).toContain("permission.hook");
  });

  test("V1 registra capacidades y devuelve Hooks vacio", async () => {
    let hooks: unknown;
    await withoutWarnings(async () => {
      hooks = await plugin.server({
        client: {},
        project: {},
        directory: "/tmp",
        worktree: "/tmp",
        $: () => undefined,
        experimental_workspace: {},
      });
    });

    expect(hooks).toEqual({});
    const state = readState();
    expect(state.host).toBe("v1");
    expect(state.criticalGaps).toContain("v1.permission.hook");
    expect(state.criticalGaps).toContain("v1.tool.hook");
    expect(state.criticalGaps).toContain("v1.shell.hook");
    expect(state.criticalGaps).toContain("v1.session.hook");
    expect(state.capabilities).toMatchObject({
      client: true,
      project: true,
      directory: true,
      worktree: true,
      shell: true,
      workspace: true,
    });
  });

  test("host desconocido queda inerte y marcado como critico", async () => {
    await withoutWarnings(async () => {
      await plugin.setup({ algo: "desconocido" });
    });

    const state = readState();
    expect(state.host).toBe("unknown");
    expect(state.degraded).toContain("host-api-desconocida");
    expect(state.criticalGaps).toContain("host-api-desconocida");
  });

  test("un fallo al escribir estado no rompe la carga", async () => {
    const blocker = path.join(home, "blocker");
    fs.writeFileSync(blocker, "archivo", "utf8");
    process.env.MALAHOR_HOME = path.join(blocker, "nested");

    await withoutWarnings(async () => {
      await plugin.setup(v2Context());
    });

    expect(fs.existsSync(path.join(blocker, "nested"))).toBe(false);
  });

  test("setup V2 devuelve cleanup y server V1 devuelve objeto", async () => {
    let cleanup: unknown;
    await withoutWarnings(async () => {
      cleanup = await plugin.setup(v2Context());
    });
    expect(typeof cleanup).toBe("function");
    await (cleanup as () => Promise<void>)();

    let serverResult: unknown;
    await withoutWarnings(async () => {
      serverResult = await plugin.server({ client: {}, project: {}, directory: "/tmp" });
    });
    expect(serverResult).toEqual({});
  });
});
