import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { consumeApproval, grantApproval } from "../src/cli/core/hooks/approvals";
import { buildAuditEntry } from "../src/cli/core/hooks/audit";
import { assertHooksAllowed, evaluateHookRules, runHooks } from "../src/cli/core/hooks/engine";
import { validateSecurityLayer } from "../src/cli/core/hooks/security-policy";
import type {
  HookContext,
  HookPolicyMeta,
  HookRule,
  SecurityLayer,
} from "../src/cli/core/hooks/types";
import { inspectPluginState } from "../src/cli/core/plugin-health";
import { resolvePaths } from "../src/cli/core/paths";
import { dbPath, saveDb, type MnemoDb, type Observation } from "../src/mnemo/db";
import { callTool } from "../src/mnemo/tools";
import plugin from "../src/plugin/index";

const ENVIRONMENT_KEYS = [
  "MALAHOR_HOME",
  "MALAHOR_CONFIG",
  "MALAHOR_OPENCODE_DIR",
  "MALAHOR_OPENCODE_DETECT",
  "MALAHOR_MEMORY_BOUND",
  "MALAHOR_MEMORY_PROJECT",
] as const;

interface Sandbox {
  root: string;
  home: string;
  repo: string;
  otherRepo: string;
  opencode: string;
  previous: Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;
}

