import { describe, expect, test } from "bun:test";
import { runHooks } from "../src/cli/core/hooks/engine";
import {
  composeCommitMessage,
  gitWorkflowExitCode,
  isDeferredValidationApproval,
} from "../src/cli/core/git-workflow";
import type { HookResult } from "../src/cli/core/hooks/types";

describe("git workflow asistido", () => {
  test("genera mensaje Malahor valido con tipo y scope explicitos", () => {
    const message = composeCommitMessage({
      summary: "agrega flujo git asistido",
      type: "feat",
      scope: "hooks",
      paths: ["src/cli/commands/git.ts"],
    });

    expect(message).toBe("✨ feat(hooks): agrega flujo git asistido");

    const result = runHooks({
      event: "git.commit.before",
      harness: "cli",
      profile: "release",
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      malahorHome: `${process.cwd()}/.sandbox/home/.malahor`,
      command: `git commit -m '${message}'`,
      metadata: { validationOnly: true },
    });

    expect(result.decision).toBe("allow");
  });

  test("infiere docs cuando solo cambian markdowns", () => {
    const message = composeCommitMessage({
      summary: "actualiza guia de hooks",
      paths: ["README.md", "assets/opencode/AGENTS.md"],
    });

    expect(message).toBe("📝 docs(docs): actualiza guia de hooks");
  });

  test("normaliza scope y resumen", () => {
    const message = composeCommitMessage({
      summary: "  Agrega validaciones nuevas.  ",
      type: "test",
      scope: "Hook Policy",
    });

    expect(message).toBe("✅ test(hook-policy): agrega validaciones nuevas");
  });

  test("difiere solo el ASK de infraestructura en preflight sin autorizar el efecto", () => {
    const result = runHooks({
      event: "git.commit.before",
      harness: "cli",
      profile: "standard",
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      malahorHome: `${process.cwd()}/.sandbox/home/.malahor`,
      project: "malahor",
      command: "git commit -m '🔧 ci(typecheck): alinea la validación'",
      targetPaths: [".github/workflows/ci.yml"],
      metadata: { validationOnly: true },
    });

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-INFRA-APPROVAL")).toBe(true);
    expect(isDeferredValidationApproval("precommit", result)).toBe(true);
    expect(gitWorkflowExitCode({ action: "precommit", hookResult: result })).toBe(0);
    expect(gitWorkflowExitCode({ action: "prepush", hookResult: result })).toBe(3);

    const unrelatedAsk: HookResult = {
      ...result,
      violations: [{
        id: "MAL-HOOK-OTHER-ASK",
        decision: "ask",
        message: "requiere otra aprobacion",
        fix: "No diferir.",
      }],
    };
    expect(isDeferredValidationApproval("precommit", unrelatedAsk)).toBe(false);
    expect(gitWorkflowExitCode({ action: "precommit", hookResult: unrelatedAsk })).toBe(3);
  });
});
