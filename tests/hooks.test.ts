import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runHooks } from "../src/cli/core/hooks/engine";
import type { HookContext } from "../src/cli/core/hooks/types";
import { callTool } from "../src/mnemo/tools";

const baseContext = (overrides: Partial<HookContext>): HookContext => ({
  event: "git.commit.before",
  harness: "cli",
  profile: "standard",
  cwd: process.cwd(),
  projectRoot: process.cwd(),
  malahorHome: path.join(process.cwd(), ".sandbox", "home", ".malahor"),
  ...overrides,
});

describe("malahor hooks", () => {
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
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-COMMIT-MESSAGE")).toBe(true);
  });

  test("acepta mensajes de commit Malahor", () => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      profile: "release",
    }));

    expect(result.decision).toBe("allow");
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
