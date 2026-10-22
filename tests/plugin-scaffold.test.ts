import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import plugin from "../assets/opencode/plugins/malahor/index";

const originalHome = process.env.MALAHOR_HOME;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-plugin-scaffold-"));
  process.env.MALAHOR_HOME = home;
  fs.mkdirSync(path.join(home, "mnemo"), { recursive: true });
  fs.writeFileSync(path.join(home, "mnemo", "index.js"), "// mnemo\n", "utf8");
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.MALAHOR_HOME;
  } else {
    process.env.MALAHOR_HOME = originalHome;
  }
});

function stateFile(): string {
  return path.join(home, "plugin-state.json");
}

function readState(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as Record<string, unknown>;
}

function v2Context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: { hook: () => undefined },
    mcp: { transform: () => undefined },
    agent: { transform: () => undefined },
    command: { transform: () => undefined },
    skill: { transform: () => undefined },
    permission: { hook: () => undefined },
    tool: { hook: () => undefined },
    shell: { hook: () => undefined },
    event: { subscribe: () => undefined },
    storage: { set: async () => undefined },
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

  test("V2 completo registra hooks criticos y degrada event", async () => {
    await plugin.setup(v2Context());

    const state = readState();
    expect(state.host).toBe("v2");
    expect(state.plugin).toBe("malahor");
    expect(state.schema).toBe(1);
    expect(state.criticalGaps).toEqual([]);
    expect(state.degraded).toEqual(["event"]);
    expect(state.capabilities).toMatchObject({
      session: true,
      permission: true,
      mcp: true,
      agent: true,
      command: true,
      skill: true,
      tool: true,
      event: false,
      storage: true,
      "permission.evaluate": true,
      "tool.execute.before": true,
      "shell.create.before": true,
      "session.prompt.before": true,
      "session.context.before": true,
      "session.http-request.before": true,
    });

    if (process.platform !== "win32") {
      expect(fs.statSync(stateFile()).mode & 0o777).toBe(0o600);
    }
  });

  test("V2 parcial separa degradadas de brechas criticas", async () => {
    await withoutWarnings(async () => {
      await plugin.setup(v2Context({ mcp: undefined, storage: undefined }));
    });

    const state = readState();
    expect(state.criticalGaps).toEqual([]);
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
