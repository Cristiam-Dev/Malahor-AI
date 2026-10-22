import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import plugin from "../assets/opencode/plugins/malahor/index";
import {
  evaluatePermission,
  evaluateSessionHook,
  evaluateShellHook,
  evaluateToolHook,
} from "../src/cli/core/hooks/plugin-adapter";
import { MALAHOR_PROTOCOL_MARKER, injectMalahorProtocol } from "../src/plugin/protocol";

let root: string;
let repo: string;
let home: string;
let opencode: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-plugin-"));
  repo = path.join(root, "repo");
  home = path.join(root, "home");
  opencode = path.join(root, "opencode");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(opencode, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "demo" }, null, 2)}\n`, "utf8");
  env = {
    ...process.env,
    MALAHOR_HOME: home,
    MALAHOR_OPENCODE_DIR: opencode,
    MALAHOR_OPENCODE_DETECT: "0",
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeProjectPolicy(controls: Record<string, unknown>): void {
  const file = path.join(home, "policies", "projects", "demo.jsonc");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    contractVersion: 1,
    policyVersion: "test-1",
    issuer: "test",
    issuedAt: "2026-10-21T00:00:00.000Z",
    controls,
  }, null, 2)}\n`, "utf8");
}

describe("adaptador de plugin V2", () => {
  test("inyecta el protocolo al ultimo bloque de sistema una sola vez", () => {
    const input: Record<string, unknown> = {
      system: [{ type: "text", text: "instrucciones del host" }],
    };

    expect(injectMalahorProtocol(input)).toBe(true);
    expect(injectMalahorProtocol(input)).toBe(false);

    const system = input.system as Array<{ type: string; text: string }>;
    expect(system).toHaveLength(1);
    expect(system[0]?.text).toContain(MALAHOR_PROTOCOL_MARKER);
    expect(system[0]?.text).toContain("mem_brief");
    expect(system[0]?.text).toContain("Principio de socio");
  });
  test("permission.evaluate convierte git destructivo en deny y no lo rebaja", async () => {
    const input: Record<string, unknown> = {
      action: "bash",
      resources: ["git reset --hard"],
      effect: "allow",
    };

    const result = await evaluatePermission(input, { cwd: repo, permissionRegistered: true, env });

    expect(result.effect).toBe("deny");
    expect(input.effect).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
  });

  test("permission.evaluate mantiene un deny del host aunque el motor permita", async () => {
    const input: Record<string, unknown> = {
      action: "read",
      resources: [path.join(repo, "archivo.txt")],
      effect: "deny",
    };

    const result = await evaluatePermission(input, { cwd: repo, permissionRegistered: true, env });

    expect(result.effect).toBe("deny");
    expect(input.effect).toBe("deny");
  });

  test("permission.evaluate pide aprobacion para acciones no mapeadas", async () => {
    const input: Record<string, unknown> = {
      action: "capacidad.desconocida",
      resources: [],
      effect: "allow",
    };

    const result = await evaluatePermission(input, { cwd: repo, permissionRegistered: true, env });

    expect(result.effect).toBe("ask");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-PLUGIN-UNMAPPED")).toBe(true);
  });

  test("permission.evaluate mapea MCP y aplica la allowlist de tools", async () => {
    writeProjectPolicy({
      integrations: {
        enforceMcpToolAllowlist: true,
        allowedMcpTools: ["mcp_ok*"],
      },
    });

    const blocked = await evaluatePermission({
      action: "mcp_bad_search",
      resources: [],
      effect: "allow",
    }, { cwd: repo, permissionRegistered: true, env });
    const allowed = await evaluatePermission({
      action: "mcp_ok_search",
      resources: [],
      effect: "allow",
    }, { cwd: repo, permissionRegistered: true, env });

    expect(blocked.effect).toBe("deny");
    expect(blocked.result.violations.some((violation) => violation.id === "MAL-HOOK-MCP-ALLOWLIST")).toBe(true);
    expect(allowed.effect).toBe("allow");
  });

  test("permission.evaluate no pregunta por tools conocidas sin efecto propio", async () => {
    const input: Record<string, unknown> = {
      action: "todowrite",
      resources: [],
      effect: "allow",
    };

    const result = await evaluatePermission(input, { cwd: repo, permissionRegistered: true, env });

    expect(result.effect).toBe("allow");
    expect(result.result.violations).toEqual([]);
  });

  test("shell hook bloquea ejecucion indirecta y minimiza entorno", async () => {
    writeProjectPolicy({
      shell: {
        inspectIndirectExecution: true,
        minimizeEnvironment: true,
        denyCredentialEnv: true,
      },
    });

    const result = await evaluateShellHook({
      command: "bash -c 'echo hola'",
      cwd: repo,
      timeout: 10,
      shell: "/bin/bash",
      env: { PATH: "/usr/bin", HOME: "/tmp", MY_SECRET: "x", FOO: "bar", NODE_ENV: "test", NODE_OPTIONS: "--require /tmp/evil.js" },
    }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(result.result.decision).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-SHELL-INDIRECT")).toBe(true);
    expect(result.env.MY_SECRET).toBeUndefined();
    expect(result.env.FOO).toBeUndefined();
    expect(result.env.NODE_OPTIONS).toBeUndefined();
    expect(result.env.NODE_ENV).toBe("test");
    expect(result.env.PATH).toBe("/usr/bin");
  });

  test("shell hook carga la politica del cwd real de la operacion", async () => {
    writeProjectPolicy({
      shell: {
        deniedCommands: ["echo target-policy"],
      },
    });

    const result = await evaluateShellHook({
      command: "echo target-policy",
      cwd: repo,
      timeout: 10,
      shell: "/bin/bash",
      env: { PATH: process.env.PATH },
    }, {
      cwd: home,
      permissionRegistered: true,
      shellRegistered: true,
      resolveSessionDirectory: async () => { throw new Error("no debe consultarse"); },
      env,
    });

    expect(result.result.decision).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-SHELL-DENY")).toBe(true);

    const audit = fs.readFileSync(path.join(home, "audit", "security.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { project: string });
    expect(audit.at(-1)?.project).toBe("demo");
  });

  test("permission hook resuelve la ubicacion de la sesion en vez de la instancia", async () => {
    writeProjectPolicy({
      integrations: {
        enforceMcpToolAllowlist: true,
        allowedMcpTools: ["mcp_ok*"],
      },
    });

    const result = await evaluatePermission({
      sessionID: "ses_demo",
      action: "mcp_bad_search",
      resources: [],
      effect: "allow",
    }, {
      cwd: home,
      permissionRegistered: true,
      resolveSessionDirectory: async (sessionID) => sessionID === "ses_demo" ? repo : undefined,
      env,
    });

    expect(result.effect).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-MCP-ALLOWLIST")).toBe(true);
  });

  test("un fallo al resolver la sesion deniega en vez de usar la instancia", async () => {
    const result = await evaluateToolHook({
      sessionID: "ses_missing",
      tool: "read",
      input: { filePath: path.join(repo, "package.json") },
    }, {
      cwd: home,
      permissionRegistered: true,
      shellRegistered: true,
      resolveSessionDirectory: async () => { throw new Error("session unavailable"); },
      env,
    });

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-PLUGIN-POLICY")).toBe(true);
  });

  test("un control git sin mediacion bloquea shell en vez de presumir cobertura", async () => {
    writeProjectPolicy({ git: { scanOutgoingCommits: true } });

    const result = await evaluateShellHook({
      command: "echo hola",
      cwd: repo,
      timeout: 10,
      env: { PATH: process.env.PATH },
    }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(result.result.decision).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-POLICY-GAP")).toBe(true);
  });

  test("shell hook escanea secretos staged antes de un commit", async () => {
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(git(["init", "-q"]).exitCode).toBe(0);
    const fakeKey = ["sk", "123456789012345678901234"].join("-");
    fs.writeFileSync(path.join(repo, ".env"), `API_KEY='${fakeKey}'\n`, "utf8");
    expect(git(["add", ".env"]).exitCode).toBe(0);

    const result = await evaluateShellHook({
      command: "git commit -m 'test commit'",
      cwd: repo,
      timeout: 10,
      env: { PATH: process.env.PATH },
    }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(result.result.decision).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(true);
  });

  test("Code Mode/REPL queda bloqueado porque no es mediable", async () => {
    const tool = await evaluateToolHook({ tool: "code", input: { code: "..." } }, {
      cwd: repo,
      permissionRegistered: true,
      shellRegistered: true,
      env,
    });
    const permission = await evaluatePermission({
      action: "code",
      resources: [],
      effect: "allow",
    }, { cwd: repo, permissionRegistered: true, env });

    expect(tool.decision).toBe("deny");
    expect(tool.violations.some((violation) => violation.id === "MAL-HOOK-CODE-MODE")).toBe(true);
    expect(permission.effect).toBe("deny");
  });

  test("tool hook pide aprobacion para rutas fuera de raices sin borrar el control", async () => {
    writeProjectPolicy({ files: { requireApprovalOutsideRoots: true } });

    const result = await evaluateToolHook({
      tool: "read",
      input: { filePath: "/etc/hosts" },
    }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-FILE-ROOT")).toBe(true);
  });

  test("tool hook bloquea MCP fuera de allowlist", async () => {
    writeProjectPolicy({
      integrations: {
        enforceMcpToolAllowlist: true,
        allowedMcpTools: ["mcp_ok*"],
      },
    });

    const blocked = await evaluateToolHook({ tool: "mcp_bad", input: {} }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });
    const allowed = await evaluateToolHook({ tool: "mcp_ok_search", input: {} }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(blocked.decision).toBe("deny");
    expect(blocked.violations.some((violation) => violation.id === "MAL-HOOK-MCP-ALLOWLIST")).toBe(true);
    expect(allowed.decision).toBe("allow");
  });

  test("sesion bloquea secretos antes de prompt/contexto", async () => {
    writeProjectPolicy({ persistence: { blockSecrets: true } });

    const result = await evaluateSessionHook("session.prompt.before", {
      prompt: { text: `${["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ")}\nabc` },
    }, { cwd: repo, permissionRegistered: true, env });

    expect(result.decision).toBe("deny");
    const violation = result.violations.find((candidate) => candidate.id === "MAL-HOOK-EGRESS-SECRET");
    expect(violation?.message).toContain("private-key");
    expect(violation?.message).not.toContain("abc");
  });

  test("plugin registra hooks V2 reales y setup devuelve cleanup", async () => {
    const calls: Array<{ domain: string; name: string; callback: (input: Record<string, unknown>) => Promise<void> | void }> = [];
    const disposed: string[] = [];
    const hook = (domain: string) => (name: string, callback: (input: Record<string, unknown>) => Promise<void> | void) => {
      calls.push({ domain, name, callback });
      return { dispose: () => { disposed.push(`${domain}.${name}`); } };
    };
    const originalHome = process.env.MALAHOR_HOME;
    const originalOpenCodeDir = process.env.MALAHOR_OPENCODE_DIR;
    process.env.MALAHOR_HOME = home;
    process.env.MALAHOR_OPENCODE_DIR = opencode;
    fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "demo" }, null, 2)}\n`, "utf8");
    writeProjectPolicy({
      integrations: {
        enforceMcpToolAllowlist: true,
        allowedMcpTools: ["mcp_ok*"],
      },
    });

    try {
      const cleanup = await plugin.setup({
        location: { directory: home },
        session: {
          hook: hook("session"),
          get: async ({ sessionID }: { sessionID: string }) => ({
            id: sessionID,
            location: { directory: repo },
          }),
        },
        permission: { hook: hook("permission") },
        tool: { hook: hook("tool") },
        shell: { hook: hook("shell") },
        mcp: { transform: () => undefined },
        agent: { transform: () => undefined },
        command: { transform: () => undefined },
        skill: { transform: () => undefined },
        event: { subscribe: () => undefined },
        storage: {},
      });

      expect(typeof cleanup).toBe("function");
      expect(calls.map((call) => `${call.domain}.${call.name}`)).toEqual(expect.arrayContaining([
        "permission.evaluate",
        "tool.execute.before",
        "shell.create.before",
        "session.prompt",
        "session.context",
        "session.http.request",
      ]));

      const permission = calls.find((call) => call.domain === "permission" && call.name === "evaluate");
      const input: Record<string, unknown> = {
        sessionID: "ses_demo",
        action: "mcp_bad_search",
        resources: [],
        effect: "allow",
      };
      await permission?.callback(input);
      expect(input.effect).toBe("deny");

      const audit = fs.readFileSync(path.join(home, "audit", "security.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { project: string });
      expect(audit.at(-1)?.project).toBe("demo");

      const contextHooks = calls.filter((call) => call.domain === "session" && call.name === "context");
      const contextInput: Record<string, unknown> = {
        sessionID: "ses_demo",
        system: [{ type: "text", text: "base" }],
      };
      await contextHooks.at(-1)?.callback(contextInput);
      await contextHooks.at(-1)?.callback(contextInput);
      const system = contextInput.system as Array<{ text: string }>;
      expect(system).toHaveLength(1);
      expect(system[0]?.text).toContain(MALAHOR_PROTOCOL_MARKER);

      await (cleanup as () => Promise<void>)();
      expect(disposed).toContain("permission.evaluate");
    } finally {
      if (originalHome === undefined) delete process.env.MALAHOR_HOME;
      else process.env.MALAHOR_HOME = originalHome;
      if (originalOpenCodeDir === undefined) delete process.env.MALAHOR_OPENCODE_DIR;
      else process.env.MALAHOR_OPENCODE_DIR = originalOpenCodeDir;
    }
  });

  test("asset bundleado no importa el SDK de OpenCode y carga sin SDK", () => {
    const asset = path.join(import.meta.dir, "..", "assets", "opencode", "plugins", "malahor", "index.ts");
    const content = fs.readFileSync(asset, "utf8");
    expect(content.startsWith("// malahor-managed")).toBe(true);
    expect(content).not.toContain("@opencode-ai/plugin");
    expect(content).not.toContain("@opencode/plugin");

    const loaded = Bun.spawnSync([
      process.execPath,
      "-e",
      `import("${asset}").then((module) => console.log(typeof module.default.setup))`,
    ], {
      env: { ...process.env, MALAHOR_HOME: home, MALAHOR_OPENCODE_DIR: opencode },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(loaded.exitCode).toBe(0);
    expect(loaded.stdout.toString()).toContain("function");
  });

  test("ctx.mcp.transform registra Mnemo y conserva MCP ajeno", async () => {
    const originalHome = process.env.MALAHOR_HOME;
    const originalOpenCodeDir = process.env.MALAHOR_OPENCODE_DIR;
    process.env.MALAHOR_HOME = home;
    process.env.MALAHOR_OPENCODE_DIR = opencode;
    fs.mkdirSync(path.join(home, "mnemo"), { recursive: true });
    fs.writeFileSync(path.join(home, "mnemo", "index.js"), "// mnemo\n", "utf8");

    const sets: Array<{ name: string; config: Record<string, unknown> }> = [];
    const transforms: Array<(editor: {
      get: (name: string) => Record<string, unknown> | undefined;
      set: (name: string, config: Record<string, unknown>) => void;
    }) => void> = [];
    const editorState: Record<string, Record<string, unknown>> = {
      foreign: { type: "local", command: ["node", "/tmp/foreign.js"] },
      obsidian: { type: "local", command: ["legacy-obsidian"] },
    };
    const disposed: string[] = [];

    try {
      const cleanup = await plugin.setup({
        location: { directory: repo },
        mcp: {
          transform: (callback: (editor: typeof transforms[number] extends (editor: infer T) => void ? T : never) => void) => {
            transforms.push(callback);
            const editor = {
              get: (name: string) => editorState[name],
              set: (name: string, config: Record<string, unknown>) => {
                editorState[name] = config;
                sets.push({ name, config });
              },
            };
            callback(editor);
            return { dispose: () => { disposed.push("mcp.transform"); } };
          },
        },
      });

      expect(transforms).toHaveLength(1);
      expect(sets.find((entry) => entry.name === "mnemo")?.config).toMatchObject({
        type: "local",
        command: ["node", path.join(home, "mnemo", "index.js")],
        disabled: false,
      });
      expect(sets.some((entry) => entry.name === "foreign")).toBe(false);
      expect(sets.some((entry) => entry.name === "obsidian")).toBe(false);

      await (cleanup as () => Promise<void>)();
      expect(disposed).toContain("mcp.transform");
    } finally {
      if (originalHome === undefined) delete process.env.MALAHOR_HOME;
      else process.env.MALAHOR_HOME = originalHome;
      if (originalOpenCodeDir === undefined) delete process.env.MALAHOR_OPENCODE_DIR;
      else process.env.MALAHOR_OPENCODE_DIR = originalOpenCodeDir;
    }
  });

  test("ctx.mcp.transform no pisa Mnemo ajeno y conserva Obsidian remoto habilitado", async () => {
    const originalHome = process.env.MALAHOR_HOME;
    const originalOpenCodeDir = process.env.MALAHOR_OPENCODE_DIR;
    process.env.MALAHOR_HOME = home;
    process.env.MALAHOR_OPENCODE_DIR = opencode;
    fs.mkdirSync(path.join(home, "mnemo"), { recursive: true });
    fs.writeFileSync(path.join(home, "mnemo", "index.js"), "// mnemo\n", "utf8");
    fs.writeFileSync(path.join(home, "projects.json"), `${JSON.stringify({ demo: { context: "mnemo+graphify+obsidian" } })}\n`, "utf8");

    const sets: string[] = [];
    const state: Record<string, Record<string, unknown>> = {
      mnemo: { type: "local", command: ["node", "/tmp/other-mnemo.js"] },
      obsidian: { type: "remote", url: "https://obsidian.example/mcp", headers: { Authorization: "Bearer {env:OBSIDIAN_API_KEY}" } },
    };

    try {
      await plugin.setup({
        location: { directory: repo },
        mcp: {
          transform: (callback: (editor: {
            get: (name: string) => Record<string, unknown> | undefined;
            set: (name: string, config: Record<string, unknown>) => void;
          }) => void) => {
            callback({
              get: (name) => state[name],
              set: (name, config) => {
                state[name] = config;
                sets.push(name);
              },
            });
          },
        },
      });

      expect(sets).toEqual(["obsidian"]);
      expect(state.mnemo.command).toEqual(["node", "/tmp/other-mnemo.js"]);
      expect(state.obsidian.disabled).toBe(false);
      expect(state.obsidian.headers).toEqual({ Authorization: "Bearer {env:OBSIDIAN_API_KEY}" });
    } finally {
      if (originalHome === undefined) delete process.env.MALAHOR_HOME;
      else process.env.MALAHOR_HOME = originalHome;
      if (originalOpenCodeDir === undefined) delete process.env.MALAHOR_OPENCODE_DIR;
      else process.env.MALAHOR_OPENCODE_DIR = originalOpenCodeDir;
    }
  });
});
