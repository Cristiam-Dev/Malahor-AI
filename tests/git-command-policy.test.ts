import { describe, expect, test } from "bun:test";

import { classifyGitCommand } from "../src/cli/core/git-command-policy";
import { createGitIntentRegistry, intentAuthorizes } from "../src/cli/core/git-intent";

describe("politica Git local-only", () => {
  test.each([
    "git push",
    "git push --dry-run origin dev",
    "git -C /tmp/demo fetch --all",
    "git --git-dir=.git pull --rebase",
    "git clone https://example.com/demo.git",
    "git ls-remote origin",
    "git remote update origin",
    "git remote prune origin",
    "git submodule update --remote",
    "git submodule add https://example.com/lib.git lib",
    "git fetch-pack https://example.com/demo.git",
    "git send-pack origin HEAD",
    "git-remote-https origin https://example.com/demo.git",
    "git-remote-custom origin custom://example/demo.git",
    "git-remote-custom.exe origin custom://example/demo.git",
    "/usr/lib/git-core/git-fetch-pack https://example.com/demo.git",
    "git archive --remote=origin HEAD",
    "git status && git fetch origin",
    "git diff | git push origin HEAD",
    "bash -lc 'git fetch origin'",
    "env sh -c 'git push origin HEAD'",
    "env git fetch origin",
    "command git fetch origin",
    "command git fetch -v origin",
    "printf 'origin\\n' | xargs git fetch",
    "cmd.exe /c 'git pull --rebase'",
    "echo \"$(git fetch origin)\"",
    "echo \"it's $(git fetch origin)\"",
    "printf '%s' `git push origin HEAD`",
  ])("clasifica como remoto sin excepciones: %s", (command) => {
    const result = classifyGitCommand(command);

    expect(result.hasGitCommand).toBe(true);
    expect(result.remote).toBe(true);
    expect(result.remoteReasons.length).toBeGreaterThan(0);
  });

  test("no interpreta sustituciones dentro de comillas simples", () => {
    const result = classifyGitCommand("echo '$(git fetch origin)'");

    expect(result.hasGitCommand).toBe(false);
    expect(result.remote).toBe(false);
  });

  test.each([
    "malahor-ai git precommit --message '🔒 feat(git): aplica politica' --json",
    "echo git fetch origin",
    "printf '%s' git",
    "command -v git",
    "bash -lc 'malahor-ai git precommit --json'",
  ])("no confunde argumentos llamados git con ejecutables: %s", (command) => {
    const result = classifyGitCommand(command);

    expect(result.hasGitCommand).toBe(false);
    expect(result.remote).toBe(false);
  });

  test.each([
    "git ls-files -- docs README.md LICENSE THIRD_PARTY_NOTICES.md",
    "git ls-files -z --cached",
  ])("clasifica ls-files como lectura local: %s", (command) => {
    const result = classifyGitCommand(command);

    expect(result.hasGitCommand).toBe(true);
    expect(result.remote).toBe(false);
    expect(result.failClosed).toBe(false);
    expect(result.operations).toEqual(["read"]);
    expect(result.destructive).toBe(false);
  });

  test("expande aliases Git e impide bypasses inline, recursivos o de shell", () => {
    expect(classifyGitCommand("git publicar", { aliases: { publicar: "push origin HEAD" } }).remote).toBe(true);
    expect(classifyGitCommand("git uno", { aliases: { uno: "dos", dos: "fetch --all" } }).remote).toBe(true);
    expect(classifyGitCommand("git -c alias.publicar='push origin HEAD' publicar").remote).toBe(true);

    const shellAlias = classifyGitCommand("git publicar", { aliases: { publicar: "!git push origin HEAD" } });
    expect(shellAlias.remote).toBe(true);
    expect(shellAlias.failClosed).toBe(true);
  });

  test.each([
    ["git add -- src/a.ts", ["stage"], false],
    ["git commit -m '✨ feat(git): aplica politica local'", ["commit"], false],
    ["git commit --amend --no-edit", ["amend"], true],
    ["git reset --hard HEAD~1", ["reset"], true],
    ["git rebase main", ["rebase"], true],
    ["git cherry-pick abc123", ["cherry-pick"], false],
    ["git merge feature/local", ["merge"], false],
    ["git switch -c feature/local", ["branch-create", "branch-switch"], false],
    ["git switch dev", ["branch-switch"], false],
    ["git switch -f dev", ["branch-switch"], true],
    ["git switch -Cfeature/local", ["branch-create", "branch-switch"], true],
    ["git checkout --force dev", ["branch-switch"], true],
    ["git checkout -Bfeature/local", ["branch-create", "branch-switch"], true],
    ["git branch -f dev abc123", ["branch-create"], true],
    ["git branch -Mfeature/local", ["branch-create"], true],
  ] as const)("mantiene local y tipa la operacion: %s", (command, operations, destructive) => {
    const result = classifyGitCommand(command);

    expect(result.remote).toBe(false);
    expect(result.operations).toEqual(operations);
    expect(result.destructive).toBe(destructive);
  });

  test.each([
    "git rm -- src/a.ts",
    "git stash push -m temporal",
    "git revert abc123",
    "git update-index --assume-unchanged src/a.ts",
    "git update-ref refs/heads/dev abc123",
    "git tag -d v1.0.0",
    "git notes add -m nota abc123",
  ])("falla cerrado ante mutadores locales no modelados: %s", (command) => {
    const result = classifyGitCommand(command);

    expect(result.hasGitCommand).toBe(true);
    expect(result.remote).toBe(false);
    expect(result.operations).toContain("unknown");
    expect(result.destructive).toBe(true);
    expect(result.failClosed).toBe(true);
  });

  test.each([
    "git checkout -p src/a.ts",
    "git branch -Dfeature/local",
    "git branch --delete=feature/local",
  ])("clasifica descartes y borrados locales como no soportados: %s", (command) => {
    const result = classifyGitCommand(command);

    expect(result.remote).toBe(false);
    expect(result.destructive).toBe(true);
    expect(result.operations.some((operation) => operation === "discard" || operation === "branch-delete")).toBe(true);
  });

  test.each([
    "git commit -am '✨ feat(git): no debe stagear implicitamente'",
    "git commit --all -m '✨ feat(git): no debe stagear implicitamente'",
    "git commit -i src/a.ts -m '✨ feat(git): no debe stagear implicitamente'",
    "git commit -o src/a.ts -m '✨ feat(git): no debe stagear implicitamente'",
    "git commit -p",
    "git commit --interactive",
    "git commit --only src/a.ts -m '✨ feat(git): no debe stagear implicitamente'",
    "git commit --patch",
    "git commit --pathspec-from-file=paths.txt -m '✨ feat(git): no debe stagear implicitamente'",
    "git commit -m '✨ feat(git): no debe stagear implicitamente' -- src/a.ts",
    "git commit --include src/a.ts -m '✨ feat(git): no debe stagear implicitamente'",
  ])("detecta el stage implicito dentro de commit: %s", (command) => {
    const result = classifyGitCommand(command);

    expect(result.remote).toBe(false);
    expect(result.operations).toContain("implicit-stage");
  });

  test("no interpreta los cuerpos -m acordados como opciones de stage implicito", () => {
    const command = [
      "git commit",
      "-m '🔒 feat(git): impone política local-only'",
      "-m '- bloquea Git remoto y mutaciones locales no modeladas'",
      "-m '- vincula stage y commit al conjunto exacto revisado'",
      "-m '- añade fallback portable ante bloqueos reales del host'",
    ].join(" ");

    const result = classifyGitCommand(command);

    expect(result.remote).toBe(false);
    expect(result.operations).toEqual(["commit"]);
    expect(result.destructive).toBe(false);
  });

  test.each([
    "git commit -m'- añade un cuerpo adjunto'",
    "git commit --message='- añade un cuerpo largo'",
    "git commit -F '-commit-message.txt'",
    "git commit --file '-commit-message.txt'",
    "git commit --author '- persona <persona@example.com>' -m '✨ feat(git): conserva datos'",
    "git commit -t '-commit-template.txt' -m '✨ feat(git): conserva datos'",
    "git commit --template '-commit-template.txt' -m '✨ feat(git): conserva datos'",
  ])("omite valores de opciones al detectar stage implicito: %s", (command) => {
    const result = classifyGitCommand(command);

    expect(result.operations).toEqual(["commit"]);
    expect(result.targets).toEqual([]);
  });

  test("la intencion commit solo cubre stage y commit ordinario", () => {
    expect(intentAuthorizes("commit", "stage")).toBe(true);
    expect(intentAuthorizes("commit", "commit")).toBe(true);
    expect(intentAuthorizes("commit", "amend")).toBe(false);
    expect(intentAuthorizes("commit", "reset")).toBe(false);
    expect(intentAuthorizes("commit", "merge")).toBe(false);
  });

  test("la evidencia local queda ligada a proyecto, comando y paths y se consume una vez", () => {
    const registry = createGitIntentRegistry({ ttlMs: 60_000 });
    registry.register({
      project: "malahor",
      intent: "commit",
      command: "git add -- src/a.ts",
      paths: ["src/a.ts"],
      now: 100,
    });

    expect(registry.consume({
      project: "malahor",
      operation: "stage",
      command: "git add -- src/b.ts",
      paths: ["src/b.ts"],
      now: 101,
    })).toBeUndefined();
    expect(registry.consume({
      project: "malahor",
      operation: "stage",
      command: "git add -- src/a.ts",
      paths: ["src/a.ts"],
      now: 102,
    })?.intent).toBe("commit");
    expect(registry.consume({
      project: "malahor",
      operation: "stage",
      command: "git add -- src/a.ts",
      paths: ["src/a.ts"],
      now: 103,
    })).toBeUndefined();
  });

  test("no colapsa nombres Git que difieren por espacios significativos", () => {
    const registry = createGitIntentRegistry();
    registry.register({
      project: "malahor",
      intent: "commit",
      command: "git add -- ' src/a.ts'",
      paths: [" src/a.ts"],
      now: 100,
    });

    expect(registry.consume({
      project: "malahor",
      operation: "stage",
      command: "git add -- ' src/a.ts'",
      paths: ["src/a.ts"],
      now: 101,
    })).toBeUndefined();
  });
});