let sandbox: Sandbox;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-security-acceptance-"));
  const home = path.join(root, ".malahor");
  const repo = path.join(root, "acme-repo");
  const otherRepo = path.join(root, "globex-repo");
  const opencode = path.join(root, "opencode");
  const previous = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])) as Sandbox["previous"];

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(otherRepo, { recursive: true });
  fs.mkdirSync(opencode, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "acme" }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(otherRepo, "package.json"), `${JSON.stringify({ name: "globex" }, null, 2)}\n`, "utf8");

  process.env.MALAHOR_HOME = home;
  process.env.MALAHOR_CONFIG = path.join(root, "config.jsonc");
  process.env.MALAHOR_OPENCODE_DIR = opencode;
  process.env.MALAHOR_OPENCODE_DETECT = "0";
  delete process.env.MALAHOR_MEMORY_BOUND;
  delete process.env.MALAHOR_MEMORY_PROJECT;

  fs.writeFileSync(process.env.MALAHOR_CONFIG, "{}\n", "utf8");
  fs.writeFileSync(path.join(home, "projects.json"), `${JSON.stringify({
    acme: { context: "memory", roots: [repo], defaultRoot: repo },
    globex: { context: "memory", roots: [otherRepo], defaultRoot: otherRepo },
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  sandbox = { root, home, repo, otherRepo, opencode, previous };
});

afterEach(() => {
  for (const key of ENVIRONMENT_KEYS) {
    const value = sandbox.previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

function policyMeta(overrides: Partial<HookPolicyMeta> = {}): HookPolicyMeta {
  return {
    contractVersion: 1,
    schemaVersion: 1,
    policyVersion: "t-5.5.5",
    issuer: "synthetic-test",
    policyHash: "a".repeat(64),
    sources: [],
    corporateStatus: "absent",
    corporateRequired: false,
    criticalGaps: [],
    warnings: [],
    ...overrides,
  };
}

function hookContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    event: "file.read.before",
    harness: "opencode",
    profile: "off",
    cwd: sandbox.repo,
    projectRoot: sandbox.repo,
    malahorHome: sandbox.home,
    project: "acme",
    client: "acme",
    policyMeta: policyMeta(),
    audit: { enabled: false },
    ...overrides,
  };
}

function hasViolation(result: ReturnType<typeof runHooks>, id: string): boolean {
  return result.violations.some((violation) => violation.id === id);
}

function syntheticMemory(): MnemoDb {
  const observation = (id: number, project: string, title: string, content: string): Observation => ({
    id,
    project,
    type: "general",
    title,
    content,
    tags: "t-5.5.5,synthetic",
    created_at: `2026-11-01T00:00:0${id}.000Z`,
  });
  return {
    observations: [
      observation(1, "global", "Global synthetic", "global-only-marker"),
      observation(2, "acme", "Acme root", "shared-marker acme-only-marker"),
      observation(3, "acme/store", "Acme store", "shared-marker checkout"),
      observation(4, "acme/store/checkout", "Acme checkout", "shared-marker payments"),
      observation(5, "globex", "Globex root", "shared-marker globex-only-marker"),
      observation(6, "globex/payments", "Globex payments", "shared-marker private-ledger"),
    ],
    sessions: [
      { project: "global", summary: "global-only-session", created_at: "2026-11-01T00:00:01.000Z" },
      { project: "acme/store", summary: "acme-only-session", created_at: "2026-11-01T00:00:02.000Z" },
      { project: "globex/payments", summary: "globex-only-session", created_at: "2026-11-01T00:00:03.000Z" },
    ],
    nextId: 7,
  };
}

function belongsTo(project: string, owner: string): boolean {
  return project === owner || project.startsWith(`${owner}/`);
}

describe("T-5.5.5: aceptación antielusión del runtime", () => {
  test("el suelo bajo profile off conserva infraestructura, symlinks, dry-run y control previo", () => {
    const workflows = path.join(sandbox.repo, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.symlinkSync(workflows, path.join(sandbox.repo, "automation"), "dir");

    const protectedWrite = hookContext({
      event: "file.write.before",
      resourceKind: "filesystem",
      targetPaths: ["automation/release.yml"],
      confirmation: "CHECKS_OK",
      metadata: {
        planID: "plan-synthetic",
        revision: "revision-synthetic",
        userExplicitlyRequestedCommit: true,
      },
    });
    const write = runHooks(protectedWrite);
    expect(write.decision).toBe("ask");
    expect(hasViolation(write, "MAL-HOOK-INFRA-APPROVAL")).toBe(true);
    expect(() => assertHooksAllowed(protectedWrite)).toThrow(/ASK pendiente/);

    const dryRun = runHooks(hookContext({
      event: "shell.exec.before",
      command: "kubectl apply --dry-run=server -f k8s/prod.yaml",
    }));
    expect(dryRun.decision).toBe("allow");

    for (const command of [
      "kubectl apply -f k8s/prod.yaml",
      "bash -c 'npm publish'",
    ]) {
      const mutation = runHooks(hookContext({
        event: "shell.exec.before",
        command,
        confirmation: "CHECKS_OK",
        metadata: { planID: "plan-synthetic", checksVerified: true },
      }));
      expect(mutation.decision).toBe("ask");
      expect(hasViolation(mutation, "MAL-HOOK-INFRA-APPROVAL")).toBe(true);
    }

    const unresolvedWrite = runHooks(hookContext({
      event: "file.write.before",
      targetPaths: [],
    }));
    expect(unresolvedWrite.decision).toBe("ask");
    expect(hasViolation(unresolvedWrite, "MAL-HOOK-INFRA-APPROVAL")).toBe(true);
  });

  test("ASK, DENY, errores críticos, approvals y auditoría fallan cerrado sin payloads", () => {
    const criticalRules: HookRule[] = [{
      id: "synthetic-timeout",
      run: () => { throw new Error("timeout-with-sensitive-payload"); },
    }];
    const critical = evaluateHookRules(hookContext(), criticalRules);
    expect(critical).toEqual([expect.objectContaining({
      id: "MAL-HOOK-CONTROL-ERROR",
      decision: "deny",
    })]);
    expect(JSON.stringify(critical)).not.toContain("timeout-with-sensitive-payload");

    const denied = hookContext({
      event: "git.push.before",
      command: "git push origin main",
      approval: "f".repeat(64),
    });
    expect(runHooks(denied).decision).toBe("deny");
    expect(() => assertHooksAllowed(denied)).toThrow(/remota prohibida|hard DENY/i);

    const exact = hookContext({
      event: "file.write.before",
      resourceKind: "filesystem",
      targetPaths: [".github/workflows/ci.yml"],
      command: "",
    });
    const approval = grantApproval(exact, { channel: "opencode-ui", ttlSeconds: 60 });
    expect(consumeApproval(approval.nonce, { ...exact, targetPaths: [".github/workflows/other.yml"] }).ok).toBe(false);
    expect(consumeApproval(approval.nonce, { ...exact, event: "file.stage.before" }).ok).toBe(false);
    expect(consumeApproval(approval.nonce, { ...exact, client: "globex" }).ok).toBe(false);
    expect(consumeApproval(approval.nonce, {
      ...exact,
      policyMeta: policyMeta({ policyHash: "b".repeat(64) }),
    }).ok).toBe(false);
    expect(consumeApproval(approval.nonce, exact).ok).toBe(true);
    expect(consumeApproval(approval.nonce, exact).ok).toBe(false);

    const unavailableAudit = path.join(sandbox.root, "audit-is-a-file");
    fs.writeFileSync(unavailableAudit, "not-a-directory", "utf8");
    expect(() => assertHooksAllowed(hookContext({
      event: "context.save.before",
      malahorHome: unavailableAudit,
      security: { audit: { required: true } },
      audit: { enabled: true, required: true },
    }))).toThrow(/Auditoria obligatoria/);

    const rawSecret = "synthetic-secret-should-not-leak";
    const rawPii = "synthetic.person@example.invalid";
    const sensitive = hookContext({
      event: "session.prompt.before",
      command: `send --token ${rawSecret}`,
      targetPaths: [`attachments/${rawPii}.txt`],
      security: { persistence: { blockSecrets: true } },
      metadata: {
        secretDetected: true,
        secretKinds: ["api-token"],
        prompt: `${rawSecret} ${rawPii}`,
      },
    });
    const result = runHooks(sensitive);
    const serialized = JSON.stringify({ result, audit: buildAuditEntry(sensitive, result) });
    expect(result.decision).toBe("deny");
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawPii);
  });

  test("Code Mode queda bloqueado y un hooks check voluntario no fabrica cobertura ni certificación", () => {
    for (const tool of ["execute", "python", "repl"]) {
      const result = runHooks(hookContext({
        event: "tool.execute.before",
        metadata: { tool },
      }));
      expect(result.decision).toBe("deny");
      expect(hasViolation(result, "MAL-HOOK-CODE-MODE")).toBe(true);
    }

    const afterMetadata = { response: "synthetic-response-payload" };
    const after = runHooks(hookContext({
      event: "session.http-response.after",
      metadata: afterMetadata,
    }));
    expect(after.decision).toBe("allow");
    expect(afterMetadata).toEqual({ response: "synthetic-response-payload" });

    const state = {
      schema: 1,
      plugin: "malahor",
      pluginVersion: "0.5.0",
      host: "v2",
      capabilities: { "permission.evaluate": false },
      degraded: [],
      criticalGaps: ["permission.evaluate"],
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const stateFile = path.join(sandbox.home, "plugin-state.json");
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const before = fs.readFileSync(stateFile, "utf8");
    const check = callTool({
      name: "malahor_hook_check",
      arguments: {
        event: "file.read.before",
        resourceKind: "filesystem",
        paths: [path.join(sandbox.repo, "package.json")],
        metadata: { project: "acme" },
      },
    }) as { decision: string };
    expect(check.decision).toBe("allow");
    expect(fs.readFileSync(stateFile, "utf8")).toBe(before);

    const health = inspectPluginState({
      paths: resolvePaths(process.env, sandbox.repo),
      host: { kind: "v2", version: "2.0.0" },
      packagePaths: null,
    });
    expect(health.status).toBe("fail");
    expect(health.message).toContain("criticalGaps=permission.evaluate");

    const certification = validateSecurityLayer({
      schemaVersion: 1,
      contractVersion: 1,
      policyVersion: "synthetic",
      issuer: "synthetic-test",
      issuedAt: "2026-11-01T00:00:00.000Z",
      controls: { host: { doctorMayCertify: true } },
    } as unknown as SecurityLayer, { strict: true });
    expect(certification.ok).toBe(false);
    expect(certification.errors.some((error) => error.includes("host.doctorMayCertify"))).toBe(true);
  });

  test("la identidad de proyecto vinculada filtra get, related, ancestros, global, search, tree y rollup", () => {
    saveDb(syntheticMemory());
    expect(fs.realpathSync(dbPath())).toContain(fs.realpathSync(sandbox.home));
    process.env.MALAHOR_MEMORY_BOUND = "1";
    process.env.MALAHOR_MEMORY_PROJECT = "acme";

    const owned = callTool({ name: "mem_get", arguments: { id: 3 } }) as Observation;
    expect(owned.project).toBe("acme/store");
    for (const id of [1, 5, 6]) {
      expect(() => callTool({ name: "mem_get", arguments: { id } })).toThrow(/identidad|proyecto|autorizad/i);
    }

    const context = callTool({
      name: "mem_context",
      arguments: { project: "acme/store", rollup: true, limit: 20 },
    }) as {
      observations: Observation[];
      latestSession: { project: string } | null;
      scopeChain: string[];
      rollupScopes: string[];
    };
    expect(context.observations.every((item) => belongsTo(item.project, "acme"))).toBe(true);
    expect(context.latestSession && belongsTo(context.latestSession.project, "acme")).not.toBe(false);
    expect(context.scopeChain.every((scope) => belongsTo(scope, "acme"))).toBe(true);
    expect(context.rollupScopes.every((scope) => belongsTo(scope, "acme"))).toBe(true);

    const brief = callTool({
      name: "mem_brief",
      arguments: { request: "shared-marker", project: "acme/store", limit: 20, relatedLimit: 20 },
    }) as {
      observations: Observation[];
      relatedMemories: Observation[];
      scopeSuggestions: Array<{ scope: string }>;
      scopeChain: string[];
    };
    expect([...brief.observations, ...brief.relatedMemories].every((item) => belongsTo(item.project, "acme"))).toBe(true);
    expect(brief.scopeSuggestions.every((item) => belongsTo(item.scope, "acme"))).toBe(true);
    expect(brief.scopeChain.every((scope) => belongsTo(scope, "acme"))).toBe(true);

    const search = callTool({
      name: "mem_search",
      arguments: { query: "shared-marker", limit: 20 },
    }) as Observation[];
    expect(search.length).toBeGreaterThan(0);
    expect(search.every((item) => belongsTo(item.project, "acme"))).toBe(true);

    const tree = callTool({ name: "mem_tree", arguments: {} }) as Array<{ path: string }>;
    expect(tree.length).toBeGreaterThan(0);
    expect(tree.every((entry) => belongsTo(entry.path, "acme"))).toBe(true);

    const projects = callTool({ name: "mem_list_projects" }) as Array<{ project: string }>;
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.every((entry) => belongsTo(entry.project, "acme"))).toBe(true);

    for (const invocation of [
      () => callTool({ name: "mem_context", arguments: { project: "global" } }),
      () => callTool({ name: "mem_context", arguments: { project: "globex/payments" } }),
      () => callTool({ name: "mem_brief", arguments: { request: "private-ledger", project: "globex" } }),
      () => callTool({ name: "mem_search", arguments: { project: "globex", subtree: true } }),
      () => callTool({ name: "mem_tree", arguments: { prefix: "globex" } }),
      () => callTool({ name: "mem_save", arguments: { project: "globex", title: "cross", content: "denied" } }),
      () => callTool({ name: "mem_backup" }),
    ]) {
      expect(invocation).toThrow(/identidad|proyecto|global|autorizad|autoridad/i);
    }

    delete process.env.MALAHOR_MEMORY_PROJECT;
    expect(() => callTool({ name: "mem_search", arguments: { query: "shared-marker" } }))
      .toThrow(/identidad.*ausente|acceso denegado/i);
  });

  test("el plugin registra Mnemo sin Code Mode y vinculado al proyecto existente", async () => {
    fs.mkdirSync(path.join(sandbox.home, "mnemo"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(sandbox.home, "docs"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sandbox.home, "mnemo", "index.js"), "// synthetic mnemo\n", "utf8");
    fs.writeFileSync(path.join(sandbox.home, "docs", "index.js"), "// synthetic docs\n", "utf8");

    const configurations: Record<string, Record<string, unknown>> = {};
    const cleanup = await plugin.setup({
      location: { directory: sandbox.repo, project: { canonical: sandbox.repo } },
      mcp: {
        transform: (callback: (editor: {
          get(name: string): Record<string, unknown> | undefined;
          set(name: string, config: Record<string, unknown>): void;
        }) => void) => {
          callback({
            get: (name) => configurations[name],
            set: (name, config) => { configurations[name] = config; },
          });
        },
      },
    });

    expect(configurations.mnemo).toMatchObject({
      type: "local",
      command: ["node", path.join(sandbox.home, "mnemo", "index.js")],
      disabled: false,
      codemode: false,
      environment: {
        MALAHOR_MEMORY_BOUND: "1",
        MALAHOR_MEMORY_PROJECT: "acme",
      },
    });
    expect(configurations.docs).toMatchObject({ codemode: false });
    if (typeof cleanup === "function") await cleanup();
  });

  test("una afinidad de proyecto contradictoria deshabilita Mnemo en vez de elegir un cliente", async () => {
    fs.mkdirSync(path.join(sandbox.home, "mnemo"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(sandbox.home, "docs"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sandbox.home, "mnemo", "index.js"), "// synthetic mnemo\n", "utf8");
    fs.writeFileSync(path.join(sandbox.home, "docs", "index.js"), "// synthetic docs\n", "utf8");

    const configurations: Record<string, Record<string, unknown>> = {};
    const cleanup = await plugin.setup({
      location: { directory: sandbox.repo, project: { canonical: "globex" } },
      mcp: {
        transform: (callback: (editor: {
          get(name: string): Record<string, unknown> | undefined;
          set(name: string, config: Record<string, unknown>): void;
        }) => void) => callback({
          get: (name) => configurations[name],
          set: (name, config) => { configurations[name] = config; },
        }),
      },
    });

    expect(configurations.mnemo).toMatchObject({
      disabled: true,
      codemode: false,
      environment: { MALAHOR_MEMORY_BOUND: "1" },
    });
    expect(configurations.mnemo?.environment).not.toHaveProperty("MALAHOR_MEMORY_PROJECT");
    if (typeof cleanup === "function") await cleanup();
  });
});
