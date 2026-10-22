import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { assertHooksAllowed, evaluateHookRules, hookExitCode, runHooks } from "../src/cli/core/hooks/engine";
import { HOOK_EVENTS, type HookContext, type HookPolicyMeta, type HookRule } from "../src/cli/core/hooks/types";
import { callTool } from "../src/mnemo/tools";

const baseContext = (overrides: Partial<HookContext>): HookContext => ({
  event: "git.commit.before",
  harness: "cli",
  profile: "standard",
  cwd: process.cwd(),
  projectRoot: process.cwd(),
  malahorHome: path.join(process.cwd(), ".sandbox", "home", ".malahor"),
  audit: { enabled: false },
  ...overrides,
});

const policyMeta = (overrides: Partial<HookPolicyMeta>): HookPolicyMeta => ({
  contractVersion: 1,
  schemaVersion: 1,
  policyVersion: "test",
  issuer: "test",
  policyHash: "test",
  sources: [],
  corporateStatus: "absent",
  corporateRequired: false,
  criticalGaps: [],
  warnings: [],
  ...overrides,
});

describe("malahor hooks", () => {
  test("el CLI expone los eventos del runtime V2", () => {
    const events = new Set<string>(HOOK_EVENTS);
    for (const event of [
      "shell.exec.before",
      "file.read.before",
      "file.write.before",
      "tool.execute.before",
      "session.prompt.before",
      "plugin.permission.before",
    ]) {
      expect(events.has(event)).toBe(true);
    }
  });

  test("bloquea comandos git destructivos", () => {
    const result = runHooks(baseContext({
      event: "git.reset.before",
      command: "git reset --hard HEAD~1",
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
  });

  test("bloquea secretos antes de stage/commit", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-"));
    const secretFile = path.join(dir, ".env");
    fs.writeFileSync(secretFile, `${"API"}_KEY='12345678901234567890'\n`, "utf8");

    const result = runHooks(baseContext({
      event: "file.stage.before",
      cwd: dir,
      projectRoot: dir,
      targetPaths: [".env"],
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(true);
  });

  test("exige preview y confirmacion para memoria destructiva", () => {
    const result = runHooks(baseContext({
      event: "memory.delete.apply",
      destructive: true,
      memoryScope: "flowin-backend",
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.map((violation) => violation.id)).toContain("MAL-HOOK-MEM-PREVIEW");
    expect(result.violations.map((violation) => violation.id)).toContain("MAL-HOOK-MEM-CONFIRM");
  });

  test("permite memoria destructiva con preview y confirmacion exacta", () => {
    const result = runHooks(baseContext({
      event: "memory.delete.apply",
      destructive: true,
      memoryScope: "flowin-backend",
      confirmation: "flowin-backend",
      metadata: {
        previewToken: "delete:flowin-backend:6:0",
        requiresConfirmation: "flowin-backend",
      },
    }));

    expect(result.decision).toBe("allow");
  });

  test("detecta politica insegura antes de aplicar permisos", () => {
    const result = runHooks(baseContext({
      event: "install.beforePolicy",
      profile: "release",
      metadata: {
        appliesPolicyBeforeValidation: true,
        bashDenyTotal: true,
      },
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.length).toBe(2);
  });

  test("push requiere evidencia de checks", () => {
    const result = runHooks(baseContext({ event: "git.push.before", profile: "release" }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-PUSH-CHECKS")).toBe(true);
  });

  test("advierte mensajes de commit fuera del formato Malahor", () => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m 'update stuff'",
      profile: "release",
      metadata: { validationOnly: true },
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-COMMIT-MESSAGE")).toBe(true);
  });

  test("acepta mensajes de commit Malahor", () => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      profile: "release",
      metadata: { validationOnly: true },
    }));

    expect(result.decision).toBe("allow");
  });

  test("bloquea commit real sin consentimiento explicito", () => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      profile: "release",
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-CONSENT")).toBe(true);
  });

  test("permite commit real con consentimiento explicito", () => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      confirmation: "USER_REQUESTED_COMMIT",
      profile: "release",
    }));

    expect(result.decision).toBe("allow");
  });

  test("bloquea stage real sin consentimiento explicito", () => {
    const result = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add README.md",
      profile: "release",
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-STAGE-CONSENT")).toBe(true);
  });

  test("profile off no desactiva el suelo critico", () => {
    const result = runHooks(baseContext({
      event: "git.reset.before",
      command: "git reset --hard HEAD~1",
      profile: "off",
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
  });

  test("assertHooksAllowed bloquea ask pendiente", () => {
    expect(() => assertHooksAllowed(baseContext({
      event: "git.push.before",
      profile: "release",
    }))).toThrow(/ASK pendiente/);
  });

  test("ask pendiente no se autoriza con CHECKS_OK", () => {
    const result = runHooks(baseContext({
      event: "git.push.before",
      profile: "release",
      confirmation: "CHECKS_OK",
    }));

    expect(result.decision).toBe("ask");
    expect(() => assertHooksAllowed(baseContext({
      event: "git.push.before",
      profile: "release",
      confirmation: "CHECKS_OK",
    }))).toThrow(/ASK pendiente/);
  });

  test("USER_REQUESTED_COMMIT no autoriza un ask de mensaje", () => {
    const context = baseContext({
      event: "git.commit.before",
      command: "git commit -m 'update stuff'",
      profile: "release",
      confirmation: "USER_REQUESTED_COMMIT",
    });

    expect(runHooks(context).decision).toBe("ask");
    expect(() => assertHooksAllowed(context)).toThrow(/ASK pendiente/);
  });

  test("hookExitCode distingue deny, ask y allow", () => {
    expect(hookExitCode("deny")).toBe(2);
    expect(hookExitCode("ask")).toBe(3);
    expect(hookExitCode("warn")).toBe(0);
    expect(hookExitCode("allow")).toBe(0);
  });

  test("error de control critico deniega y error auxiliar solo advierte", () => {
    const critical: HookRule[] = [{
      id: "control-critico",
      run: () => { throw new Error("timeout"); },
    }];
    const auxiliary: HookRule[] = [{
      id: "control-auxiliar",
      critical: false,
      run: () => { throw new Error("lectura opcional"); },
    }];

    const criticalResult = evaluateHookRules(baseContext({}), critical);
    const auxiliaryResult = evaluateHookRules(baseContext({}), auxiliary);

    expect(criticalResult[0]?.id).toBe("MAL-HOOK-CONTROL-ERROR");
    expect(criticalResult[0]?.decision).toBe("deny");
    expect(auxiliaryResult[0]?.id).toBe("MAL-HOOK-CONTROL-WARN");
    expect(auxiliaryResult[0]?.decision).toBe("warn");
  });

  test("politica corporativa no evaluable bloquea la operacion", () => {
    const result = runHooks(baseContext({
      policyMeta: policyMeta({ corporateStatus: "untrusted" }),
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-POLICY-CORPORATE")).toBe(true);
  });

  test("control exigido sin mediacion bloquea la operacion afectada", () => {
    const result = runHooks(baseContext({
      event: "git.push.before",
      policyMeta: policyMeta({ criticalGaps: ["corporate:git.requirePushApproval"] }),
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-POLICY-GAP")).toBe(true);
  });

  test("expone hook check por MCP", () => {
    const result = callTool({
      name: "malahor_hook_check",
      arguments: {
        event: "git.reset.before",
        command: "git reset --hard",
      },
    }) as { decision: string; violations: Array<{ id: string }> };

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
  });
});
