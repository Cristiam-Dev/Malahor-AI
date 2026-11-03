import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  COMMIT_COMMAND_MARKER,
  createCommitWorkflowRegistry,
  registerCommitWorkflowTool,
  type CommitPreparationInput,
  type CommitWorkflowScope,
} from "../src/plugin/commit-workflow";

const SESSION = "ses_commit_workflow";
const SUBJECT = "🐛 fix(git): corrige autorización";

let root: string;
let repo: string;
let scope: CommitWorkflowScope;
let approvalRequests: Record<string, unknown>[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-commit-workflow-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({
    name: "commit-workflow-fixture",
    scripts: {
      typecheck: "tsc --noEmit",
      test: "bun test",
      build: "bun build src/a.ts --outdir dist",
    },
  }, null, 2)}\n`, "utf8");
  scope = {
    sessionID: SESSION,
    project: "demo",
    policyRevision: "policy-revision-1",
    mode: "executor",
    root: repo,
  };
  approvalRequests = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function preparation(overrides: Partial<CommitPreparationInput> = {}): CommitPreparationInput {
  return {
    paths: ["src/a.ts"],
    subject: SUBJECT,
    commands: {
      diagnostics: ["bun run typecheck"],
      tests: ["bun test"],
      build: ["bun run build"],
      stage: "git add -- src/a.ts",
      precommit: `malahor-ai git precommit --message '${SUBJECT}' --json`,
      commit: `git commit -m '${SUBJECT}' -m '- Mantiene los gates verificados.'`,
      verify: [
        "git status --short --branch --untracked-files=all",
        "git --no-pager log -1 --oneline",
      ],
    },
    ...overrides,
  };
}

async function request(
  text: string,
  registry = createCommitWorkflowRegistry(),
  selected: CommitWorkflowScope | undefined = scope,
) {
  const observed = await registry.observePrompt({
    sessionID: SESSION,
    messageID: "msg_user_commit",
    prompt: { text },
  }, async () => selected);
  return { registry, observed };
}

async function prepare(registry: ReturnType<typeof createCommitWorkflowRegistry>, input = preparation(), selected = scope) {
  return registry.prepare(input, {
    sessionID: SESSION,
    agent: "malahor",
    messageID: "msg_assistant_commit",
    id: "call_commit_prepare",
  }, selected, {
    assert: async (request) => {
      approvalRequests.push(structuredClone(request));
      const nativeInput: Record<string, unknown> = { ...request, effect: "allow" };
      expect(registry.evaluateApprovalPermission(nativeInput, selected)).toBe(true);
      expect(nativeInput.effect).toBe("ask");
    },
  }, async () => selected);
}

function shell(
  registry: ReturnType<typeof createCommitWorkflowRegistry>,
  command: string,
  boundary: "permission" | "tool",
  selected: CommitWorkflowScope = scope,
  call: { messageID: string; toolCallID: string } = {
    messageID: "msg_gate",
    toolCallID: "call_gate",
  },
) {
  return registry.authorizeShell({
    ...selected,
    cwd: repo,
    command,
    ...call,
    valid: true,
    boundary,
  });
}

describe("autorización estructural del commit local", () => {
  test("solo una orden inequívoca crea la solicitud; menciones y preguntas fallan cerradas", async () => {
    for (const text of [
      "commit",
      "comitea",
      "comitea los cambios",
      "haz el commit",
      "por favor, realiza el commit",
      "listo realiza el commit",
      "ok, haz el commit",
      "dale, comitea",
      "/malahor-commit",
      `${COMMIT_COMMAND_MARKER}\n\nEjecuta el flujo gestionado.`,
    ]) {
      const { observed } = await request(text);
      expect(observed).toMatchObject({ explicit: true, project: "demo" });
    }

    for (const text of [
      "¿puedes hacer commit?",
      "por qué los commits piden plan",
      "explica cómo comitear",
      "no hagas commit",
      "commit y push",
      "listo",
      "continúa",
      "fix(git): menciona commit",
    ]) {
      const { registry, observed } = await request(text);
      expect(observed.explicit).toBe(false);
      await expect(prepare(registry)).rejects.toThrow(/orden explícita|solicitud vigente/i);
    }
  });

  test("consume una sola vez cada comando cuando tool precede a permission", async () => {
    const { registry } = await request("comitea");
    const result = await prepare(registry);

    expect(result).toMatchObject({ paths: ["src/a.ts"], subject: SUBJECT, commands: 8 });
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({ action: "malahor_commit_manifest", save: [] });
    const commands = [
      ...preparation().commands.diagnostics,
      ...preparation().commands.tests,
      ...preparation().commands.build,
      preparation().commands.stage,
      preparation().commands.precommit,
      preparation().commands.commit,
      ...preparation().commands.verify,
    ];
    for (const [index, command] of commands.entries()) {
      const call = { messageID: `msg_gate_${index}`, toolCallID: `call_gate_${index}` };
      expect(shell(registry, command, "tool", scope, call)).toEqual({ effect: "allow" });
      expect(shell(registry, command, "tool", scope, call)).toEqual({ effect: "allow" });
      expect(shell(registry, command, "permission", scope, call)).toEqual({ effect: "allow" });
    }
    expect(shell(registry, commands.at(-1)!, "tool")).toEqual({ effect: "absent" });
    expect(shell(registry, commands[0]!, "tool")).toEqual({ effect: "absent" });
  });

  test("acepta la misma secuencia con comillas, espacios y Unicode distintos", async () => {
    const { registry } = await request("comitea");
    await prepare(registry);
    const commands = [
      ...preparation().commands.diagnostics,
      ...preparation().commands.tests,
      ...preparation().commands.build,
      preparation().commands.stage,
    ];
    for (const [index, command] of commands.entries()) {
      const call = { messageID: `msg_variant_${index}`, toolCallID: `call_variant_${index}` };
      expect(shell(registry, command, "tool", scope, call)).toEqual({ effect: "allow" });
      expect(shell(registry, command, "permission", scope, call)).toEqual({ effect: "allow" });
    }
    const precommit = preparation().commands.precommit;
    const variant = precommit.replace(/'/g, '"').replace(/--message\s+/, "--message   ");
    const call = { messageID: "msg_variant_precommit", toolCallID: "call_variant_precommit" };
    expect(shell(registry, variant, "tool", scope, call)).toEqual({ effect: "allow" });
    expect(shell(registry, variant, "permission", scope, call)).toEqual({ effect: "allow" });

    const commit = preparation().commands.commit;
    const commitCall = { messageID: "msg_variant_commit", toolCallID: "call_variant_commit" };
    expect(shell(registry, commit, "tool", scope, commitCall)).toEqual({ effect: "allow" });
    expect(shell(registry, commit, "permission", scope, commitCall)).toEqual({ effect: "allow" });
  });

  test("acepta el precommit sin comillas y con el subject dividido", async () => {
    const { registry } = await request("comitea");
    await prepare(registry);
    const commands = [
      ...preparation().commands.diagnostics,
      ...preparation().commands.tests,
      ...preparation().commands.build,
      preparation().commands.stage,
    ];
    for (const [index, command] of commands.entries()) {
      const call = { messageID: `msg_no_quotes_${index}`, toolCallID: `call_no_quotes_${index}` };
      expect(shell(registry, command, "tool", scope, call)).toEqual({ effect: "allow" });
      expect(shell(registry, command, "permission", scope, call)).toEqual({ effect: "allow" });
    }
    const precommit = preparation().commands.precommit;
    const withoutQuotes = precommit.replace(/'/g, "");
    const call = { messageID: "msg_no_quotes_precommit", toolCallID: "call_no_quotes_precommit" };
    expect(shell(registry, withoutQuotes, "tool", scope, call)).toEqual({ effect: "allow" });
    expect(shell(registry, withoutQuotes, "permission", scope, call)).toEqual({ effect: "allow" });
  });

  test("mantiene compatibilidad permission→tool y fronteras repetidas idempotentes", async () => {
    const { registry } = await request("comitea");
    await prepare(registry);
    const command = preparation().commands.diagnostics[0]!;
    const call = { messageID: "msg_permission_first", toolCallID: "call_permission_first" };

    expect(shell(registry, command, "permission", scope, call)).toEqual({ effect: "allow" });
    expect(shell(registry, command, "permission", scope, call)).toEqual({ effect: "allow" });
    expect(shell(registry, command, "tool", scope, call)).toEqual({ effect: "allow" });

    const next = preparation().commands.tests[0]!;
    const nextCall = { messageID: "msg_next", toolCallID: "call_next" };
    expect(shell(registry, next, "tool", scope, nextCall)).toEqual({ effect: "allow" });
    expect(shell(registry, next, "permission", scope, nextCall)).toEqual({ effect: "allow" });
  });

  test("invalida concurrencia, replay e identidad incompleta con un rechazo específico", async () => {
    const concurrent = await request("comitea");
    await prepare(concurrent.registry);
    const first = preparation().commands.diagnostics[0]!;
    expect(shell(concurrent.registry, first, "tool", scope, {
      messageID: "msg_in_flight", toolCallID: "call_in_flight",
    })).toEqual({ effect: "allow" });
    expect(shell(concurrent.registry, first, "permission", scope, {
      messageID: "msg_other", toolCallID: "call_other",
    })).toEqual({ effect: "deny", code: "COMMIT_GRANT_MISMATCH" });
    expect(shell(concurrent.registry, first, "permission")).toEqual({ effect: "absent" });

    const replay = await request("comitea");
    await prepare(replay.registry);
    const consumedCall = { messageID: "msg_consumed", toolCallID: "call_consumed" };
    expect(shell(replay.registry, first, "tool", scope, consumedCall)).toEqual({ effect: "allow" });
    expect(shell(replay.registry, first, "permission", scope, consumedCall)).toEqual({ effect: "allow" });
    expect(shell(replay.registry, preparation().commands.tests[0]!, "tool", scope, consumedCall))
      .toEqual({ effect: "deny", code: "COMMIT_GRANT_MISMATCH" });

    const missingIdentity = await request("comitea");
    await prepare(missingIdentity.registry);
    expect(missingIdentity.registry.authorizeShell({
      ...scope,
      cwd: repo,
      command: first,
      messageID: "",
      toolCallID: "",
      valid: false,
      boundary: "tool",
    })).toEqual({ effect: "deny", code: "COMMIT_GRANT_MISMATCH" });
  });

  test("reutiliza un ASK exacto del host sin solicitar otro diálogo", async () => {
    const { registry } = await request("comitea");
    const call = {
      sessionID: SESSION,
      agent: "malahor",
      messageID: "msg_host_manifest",
      id: "call_host_manifest",
    };
    expect(registry.observePreparationPermission({
      scope,
      action: "malahor_commit_prepare",
      effect: "ask",
      source: { type: "tool", messageID: call.messageID, id: call.id },
    })).toBe(true);

    const result = await registry.prepare(
      preparation(),
      call,
      scope,
      { assert: async () => { throw new Error("no debe pedir otro ASK"); } },
      async () => scope,
    );

    expect(result).toMatchObject({ paths: ["src/a.ts"], subject: SUBJECT });
  });

  test("invalida el grant si cambia el manifest o el scope durante la aprobación", async () => {
    const changedManifest = await request("comitea");
    const mutable = preparation();
    await expect(changedManifest.registry.prepare(
      mutable,
      {
        sessionID: SESSION,
        agent: "malahor",
        messageID: "msg_mutable_manifest",
        id: "call_mutable_manifest",
      },
      scope,
      {
        assert: async (request) => {
          const nativeInput: Record<string, unknown> = { ...request, effect: "allow" };
          expect(changedManifest.registry.evaluateApprovalPermission(nativeInput, scope)).toBe(true);
          mutable.commands.tests = ["bun test tests/changed.test.ts"];
        },
      },
      async () => scope,
    )).rejects.toThrow(/cambió/i);

    const changedScope = await request("comitea");
    await expect(changedScope.registry.prepare(
      preparation(),
      {
        sessionID: SESSION,
        agent: "malahor",
        messageID: "msg_changed_scope",
        id: "call_changed_scope",
      },
      scope,
      {
        assert: async (request) => {
          const nativeInput: Record<string, unknown> = { ...request, effect: "allow" };
          expect(changedScope.registry.evaluateApprovalPermission(nativeInput, scope)).toBe(true);
        },
      },
      async () => ({ ...scope, policyRevision: "policy-revision-2" }),
    )).rejects.toThrow(/modo|política|proyecto/i);
  });

  test("un prompt nuevo invalida tanto la solicitud pendiente como el grant", async () => {
    const pending = await request("comitea");
    await pending.registry.observePrompt({ sessionID: SESSION, prompt: { text: "continúa" } }, async () => scope);
    await expect(prepare(pending.registry)).rejects.toThrow(/orden explícita|solicitud vigente/i);

    const granted = await request("comitea");
    await prepare(granted.registry);
    await granted.registry.observePrompt({ sessionID: SESSION, prompt: { text: "muéstrame el estado" } }, async () => scope);
    expect(shell(granted.registry, "bun run typecheck", "tool")).toEqual({ effect: "absent" });
  });

  test("cualquier cambio de comando, cwd, proyecto o revisión invalida el grant", async () => {
    for (const changed of [
      { command: "bun run lint" },
      { cwd: path.join(repo, "src") },
      { project: "other" },
      { policyRevision: "policy-revision-2" },
      { mode: "advisor" as const },
    ]) {
      const { registry } = await request("comitea");
      await prepare(registry);
      const attempt = registry.authorizeShell({
        ...scope,
        cwd: repo,
        command: "bun run typecheck",
        messageID: "msg_changed",
        toolCallID: "call_changed",
        valid: true,
        boundary: "tool",
        ...changed,
      });
      expect(attempt).toEqual({ effect: "deny", code: "COMMIT_GRANT_MISMATCH" });
      expect(shell(registry, "bun run typecheck", "tool")).toEqual({ effect: "absent" });
    }
  });

  test("rechaza paths, subjects y comandos que amplían el flujo de commit ordinario", async () => {
    fs.mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");

    const cases: CommitPreparationInput[] = [
      preparation({ subject: "fix: sin emoji" }),
      preparation({ paths: ["src"] }),
      preparation({
        paths: [".github/workflows/ci.yml"],
        commands: { ...preparation().commands, stage: "git add -- .github/workflows/ci.yml" },
      }),
      preparation({ commands: { ...preparation().commands, diagnostics: ["git fetch origin"] } }),
      preparation({ commands: { ...preparation().commands, diagnostics: ["bun install"] } }),
      preparation({ commands: { ...preparation().commands, stage: "git add -A" } }),
      preparation({ commands: { ...preparation().commands, commit: `git commit --amend -m '${SUBJECT}'` } }),
      preparation({ commands: { ...preparation().commands, commit: `git commit -am '${SUBJECT}'` } }),
      preparation({ commands: { ...preparation().commands, precommit: "malahor-ai git commit-fallback --message x" } }),
      preparation({ commands: { ...preparation().commands, build: ["bun run build && git push"] } }),
      preparation({ commands: { ...preparation().commands, build: ["bun run build & touch owned"] } }),
      preparation({ commands: { ...preparation().commands, tests: ["bun test $HOME/evil.test.ts"] } }),
      preparation({ commands: { ...preparation().commands, tests: ["bun test ../evil.test.ts"] } }),
      preparation({ commands: { ...preparation().commands, diagnostics: ["../../tmp/tsc --noEmit"] } }),
      preparation({ commands: { ...preparation().commands, stage: "/tmp/git add -- src/a.ts" } }),
      preparation({ commands: { ...preparation().commands, commit: `/tmp/git commit -m '${SUBJECT}'` } }),
      preparation({ commands: { ...preparation().commands, precommit: `malahor-ai git precommit --profile off --message '${SUBJECT}' --json` } }),
      preparation({ commands: { ...preparation().commands, precommit: `malahor-ai git precommit --project other --message '${SUBJECT}' --json` } }),
    ];

    for (const candidate of cases) {
      const { registry } = await request("comitea");
      await expect(prepare(registry, candidate)).rejects.toThrow();
    }
  });

  test("un manifest estructuralmente inválido no consume la orden y admite corrección en el mismo scope", async () => {
    const { registry } = await request("comitea");

    await expect(prepare(registry, preparation({ subject: "fix: sin emoji" }))).rejects.toThrow(/subject/i);
    expect(approvalRequests).toHaveLength(0);

    const corrected = await prepare(registry);
    expect(corrected).toMatchObject({ paths: ["src/a.ts"], subject: SUBJECT });
    expect(approvalRequests).toHaveLength(1);
  });

  test("el stage acepta el mismo conjunto exacto de rutas en cualquier orden", async () => {
    fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 1;\n", "utf8");
    const { registry } = await request("comitea");
    const permuted = preparation({
      paths: ["src/b.ts", "src/a.ts"],
      commands: {
        ...preparation().commands,
        stage: "git add -- src/b.ts src/a.ts",
      },
    });

    const result = await prepare(registry, permuted);

    expect(result.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(approvalRequests).toHaveLength(1);
  });

  test("rechaza duplicados y rutas ajenas al conjunto del stage sin consumir la orden", async () => {
    fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 1;\n", "utf8");
    const { registry } = await request("comitea");

    await expect(prepare(registry, preparation({
      commands: { ...preparation().commands, stage: "git add -- src/a.ts src/a.ts" },
    }))).rejects.toThrow(/coincide|duplicad/i);
    expect(approvalRequests).toHaveLength(0);

    await expect(prepare(registry, preparation({
      commands: { ...preparation().commands, stage: "git add -- src/a.ts src/b.ts" },
    }))).rejects.toThrow(/coincide|duplicad/i);
    expect(approvalRequests).toHaveLength(0);

    const corrected = await prepare(registry);
    expect(corrected).toMatchObject({ paths: ["src/a.ts"] });
    expect(approvalRequests).toHaveLength(1);
  });

  test("solo el primario y el mismo scope pueden consumir la solicitud", async () => {
    const { registry } = await request("comitea");
    await expect(registry.prepare(preparation(), {
      sessionID: SESSION,
      agent: "malahor-testing",
      messageID: "msg_specialist",
      id: "call_specialist",
    }, scope, { assert: async () => undefined }, async () => scope)).rejects.toThrow(/primario/i);

    const second = await request("comitea");
    await expect(prepare(second.registry, preparation(), { ...scope, project: "other" }))
      .rejects.toThrow(/proyecto|scope|vigente/i);
  });

  test("la tool gestionada aprueba nativamente el manifest sin estado de Planning", async () => {
    const { registry } = await request("/malahor-commit");
    const definitions = new Map<string, Record<string, unknown>>();
    await registerCommitWorkflowTool({
      transform: async (callback) => {
        callback({
          namespace: () => undefined,
          add: (definition) => { definitions.set(String(definition.name), definition); },
        });
      },
    }, registry, async () => scope, {
      assert: async (request) => {
        approvalRequests.push(structuredClone(request));
        const nativeInput: Record<string, unknown> = { ...request, effect: "allow" };
        expect(registry.evaluateApprovalPermission(nativeInput, scope)).toBe(true);
        expect(nativeInput.effect).toBe("ask");
      },
    });

    const definition = definitions.get("commit_prepare");
    expect(definition?.options).toEqual({ namespace: "malahor", codemode: false });
    const schema = definition?.input as {
      additionalProperties?: boolean;
      properties?: { commands?: { additionalProperties?: boolean; required?: string[] } };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.commands?.additionalProperties).toBe(false);
    expect(schema.properties?.commands?.required).toEqual([
      "diagnostics", "tests", "build", "stage", "precommit", "commit", "verify",
    ]);
    const execute = definition?.execute as ((value: unknown, call: Record<string, string>) => Promise<{
      content: string;
      metadata: Record<string, unknown>;
    }>) | undefined;
    expect(typeof execute).toBe("function");
    const result = await execute!(preparation(), {
      sessionID: SESSION,
      agent: "malahor",
      messageID: "msg_prepare_tool",
      id: "call_prepare_tool",
    });
    expect(result.content).toMatch(/sin|exactos|orden/i);
    expect(result.metadata).toMatchObject({ kind: "malahor.commit.grant", version: 1, paths: 1, commands: 8 });
    expect(approvalRequests).toHaveLength(1);
    expect(shell(registry, "bun run typecheck", "tool")).toEqual({ effect: "allow" });
  });
});
