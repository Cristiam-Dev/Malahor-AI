import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  classifyDocumentationPath,
  isRemovalOperation,
  parsePatchOperations,
} from "../src/cli/core/documentation-boundary";
import { runHooks } from "../src/cli/core/hooks/engine";
import type { HookContext } from "../src/cli/core/hooks/types";

let scratch: string;
let repo: string;
let home: string;

function context(overrides: Partial<HookContext>): HookContext {
  return {
    event: "file.write.before",
    harness: "opencode",
    profile: "standard",
    cwd: repo,
    projectRoot: repo,
    malahorHome: home,
    project: "demo",
    resourceKind: "filesystem",
    audit: { enabled: false },
    ...overrides,
  };
}

function docsViolation(result: ReturnType<typeof runHooks>, id = "MAL-HOOK-DOCS-EXTERNAL"): boolean {
  return result.violations.some((violation) => violation.id === id);
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-documentation-boundary-"));
  repo = path.join(scratch, "repo");
  home = path.join(scratch, "malahor-home");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({
    demo: { context: "memory", roots: [repo], defaultRoot: repo },
  }));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("clasificador documental default-deny", () => {
  test("bloquea Markdown operativo por defecto, independientemente del nombre del directorio", () => {
    for (const target of [
      "docs/architecture/decision.md",
      "product/roadmap.mdx",
      "planning/sprint.markdown",
      "notes/audit.adoc",
      "design/research.rst",
      "architecture.md",
    ]) {
      expect(classifyDocumentationPath(repo, target)).toMatchObject({
        protected: true,
        reason: expect.stringMatching(/bloqueado por defecto/i),
      });
    }
  });

  test("permite solo documentos publicos, assets gestionados, ejemplos y fixtures", () => {
    for (const target of [
      "README.md",
      "docs/README.es.md",
      "LICENSE.md",
      "SECURITY.mdx",
      "CODE_OF_CONDUCT.md",
      "THIRD_PARTY_NOTICES.md",
      "AGENTS.md",
      "assets/prompts/managed.md",
      "examples/tutorial.md",
      "src/__fixtures__/note.md",
      "tests/fixtures/note.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
    ]) {
      expect(classifyDocumentationPath(repo, target).protected).toBe(false);
    }
  });

  test("no bloquea contratos machine-readable ni codigo con nombres documentales", () => {
    for (const target of [
      "contracts/openapi.yaml",
      "schemas/event.json",
      "proto/service.proto",
      "src/architecture.ts",
      "docs/diagram.svg",
    ]) {
      expect(classifyDocumentationPath(repo, target).protected).toBe(false);
    }
  });

  test("una ruta fuera del proyecto no se clasifica como documentacion interna", () => {
    expect(classifyDocumentationPath(repo, path.join(scratch, "outside", "plan.md"))).toEqual({ protected: false });
  });
});

describe("parser de patches y retiros historicos", () => {
  test("extrae add/update/delete y descompone move en salida y entrada", () => {
    const operations = parsePatchOperations([
      "*** Begin Patch",
      "*** Add File: docs/new.md",
      "+new",
      "*** Update File: docs/old.md",
      "-old",
      "+updated",
      "*** Update File: docs/move.md",
      "*** Move to: archive/move.md",
      "*** Delete File: docs/deleted.md",
      "*** End Patch",
    ].join("\n"));

    expect(operations).toEqual([
      { kind: "add", path: "docs/new.md" },
      { kind: "update", path: "docs/old.md" },
      { kind: "move-out", path: "docs/move.md" },
      { kind: "move-in", path: "archive/move.md" },
      { kind: "delete", path: "docs/deleted.md" },
    ]);
    expect(isRemovalOperation("delete")).toBe(true);
    expect(isRemovalOperation("move-out")).toBe(true);
    expect(isRemovalOperation("move-in")).toBe(false);
    expect(isRemovalOperation("update")).toBe(false);
  });

  test("el hook permite borrar o mover fuera historicos, pero bloquea altas, updates y move-in", () => {
    for (const kind of ["delete", "move-out"] as const) {
      const result = runHooks(context({
        targetPaths: ["docs/architecture/historical.md"],
        metadata: { fileOperations: [{ kind, path: "docs/architecture/historical.md" }] },
      }));
      expect(docsViolation(result)).toBe(false);
    }

    for (const kind of ["add", "update", "move-in", "write"] as const) {
      const result = runHooks(context({
        targetPaths: ["docs/architecture/current.md"],
        metadata: { fileOperations: [{ kind, path: "docs/architecture/current.md" }] },
      }));
      expect(result.decision).toBe("deny");
      expect(docsViolation(result)).toBe(true);
    }
  });
});

