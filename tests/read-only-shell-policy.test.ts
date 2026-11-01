import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { classifyReadOnlyShellCommand } from "../src/cli/core/read-only-shell-policy";

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-read-only-shell-"));
  outside = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-read-only-outside-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.mkdirSync(path.join(root, "schemas"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "fixture.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "README.md"), "# fixture\n");
  fs.writeFileSync(path.join(root, "LICENSE"), "fixture\n");
  fs.writeFileSync(path.join(root, "schemas", "policy.json"), "{}\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("politica shell read-only sin plan", () => {
  test.each([
    "git status --short --untracked-files=all",
    "git --no-pager diff --stat",
    "git diff --check",
    "git ls-files -- README.md src tests",
    "git show HEAD:schemas/policy.json | sha256sum",
    "sha256sum schemas/policy.json",
    "cmp -s README.md LICENSE",
    "rg -n fixture README.md src tests",
    "test ! -e docs && test -f README.md",
    "malahor-ai git commit-message 'protege núcleo' --type security --scope seguridad --icon '🛡️' --breaking --json",
    "pwd",
  ])("acepta solo inspeccion local verificable: %s", (command) => {
    expect(classifyReadOnlyShellCommand(command, root)).toEqual({ readOnly: true });
  });

  test.each([
    "git fetch --all",
    "git status && git fetch origin",
    "git add -- README.md",
    "git commit -m fixture",
    "git show --output=/tmp/leak HEAD",
    "git diff --ext-diff",
    "git log --show-signature -1",
    "git verify-commit HEAD",
    "git status --help",
    "rm -rf docs",
    "touch created.txt",
    "sed -i 's/a/b/' README.md",
    "cat README.md > copy.md",
    "sh -c 'git status'",
    "echo \"$(git status)\"",
    "cmp -s <(git show HEAD:README.md) README.md",
    "rg --pre cat fixture .",
    "rg '' /etc/passwd",
    "rg -e '' /etc/passwd",
    "unknown-inspector README.md",
    "bun test",
    "malahor-ai git precommit --message '✨ feat(cli): mutación no autorizada'",
    "malahor-ai git commit-fallback --message '✨ feat(cli): fallback' --paths '[\"src/a.ts\"]' --fingerprint sha256:abc --blocked-by host-deny",
    "malahor-ai install --dry-run",
  ])("falla cerrado ante mutacion, indirecciones o ejecutables desconocidos: %s", (command) => {
    expect(classifyReadOnlyShellCommand(command, root).readOnly).toBe(false);
  });

  test("rechaza rutas fuera de la raiz y enlaces que escapan", () => {
    const link = path.join(root, "outside-link.txt");
    fs.symlinkSync(path.join(outside, "secret.txt"), link);

    for (const command of [
      `sha256sum ${path.join(outside, "secret.txt")}`,
      "sha256sum ../outside/secret.txt",
      "sha256sum outside-link.txt",
      `test -f ${path.join(outside, "secret.txt")}`,
      "git -C ../outside status",
      "git --git-dir=../outside/.git status",
      "git -c core.pager=cat log -1",
      "git status -- /etc/passwd",
      "git show /etc/passwd",
      "test README.md -nt /etc/passwd",
    ]) {
      expect(classifyReadOnlyShellCommand(command, root).readOnly).toBe(false);
    }
  });

  test("resuelve rutas desde un subdirectorio sin permitir escapar de la raiz", () => {
    const src = path.join(root, "src");
    expect(classifyReadOnlyShellCommand("sha256sum fixture.ts", root, {
      workingDirectory: src,
    })).toEqual({ readOnly: true });
    expect(classifyReadOnlyShellCommand("sha256sum ../README.md", root, {
      workingDirectory: src,
    })).toEqual({ readOnly: true });
    expect(classifyReadOnlyShellCommand("sha256sum secret.txt", root, {
      workingDirectory: outside,
    }).readOnly).toBe(false);
  });
});
