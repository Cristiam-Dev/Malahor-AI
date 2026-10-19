import { describe, expect, test } from "bun:test";
import { runHooks } from "../src/cli/core/hooks/engine";
import { composeCommitMessage } from "../src/cli/core/git-workflow";

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
});
