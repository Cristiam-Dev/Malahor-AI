import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runHooks } from "../src/cli/core/hooks/engine";
import {
  composeCommitMessage,
  gitWorkflowExitCode,
  isDeferredValidationApproval,
  runGitWorkflow,
} from "../src/cli/core/git-workflow";
import type { HookResult } from "../src/cli/core/hooks/types";

describe("git workflow asistido", () => {
  test("retira prepush de la API publica", () => {
    expect(() => runGitWorkflow({
      action: "prepush",
      args: [],
      profile: undefined,
      project: undefined,
      confirm: undefined,
      message: undefined,
      type: undefined,
      scope: undefined,
      icon: undefined,
    })).toThrow(/precommit, commit-message o commit-fallback/);
  });

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
    expect(gitWorkflowExitCode({ action: "commit-fallback", hookResult: result })).toBe(3);

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

  test("commit-fallback recibe paths como array JSON exacto", () => {
    const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-git-paths-"));
    const repo = path.join(root, "repo");
    const cli = path.join(process.cwd(), "src", "cli", "index.ts");
    const env = {
      ...process.env,
      MALAHOR_HOME: path.join(root, "home"),
      MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
      MALAHOR_OPENCODE_DETECT: "0",
    };
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "package.json"), '{"name":"paths-fixture"}\n', "utf8");
    const paths = [" leading.ts", "src/a,b.ts"];
    fs.writeFileSync(path.join(repo, paths[0]!), "leading\n", "utf8");
    fs.writeFileSync(path.join(repo, paths[1]!), "comma\n", "utf8");
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const run = (args: string[]) => Bun.spawnSync(["bun", "run", cli, "git", ...args], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      expect(git(["init", "-q"]).exitCode).toBe(0);
      expect(git(["add", "--", ...paths]).exitCode).toBe(0);

      const precommit = run([
        "precommit",
        "--message", "🔒 feat(git): valida paths exactos",
        "--json",
      ]);
      expect(precommit.exitCode).toBe(0);
      const preflight = JSON.parse(precommit.stdout.toString()) as { stagedFingerprint: string };

      const fallback = run([
        "commit-fallback",
        "--message", "🔒 feat(git): valida paths exactos",
        "--paths", JSON.stringify(paths),
        "--fingerprint", preflight.stagedFingerprint,
        "--blocked-by", "harness-unavailable",
        "--json",
      ]);
      expect(fallback.exitCode).toBe(0);
      const result = JSON.parse(fallback.stdout.toString()) as {
        targetPaths: string[];
        fallback: { stagedPaths: string[] };
      };
      expect(result.targetPaths).toEqual(paths);
      expect(result.fallback.stagedPaths).toEqual(paths);

      const legacy = run([
        "commit-fallback",
        "--message", "🔒 feat(git): rechaza paths ambiguos",
        "--paths", paths.join(","),
        "--fingerprint", preflight.stagedFingerprint,
        "--blocked-by", "harness-unavailable",
        "--json",
      ]);
      expect(legacy.exitCode).toBe(1);
      expect(legacy.stderr.toString()).toMatch(/array JSON/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