describe("enforcement en write, stage y commit", () => {
  test("write bloquea Markdown de repo y permite README, fixtures y contratos", () => {
    const blocked = runHooks(context({ targetPaths: ["docs/architecture/current.md"] }));
    expect(blocked.decision).toBe("deny");
    expect(docsViolation(blocked)).toBe(true);

    for (const target of ["README.md", "tests/fixtures/current.md", "contracts/openapi.yaml"]) {
      const allowed = runHooks(context({ targetPaths: [target] }));
      expect(docsViolation(allowed)).toBe(false);
    }
  });

  test("stage, commit y shell commit aplican la misma frontera a archivos persistidos", () => {
    for (const value of [
      context({ event: "file.stage.before", targetPaths: ["docs/plan.md"] }),
      context({ event: "git.commit.before", targetPaths: ["docs/plan.md"], metadata: { validationOnly: true } }),
      context({ event: "shell.exec.before", command: "git commit -m fixture", targetPaths: ["docs/plan.md"] }),
    ]) {
      const result = runHooks(value);
      expect(result.decision).toBe("deny");
      expect(docsViolation(result)).toBe(true);
    }

    const publicCommit = runHooks(context({
      event: "git.commit.before",
      targetPaths: ["README.md", "contracts/openapi.yaml"],
      metadata: { validationOnly: true },
    }));
    expect(docsViolation(publicCommit)).toBe(false);
  });

  test("stage permite solo una eliminacion Git real y exacta de documentacion", () => {
    const relativePath = "docs/architecture/historical.md";
    const targetPath = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "# Historical\n", "utf8");
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    execFileSync("git", ["add", "--", relativePath], { cwd: repo });
    fs.rmSync(targetPath);

    const removal = runHooks(context({
      event: "file.stage.before",
      command: `git add -u -- ${relativePath}`,
      confirmation: "USER_REQUESTED_STAGE",
      targetPaths: [relativePath],
    }));
    expect(docsViolation(removal)).toBe(false);

    const unproven = runHooks(context({
      event: "file.stage.before",
      command: "git add -u -- docs/architecture/missing.md",
      confirmation: "USER_REQUESTED_STAGE",
      targetPaths: ["docs/architecture/missing.md"],
    }));
    expect(unproven.decision).toBe("deny");
    expect(docsViolation(unproven)).toBe(true);
  });

  test("commit permite solo una eliminacion staged real y exacta de documentacion", () => {
    const relativePath = "docs/architecture/historical.md";
    const targetPath = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "# Historical\n", "utf8");
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    execFileSync("git", ["add", "--", relativePath], { cwd: repo });
    execFileSync("git", [
      "-c", "user.name=Malahor Fixture",
      "-c", "user.email=fixture@malahor.invalid",
      "-c", "commit.gpgsign=false",
      "commit", "--quiet", "--no-verify", "-m", "fixture",
    ], { cwd: repo });
    fs.rmSync(targetPath);
    execFileSync("git", ["add", "-u", "--", relativePath], { cwd: repo });

    for (const target of [relativePath, targetPath]) {
      const removal = runHooks(context({
        event: "git.commit.before",
        command: "git commit -m '📝 docs(docs): retira historico'",
        confirmation: "USER_REQUESTED_COMMIT",
        targetPaths: [target],
      }));
      expect(docsViolation(removal)).toBe(false);
    }

    const shellRemoval = runHooks(context({
      event: "shell.exec.before",
      command: "git commit -m '📝 docs(docs): retira historico'",
      confirmation: "USER_REQUESTED_COMMIT",
      targetPaths: [relativePath],
    }));
    expect(docsViolation(shellRemoval)).toBe(false);

    const unproven = runHooks(context({
      event: "git.commit.before",
      command: "git commit -m '📝 docs(docs): retira historico'",
      confirmation: "USER_REQUESTED_COMMIT",
      targetPaths: ["docs/architecture/missing.md"],
    }));
    expect(unproven.decision).toBe("deny");
    expect(docsViolation(unproven)).toBe(true);
  });

  test("deniega filesystem directo al vault default, overrides y aliases symlink", () => {
    const vault = path.join(home, "vault");
    const override = path.join(scratch, "external-docs");
    fs.mkdirSync(vault, { recursive: true });
    fs.mkdirSync(override, { recursive: true });
    fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({
      demo: { context: "memory", roots: [repo], defaultRoot: repo, docs: { path: override } },
    }));
    const alias = path.join(scratch, "vault-alias");
    fs.symlinkSync(vault, alias, "dir");

    for (const target of [
      path.join(vault, "projects", "demo", "note.md"),
      path.join(override, "note.md"),
      path.join(alias, "projects", "demo", "note.md"),
    ]) {
      const result = runHooks(context({ targetPaths: [target] }));
      expect(result.decision).toBe("deny");
      expect(docsViolation(result, "MAL-HOOK-DOCS-MCP-ONLY")).toBe(true);
    }
  });

  test("un projects.json invalido falla cerrado antes de una escritura", () => {
    fs.writeFileSync(path.join(home, "projects.json"), "{ invalid", "utf8");
    const result = runHooks(context({ targetPaths: ["src/file.ts"] }));
    expect(result.decision).toBe("deny");
    expect(docsViolation(result, "MAL-HOOK-DOCS-VERIFY")).toBe(true);
  });
});
