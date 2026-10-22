import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  MALAHOR_COMMAND_FILES,
  removeOpenCodeCommands,
  syncOpenCodeCommands,
} from "../src/cli/core/opencode-commands";
import type { MalahorPaths } from "../src/cli/core/paths";

const COMMANDS_DIR = path.join(process.cwd(), "assets", "opencode", "commands");
const AGENTS_DIR = path.join(process.cwd(), "assets", "opencode", "agents");

function tempPaths(): MalahorPaths {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-commands-"));
  return { opencodeDir: path.join(root, "opencode") } as unknown as MalahorPaths;
}

describe("comandos gestionados de OpenCode", () => {
  test("incluye contexto y commit, sin duplicados", () => {
    expect(MALAHOR_COMMAND_FILES).toContain("malahor-contexto.md");
    expect(MALAHOR_COMMAND_FILES).toContain("malahor-commit.md");
    expect(MALAHOR_COMMAND_FILES.length).toBe(8);
    expect(new Set(MALAHOR_COMMAND_FILES).size).toBe(MALAHOR_COMMAND_FILES.length);
  });

  test("los assets tienen frontmatter y el flujo de commit conserva los guardrails", () => {
    for (const file of MALAHOR_COMMAND_FILES) {
      const content = fs.readFileSync(path.join(COMMANDS_DIR, file), "utf8");
      expect(content.startsWith("---\n")).toBe(true);
      expect(content).toContain("description:");
      expect(content.endsWith("\n")).toBe(true);
    }

    const context = fs.readFileSync(path.join(COMMANDS_DIR, "malahor-contexto.md"), "utf8");
    expect(context).toContain("malahor-ai context status");
    expect(context).toContain("MALAHOR_CLI_MISSING");
    expect(context).toContain("no asumas el cwd");

    const commit = fs.readFileSync(path.join(COMMANDS_DIR, "malahor-commit.md"), "utf8");
    expect(commit).toContain('No inicies este flujo por "continua", "listo", "cierra la fase"');
    expect(commit).toContain("git status --short");
    expect(commit).toContain("git diff --stat");
    expect(commit).toContain("malahor-diagnostico");
    expect(commit).toContain("malahor-testing");
    expect(commit).toContain("git-commit-text");
    expect(commit).toContain("malahor-ai git precommit");
    expect(commit).toContain("git commit -m");
    expect(commit).toContain("Nunca autoriza push");
    expect(commit).toContain("No uses `--no-verify`");
    expect(commit).not.toContain("!`git ");
  });

  test("los dos prompts primarios aplican el mismo flujo de commit", () => {
    for (const host of ["v1", "v2"]) {
      const prompt = fs.readFileSync(path.join(AGENTS_DIR, host, "malahor.md"), "utf8");
      expect(prompt).toContain("/malahor-commit");
      expect(prompt).toContain("git-commit-text");
      expect(prompt).toContain("testing+build");
      expect(prompt).toContain("malahor-ai git precommit");
      expect(prompt).toContain("Nunca push");
    }
  });

  test("sync y remove solo tocan los comandos gestionados", () => {
    const paths = tempPaths();
    const synced = syncOpenCodeCommands(COMMANDS_DIR, paths, false);

    expect(synced.files).toBe(MALAHOR_COMMAND_FILES.length);
    for (const file of MALAHOR_COMMAND_FILES) {
      expect(fs.existsSync(path.join(synced.destination, file))).toBe(true);
    }

    const foreign = path.join(synced.destination, "mi-comando.md");
    fs.writeFileSync(foreign, "---\ndescription: propio\n---\n", "utf8");

    expect(removeOpenCodeCommands(paths, false)).toBe(MALAHOR_COMMAND_FILES.length);
    for (const file of MALAHOR_COMMAND_FILES) {
      expect(fs.existsSync(path.join(synced.destination, file))).toBe(false);
    }
    expect(fs.existsSync(foreign)).toBe(true);
  });

  test("sync y remove respetan dry-run", () => {
    const paths = tempPaths();
    const synced = syncOpenCodeCommands(COMMANDS_DIR, paths, true);
    expect(synced.files).toBe(MALAHOR_COMMAND_FILES.length);
    expect(fs.existsSync(synced.destination)).toBe(false);

    fs.mkdirSync(synced.destination, { recursive: true });
    const managed = path.join(synced.destination, "malahor-commit.md");
    fs.writeFileSync(managed, "---\ndescription: prueba\n---\n", "utf8");

    expect(removeOpenCodeCommands(paths, true)).toBe(1);
    expect(fs.existsSync(managed)).toBe(true);
  });
});
