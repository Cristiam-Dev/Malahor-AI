import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  POINT_ACTION_APPROVAL,
  createPointActionMediator,
  type PointActionCall,
  type PointActionScope,
} from "../src/plugin/point-action-approval";

const SESSION = "ses_point_action";

let root: string;
let repo: string;
let target: string;
let scope: PointActionScope;
let call: PointActionCall;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-point-action-"));
  repo = path.join(root, "repo");
  target = path.join(repo, "src", "a.ts");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "export const value = 1;\n", "utf8");
  scope = {
    sessionID: SESSION,
    project: "demo",
    policyRevision: "a".repeat(32),
    mode: "executor",
    root: repo,
  };
  call = {
    sessionID: SESSION,
    agent: "malahor",
    messageID: "msg_point_action",
    id: "call_point_action",
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("aprobación nativa de acciones puntuales", () => {
  test("una edición elegible solicita exactamente un ASK nativo y revalida antes del efecto", async () => {
    const mediator = createPointActionMediator();
    const approvals: Record<string, unknown>[] = [];
    let revalidations = 0;

    const authorized = await mediator.authorizeTool({
      scope,
      directory: repo,
      tool: "edit",
      value: { filePath: target, oldString: "value = 1", newString: "value = 2" },
      call,
      approval: {
        assert: async (request) => {
          approvals.push(structuredClone(request));
          const nativeInput: Record<string, unknown> = { ...request, effect: "allow" };
          expect(mediator.evaluateApprovalPermission(nativeInput, scope)).toBe(true);
          expect(nativeInput.effect).toBe("ask");
          expect(String(nativeInput.message)).toContain("src/a.ts");
        },
      },
      revalidate: async () => {
        revalidations += 1;
        return { scope, noActivePlan: true };
      },
    });

    expect(authorized).toBe(true);
    expect(revalidations).toBe(1);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      sessionID: SESSION,
      agent: "malahor",
      action: POINT_ACTION_APPROVAL,
      save: [],
    });
  });

  test("reutiliza un ASK exacto del host sin producir un segundo diálogo", async () => {
    const mediator = createPointActionMediator();
    expect(mediator.observePermission({
      scope,
      directory: repo,
      action: "edit",
      resources: [target],
      effect: "ask",
      source: { type: "tool", messageID: call.messageID, id: call.id },
      toolRegistered: true,
    })).toBe(true);

    const authorized = await mediator.authorizeTool({
      scope,
      directory: repo,
      tool: "write",
      value: { path: target, content: "export const value = 2;\n" },
      call,
      approval: { assert: async () => { throw new Error("no debe pedir otro ASK"); } },
      revalidate: async () => ({ scope, noActivePlan: true }),
    });

    expect(authorized).toBe(true);
  });

  test("un cambio de scope, Planning o manifest invalida la aprobación", async () => {
    for (const fresh of [
      { scope: { ...scope, policyRevision: "b".repeat(32) }, noActivePlan: true },
      { scope, noActivePlan: false },
    ]) {
      const mediator = createPointActionMediator();
      await expect(mediator.authorizeTool({
        scope,
        directory: repo,
        tool: "edit",
        value: { path: target, oldString: "value = 1", newString: "value = 2" },
        call,
        approval: {
          assert: async (request) => {
            const nativeInput: Record<string, unknown> = { ...request, effect: "allow" };
            expect(mediator.evaluateApprovalPermission(nativeInput, scope)).toBe(true);
          },
        },
        revalidate: async () => fresh,
      })).rejects.toThrow(/cambió|Planning/i);
    }

    const invalidated = createPointActionMediator();
    await expect(invalidated.authorizeTool({
      scope,
      directory: repo,
      tool: "write",
      value: { path: target, content: "export const value = 2;\n" },
      call,
      approval: {
        assert: async (request) => {
          const nativeInput: Record<string, unknown> = { ...request, effect: "allow" };
          expect(invalidated.evaluateApprovalPermission(nativeInput, scope)).toBe(true);
          invalidated.invalidate(SESSION);
        },
      },
      revalidate: async () => ({ scope, noActivePlan: true }),
    })).rejects.toThrow(/invalidada/i);

    const changed = createPointActionMediator();
    const mutableValue = { path: target, content: "export const value = 2;\n" };
    await expect(changed.authorizeTool({
      scope,
      directory: repo,
      tool: "write",
      value: mutableValue,
      call,
      approval: {
        assert: async (request) => {
          const nativeInput: Record<string, unknown> = { ...request, effect: "allow" };
          expect(changed.evaluateApprovalPermission(nativeInput, scope)).toBe(true);
          mutableValue.content = "export const value = 99;\n";
        },
      },
      revalidate: async () => ({ scope, noActivePlan: true }),
    })).rejects.toThrow(/cambió/i);
  });

  test("falla cerrado para creación, symlink, multirrecurso, infraestructura, docs protegidos y secretos", async () => {
    const mediator = createPointActionMediator();
    const linked = path.join(repo, "src", "linked.ts");
    fs.symlinkSync(target, linked);
    const workflow = path.join(repo, ".github", "workflows", "ci.yml");
    fs.mkdirSync(path.dirname(workflow), { recursive: true });
    fs.writeFileSync(workflow, "name: ci\n", "utf8");
    const protectedDoc = path.join(repo, "Product", "decision.md");
    fs.mkdirSync(path.dirname(protectedDoc), { recursive: true });
    fs.writeFileSync(protectedDoc, "# decisión\n", "utf8");
    const other = path.join(repo, "src", "b.ts");
    fs.writeFileSync(other, "export const other = 1;\n", "utf8");
    const credentialName = ["api", "key"].join("_");
    const sensitive = `const ${credentialName} = '${["fixture", "value", "x".repeat(24)].join("-")}';`;
    const cases = [
      { name: "creación", tool: "write", value: { path: path.join(repo, "src", "new.ts"), content: "new" } },
      { name: "symlink", tool: "write", value: { path: linked, content: "linked" } },
      { name: "infraestructura", tool: "write", value: { path: workflow, content: "name: changed\n" } },
      { name: "documentación protegida", tool: "write", value: { path: protectedDoc, content: "# changed\n" } },
      {
        name: "multirrecurso",
        tool: "patch",
        value: { patchText: `*** Begin Patch\n*** Update File: ${target}\n*** Update File: ${other}\n*** End Patch` },
      },
      { name: "secreto", tool: "write", value: { path: target, content: sensitive } },
    ];

    for (const candidate of cases) {
      let approvalCount = 0;
      const authorized = await mediator.authorizeTool({
        scope,
        directory: repo,
        tool: candidate.tool,
        value: candidate.value,
        call,
        approval: { assert: async () => { approvalCount += 1; } },
        revalidate: async () => ({ scope, noActivePlan: true }),
      });
      expect(authorized, candidate.name).toBe(false);
      expect(approvalCount, candidate.name).toBe(0);
    }
  });
});
