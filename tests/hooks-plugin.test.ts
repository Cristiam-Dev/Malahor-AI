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
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-EGRESS-SECRET")).toBe(true);
  });

  test("plugin registra hooks V2 reales y setup devuelve cleanup", async () => {
    const calls: Array<{ domain: string; name: string; callback: (input: Record<string, unknown>) => Promise<void> | void }> = [];
    const disposed: string[] = [];
    const hook = (domain: string) => (name: string, callback: (input: Record<string, unknown>) => Promise<void> | void) => {
      calls.push({ domain, name, callback });
      return { dispose: () => { disposed.push(`${domain}.${name}`); } };
    };
    const originalHome = process.env.MALAHOR_HOME;
    process.env.MALAHOR_HOME = home;
    fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "demo" }, null, 2)}\n`, "utf8");

    try {
      const cleanup = await plugin.setup({
        location: { directory: repo },
        session: { hook: hook("session") },
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
      const input: Record<string, unknown> = { action: "bash", resources: ["git reset --hard"], effect: "allow" };
      await permission?.callback(input);
      expect(input.effect).toBe("deny");

      await (cleanup as () => Promise<void>)();
      expect(disposed).toContain("permission.evaluate");
    } finally {
      if (originalHome === undefined) delete process.env.MALAHOR_HOME;
      else process.env.MALAHOR_HOME = originalHome;
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
});
