import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { assertHooksAllowed, evaluateHookRules, hookExitCode, runHooks } from "../src/cli/core/hooks/engine";
import { HOOK_EVENTS, HOOK_RESOURCE_KINDS, type HookContext, type HookPolicyMeta, type HookRule } from "../src/cli/core/hooks/types";
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
      "codegraph.index.before",
    ]) {
      expect(events.has(event)).toBe(true);
    }
    expect(events.has("graphify.generate.before")).toBe(false);
    expect(events.has("obsidian.write.before")).toBe(false);
    expect(HOOK_RESOURCE_KINDS).toEqual(["filesystem"]);
  });

  test("deniega el resourceKind legacy y solo acepta rutas filesystem", () => {
    const result = runHooks(baseContext({
      event: "file.write.before",
      resourceKind: "obsidian-vault" as unknown as HookContext["resourceKind"],
      targetPaths: ["Product/pm/plan-fase-5.md"],
      metadata: { writesMalahorData: true },
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-RESOURCE-KIND")).toBe(true);
  });

  test("el CLI rechaza el evento y resourceKind retirados de Obsidian", () => {
    const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hook-cli-resource-"));
    try {
      const env = {
        ...process.env,
        MALAHOR_HOME: path.join(root, "home"),
        MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
        MALAHOR_OPENCODE_DETECT: "0",
      };
      const retiredEvent = Bun.spawnSync([
        "bun", "run", "src/cli/index.ts", "hooks", "check", "obsidian.write.before", "--json",
      ], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
      const retiredKind = Bun.spawnSync([
        "bun", "run", "src/cli/index.ts", "hooks", "check", "file.write.before",
        "--resource-kind", "obsidian-vault", "--json",
      ], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });

      expect(retiredEvent.exitCode).toBe(1);
      expect(retiredEvent.stderr.toString()).toMatch(/Evento hook invalido/i);
      expect(retiredKind.exitCode).toBe(1);
      expect(retiredKind.stderr.toString()).toMatch(/Tipo de recurso invalido.*filesystem/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("mantiene el limite del repo para recursos fisicos de Malahor", () => {
    const result = runHooks(baseContext({
      event: "memory.write.before",
      targetPaths: ["src/datos-operativos.json"],
      metadata: { writesMalahorData: true },
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-REPO-BOUNDARY")).toBe(true);
  });

  test("presenta target y pide aprobacion para Git local destructivo", () => {
    const result = runHooks(baseContext({
      event: "git.reset.before",
      command: "git reset --hard HEAD~1",
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
    expect(result.violations.some((violation) => violation.message.includes("HEAD~1"))).toBe(true);
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

  test("no confunde un placeholder multilinea del codigo con una credencial", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-source-"));
    const sourceFile = path.join(dir, "integration.ts");
    fs.writeFileSync(sourceFile, 'throw new Error("SERVICE_API_KEY: ");\n', "utf8");

    const result = runHooks(baseContext({
      event: "file.stage.before",
      cwd: dir,
      projectRoot: dir,
      targetPaths: [sourceFile],
    }));

    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(false);
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

  test("push es hard DENY aunque el perfil pudiera rebajar otros controles", () => {
    const result = runHooks(baseContext({ event: "git.push.before", profile: "release" }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-REMOTE-DENY")).toBe(true);
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

  test("pide consentimiento para commit real sin intencion explicita", () => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      targetPaths: ["src/fixture.ts"],
      profile: "release",
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-CONSENT")).toBe(true);
  });

  test("tokens y metadata legacy no autorizan commit ni stage", () => {
    const commit = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      targetPaths: ["src/fixture.ts"],
      confirmation: "USER_REQUESTED_COMMIT",
      profile: "release",
    }));
    const stage = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add -- src/fixture.ts",
      targetPaths: ["src/fixture.ts"],
      metadata: { userExplicitlyRequestedStage: true },
      profile: "release",
    }));

    expect(commit.decision).toBe("ask");
    expect(commit.violations.some((violation) => violation.id === "MAL-HOOK-GIT-CONSENT")).toBe(true);
    expect(stage.decision).toBe("ask");
    expect(stage.violations.some((violation) => violation.id === "MAL-HOOK-GIT-STAGE-CONSENT")).toBe(true);
  });

  test("una intencion commit estructurada cubre stage exacto y commit ordinario", () => {
    const stage = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add -- src/fixture.ts",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));
    const commit = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));
    const amend = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit --amend --no-edit",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));

    expect(stage.decision).toBe("allow");
    expect(commit.decision).toBe("allow");
    expect(amend.decision).toBe("ask");
    expect(amend.violations.some((violation) => violation.id === "MAL-HOOK-GIT-CONSENT")).toBe(true);
  });

  test("la intencion commit rechaza stage amplio, paths distintos y commit -a", () => {
    const broadStage = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add -A",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));
    const differentPath = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add -- src/otro.ts",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));
    const magicPathspec = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add -- :/",
      targetPaths: [":/"],
      gitIntent: "commit",
    }));
    const implicitStage = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -am '🧠 feat(memoria): agrega hooks seguros'",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));

    for (const result of [broadStage, differentPath, magicPathspec]) {
      expect(result.decision).toBe("deny");
      expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-INTENT-SCOPE")).toBe(true);
    }
    expect(implicitStage.decision).toBe("deny");
    expect(implicitStage.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE-DENY")).toBe(true);
  });

  test("pide consentimiento para stage real sin intencion explicita", () => {
    const result = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add README.md",
      profile: "release",
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-STAGE-CONSENT")).toBe(true);
  });

  test("profile off no elimina el ASK destructivo local", () => {
    const result = runHooks(baseContext({
      event: "git.reset.before",
      command: "git reset --hard HEAD~1",
      profile: "off",
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
  });

  test("assertHooksAllowed bloquea ask pendiente", () => {
    expect(() => assertHooksAllowed(baseContext({
      event: "git.reset.before",
      command: "git reset --hard HEAD~1",
      profile: "release",
    }))).toThrow(/ASK pendiente/);
  });

  test("CHECKS_OK no habilita un remoto hard DENY", () => {
    const result = runHooks(baseContext({
      event: "git.push.before",
      profile: "release",
      confirmation: "CHECKS_OK",
    }));

    expect(result.decision).toBe("deny");
    expect(() => assertHooksAllowed(baseContext({
      event: "git.push.before",
      profile: "release",
      confirmation: "CHECKS_OK",
    }))).toThrow(/remota prohibida|hard DENY/i);
  });

  test.each([
    "git pull",
    "git fetch --all",
    "git clone https://example.com/demo.git",
    "git remote update",
    "git -c alias.publicar=push publicar",
    "echo \"$(git fetch origin)\"",
    "printf '%s' `git push origin HEAD`",
  ])("deniega remoto desde shell aun con metadata de aprobacion: %s", (command) => {
    const result = runHooks(baseContext({
      event: "shell.exec.before",
      command,
      profile: "off",
      confirmation: "APPROVE",
      gitIntent: "commit",
      metadata: { checksVerified: true, planID: "plan", revision: "rev" },
    }));
    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-REMOTE-DENY")).toBe(true);
  });

  test("permite git ls-files como lectura local", () => {
    const result = runHooks(baseContext({
      event: "shell.exec.before",
      command: "git ls-files -- docs README.md LICENSE THIRD_PARTY_NOTICES.md",
      profile: "off",
    }));

    expect(result.decision).toBe("allow");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-REMOTE-DENY")).toBe(false);
  });

  test.each([
    "git rm -- src/fixture.ts",
    "git stash push -m temporal",
    "git revert abc123",
    "git update-index --assume-unchanged src/fixture.ts",
    "git update-ref refs/heads/dev abc123",
    "git tag -d v1.0.0",
    "git notes add -m nota abc123",
  ])("deniega mutadores locales no modelados: %s", (command) => {
    const result = runHooks(baseContext({
      event: "shell.exec.before",
      command,
      profile: "off",
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE-DENY")).toBe(true);
  });

  test("USER_REQUESTED_COMMIT no autoriza un ask de mensaje", () => {
    const context = baseContext({
      event: "git.commit.before",
      command: "git commit -m 'update stuff'",
      targetPaths: ["src/fixture.ts"],
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

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
  });

  test("el wrapper MCP rechaza el resourceKind retirado antes de resolver archivos", () => {
    expect(() => callTool({
      name: "malahor_hook_check",
      arguments: {
        event: "file.write.before",
        resourceKind: "obsidian-vault",
        paths: ["Product/manual.md"],
      },
    })).toThrow(/resourceKind.*filesystem/i);
  });
});
