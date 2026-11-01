import { describe, expect, test } from "bun:test";

import { createExternalCommitFallback } from "../src/cli/core/git-commit-fallback";

const verifiedInput = {
  cwd: "/tmp/repo con 'comilla",
  subject: "✨ feat(git): aplica politica local",
  body: "- Conserva el staged exacto.\n- No omite hooks.",
  stagedPaths: ["src/a.ts", "tests/a.test.ts"],
  expectedPaths: ["tests/a.test.ts", "src/a.ts"],
  stagedFingerprint: "sha256:abc123",
  expectedFingerprint: "sha256:abc123",
  precommitDecision: "allow" as const,
  blockedBy: "harness-unavailable" as const,
};

describe("fallback externo de commit", () => {
  test("genera un comando exacto, copiable y sin bypass", () => {
    const fallback = createExternalCommitFallback(verifiedInput);

    expect(fallback.executed).toBe(false);
    expect(fallback.command).toContain("cd -- '/tmp/repo con '\\''comilla'");
    expect(fallback.command).toContain("git commit -m '✨ feat(git): aplica politica local'");
    expect(fallback.command).toContain("-m '- Conserva el staged exacto.");
    expect(fallback.command).not.toContain("--no-verify");
    expect(fallback.command).not.toMatch(/\bgit\s+(push|pull|fetch|clone)\b/);
    expect(fallback.verificationCommand).toContain("git --no-pager log -1 --oneline");
    expect(fallback.verificationCommand).toContain("git status --short --untracked-files=all");
    expect(fallback.stagedPaths).toEqual(["src/a.ts", "tests/a.test.ts"]);
  });

  test("preserva el cuerpo aprobado sin recortarlo", () => {
    const body = "\n- Contexto preservado.\n";
    const fallback = createExternalCommitFallback({ ...verifiedInput, body });

    expect(fallback.command).toContain(`-m '${body}'`);
  });

  test("genera PowerShell portable en Windows", () => {
    const windowsInput = {
      ...verifiedInput,
      cwd: "C:\\repo con 'comilla",
      platform: "win32" as NodeJS.Platform,
    };
    const fallback = createExternalCommitFallback(windowsInput);

    expect(fallback.command).toContain("Set-Location -LiteralPath 'C:\\repo con ''comilla'");
    expect(fallback.command).toContain("git commit -m '✨ feat(git): aplica politica local'");
    expect(fallback.command).not.toContain("cd --");
    expect(fallback.command).not.toContain("--no-verify");
    expect(fallback.verificationCommand).toContain("git --no-pager log -1 --oneline");
    expect(fallback.verificationCommand).toContain("git status --short --untracked-files=all");
  });

  test.each(["ask", "deny"] as const)("rechaza precommit %s", (precommitDecision) => {
    expect(() => createExternalCommitFallback({ ...verifiedInput, precommitDecision })).toThrow(/precommit/i);
  });

  test("rechaza un bloqueo de politica aunque el resto coincida", () => {
    expect(() => createExternalCommitFallback({
      ...verifiedInput,
      blockedBy: "policy-deny",
    })).toThrow(/harness|permiso|bloqueo/i);
  });

  test("rechaza cambios en el staged o su huella", () => {
    expect(() => createExternalCommitFallback({
      ...verifiedInput,
      stagedPaths: [...verifiedInput.stagedPaths, "docs/architecture/horiel-phase-1.md"],
    })).toThrow(/staged/i);
    expect(() => createExternalCommitFallback({
      ...verifiedInput,
      stagedFingerprint: "sha256:changed",
    })).toThrow(/huella|fingerprint/i);
    expect(() => createExternalCommitFallback({
      ...verifiedInput,
      stagedPaths: [" src/a.ts", "tests/a.test.ts"],
    })).toThrow(/staged/i);
  });

  test("solo admite causas reales de imposibilidad de ejecucion", () => {
    for (const blockedBy of ["host-deny", "host-ask", "harness-unavailable"] as const) {
      expect(createExternalCommitFallback({ ...verifiedInput, blockedBy }).blockedBy).toBe(blockedBy);
    }
  });
});
