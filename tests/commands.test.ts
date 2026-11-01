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
  test("retira el comando y API legacy de Obsidian de la CLI publica", () => {
    const commandPath = path.join(process.cwd(), "src", "cli", "commands", "obsidian.ts");
    const indexSource = fs.readFileSync(path.join(process.cwd(), "src", "cli", "index.ts"), "utf8");
    expect(fs.existsSync(commandPath)).toBe(false);
    expect(indexSource).not.toMatch(/commands\/obsidian|case\s+["']obsidian["']/);

    const run = Bun.spawnSync(["bun", "run", "src/cli/index.ts", "obsidian"], {
      cwd: process.cwd(),
      env: { ...process.env, MALAHOR_OPENCODE_DETECT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("Unknown command: obsidian");
    expect(run.stdout.toString()).not.toMatch(/^\s+obsidian\s+/m);
  });

  test("incluye contexto, commit y actualizar exactamente una vez", () => {
    const commandFiles: readonly string[] = MALAHOR_COMMAND_FILES;
    expect(commandFiles).toContain("malahor-contexto.md");
    expect(commandFiles).toContain("malahor-commit.md");
    expect(commandFiles).toContain("malahor-actualizar.md");
    expect(commandFiles.filter((file) => file === "malahor-actualizar.md")).toHaveLength(1);
    expect(commandFiles.length).toBe(9);
    expect(new Set(commandFiles).size).toBe(commandFiles.length);
  });

  test("actualizar usa el CLI o artefacto local, valida con doctor y deriva ausencias a bootstrap", () => {
    const updatePath = path.join(COMMANDS_DIR, "malahor-actualizar.md");
    expect(fs.existsSync(updatePath)).toBe(true);

    const update = fs.readFileSync(updatePath, "utf8");
    const capsule = update.split("\n").find((line) => line.startsWith("!`")) ?? "";
    expect(capsule).toContain("malahor-ai update --yes");
    expect(capsule).toMatch(/(?:bun(?: run)? src\/cli\/index\.ts|node (?:\.\/)?dist\/index\.js)\s+update --yes/);
    expect(capsule).not.toMatch(/\bnpx\b/i);
    expect(capsule).not.toMatch(/\binstall\s+--bootstrap\b/i);
    expect(update).toContain("malahor-ai doctor");
    expect(update.indexOf("malahor-ai doctor")).toBeGreaterThan(update.indexOf("update --yes"));
    expect(update).toMatch(/(?:si|tras|despu[eé]s)[^\n]{0,200}(?:actualizaci[oó]n|update)[^\n]{0,200}(?:[eé]xit|complet)[^\n]{0,200}(?:malahor-ai )?doctor/i);
    expect(update).toContain("MALAHOR_CLI_MISSING");
    expect(update).toContain("/malahor-bootstrap");
  });

  test("bootstrap queda reservado a ausencia, reinstalacion o reparacion", () => {
    const bootstrap = fs.readFileSync(path.join(COMMANDS_DIR, "malahor-bootstrap.md"), "utf8");
    const frontmatter = bootstrap.split("---", 3)[1] ?? "";

    expect(frontmatter).not.toMatch(/actualiz/i);
    expect(bootstrap).not.toMatch(/["'`]actualiza malahor["'`]/i);
    expect(bootstrap).toMatch(/instalaci[oó]n ausente|MALAHOR_CLI_MISSING/i);
    expect(bootstrap).toMatch(/reinstal/i);
    expect(bootstrap).toMatch(/repar/i);
  });

  test("update dry-run valida el rollout en sandbox sin escribir la instalacion", () => {
    const sandboxRoot = path.join("/tmp/opencode", ".sandbox");
    fs.mkdirSync(sandboxRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(sandboxRoot, "malahor-runtime-update-"));
    const malahorHome = path.join(root, ".malahor");
    const opencodeDir = path.join(root, "opencode");

    try {
      const run = Bun.spawnSync([
        "bun", "run", "src/cli/index.ts", "update", "--dry-run", "--yes",
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, ".config"),
          MALAHOR_HOME: malahorHome,
          MALAHOR_OPENCODE_DIR: opencodeDir,
          MALAHOR_OPENCODE_DETECT: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = run.stdout.toString();
      expect(run.exitCode).toBe(0);
      expect(run.stderr.toString()).toBe("");
      expect(stdout).toContain("Sandbox: yes");
      expect(stdout).toContain("Dry-run: yes");
      expect(stdout).toContain("OpenCode commands: would refresh 9");
      expect(stdout).toContain("Validation: skipped in dry-run");
      expect(fs.existsSync(path.join(malahorHome, "config.jsonc"))).toBe(false);
      expect(fs.existsSync(path.join(malahorHome, "assets"))).toBe(false);
      expect(fs.existsSync(path.join(malahorHome, "mnemo", "index.js"))).toBe(false);
      expect(fs.existsSync(opencodeDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    expect(commit).toContain("Ejecuta directamente el diagnostico disponible del stack");
    expect(commit).toContain("Ejecuta directamente las pruebas");
    expect(commit).toContain("No delegues un commit nivel 0");
    expect(commit).toContain("git-commit-text");
    expect(commit).not.toContain("caveman-commit");
    expect(commit).toContain("malahor-ai git precommit");
    expect(commit).toContain("git commit -m");
    expect(commit).toContain("Git remoto es hard DENY");
    expect(commit).toContain('intent: "commit"');
    expect(commit).toContain("malahor-ai git commit-fallback");
    expect(commit).toContain('--paths \'["ruta/uno.ts","ruta/con,coma.ts"]\'');
    expect(commit).toContain("PowerShell");
    expect(commit).toContain("git --no-pager log -1");
    expect(commit).toContain("No uses `--no-verify`");
    expect(commit).not.toContain("git prepush");
    expect(commit).not.toContain("!`git ");

    const gitHelp = Bun.spawnSync(["bun", "run", "src/cli/index.ts", "git", "help"], {
      cwd: process.cwd(),
      env: { ...process.env, MALAHOR_OPENCODE_DETECT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(gitHelp.exitCode).toBe(0);
    expect(gitHelp.stdout.toString()).toContain("--paths <json-array>");
  });

  test("los dos prompts primarios aplican el mismo flujo de commit", () => {
    for (const host of ["v1", "v2"]) {
      const prompt = fs.readFileSync(path.join(AGENTS_DIR, host, "malahor.md"), "utf8");
      expect(prompt).toContain("/malahor-commit");
      expect(prompt).toContain("git-commit-text");
      expect(prompt).not.toContain("carga `caveman-commit`");
      expect(prompt).toContain("testing+build");
      expect(prompt).toContain("malahor-ai git precommit");
      expect(prompt).toContain("Git es local-only");
      expect(prompt).toContain("commit-fallback");
      expect(prompt).toMatch(/sin (?:otra )?confirmación redundante/);
    }
  });

  test("git commit-message propaga --breaking sin mutar el repositorio", () => {
    const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-commit-message-"));
    const cli = path.join(process.cwd(), "src", "cli", "index.ts");
    const env = {
      ...process.env,
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "home", ".config"),
      MALAHOR_HOME: path.join(root, "home", ".malahor"),
      MALAHOR_CONFIG: path.join(root, "home", ".malahor", "config.jsonc"),
      MALAHOR_OPENCODE_DIR: path.join(root, "home", ".config", "opencode"),
      MALAHOR_OPENCODE_DETECT: "0",
    };
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"commit-message-fixture"}\n', "utf8");

    try {
      const run = Bun.spawnSync([
        "bun", "run", cli, "git", "commit-message", "Cambia", "API", "pública",
        "--type", "feat", "--scope", "api", "--breaking", "--json",
      ], { cwd: root, env, stdout: "pipe", stderr: "pipe" });

      expect(run.exitCode).toBe(0);
      expect(run.stderr.toString()).toBe("");
      const result = JSON.parse(run.stdout.toString()) as { action: string; message: string; hookResult: { decision: string } };
      expect(result.action).toBe("commit-message");
      expect(result.message).toBe("✨ feat(api)!: cambia API pública");
      expect(result.hookResult.decision).toBe("allow");

      const help = Bun.spawnSync(["bun", "run", cli, "git", "help"], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(help.exitCode).toBe(0);
      expect(help.stdout.toString()).toContain("--breaking");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("sync y remove solo tocan los comandos gestionados", () => {
    const paths = tempPaths();
    const synced = syncOpenCodeCommands(COMMANDS_DIR, paths, false);

    expect(synced.files).toBe(MALAHOR_COMMAND_FILES.length);
    expect(fs.existsSync(path.join(synced.destination, "malahor-actualizar.md"))).toBe(true);
    for (const file of MALAHOR_COMMAND_FILES) {
      expect(fs.existsSync(path.join(synced.destination, file))).toBe(true);
    }

    const foreign = path.join(synced.destination, "mi-comando.md");
    fs.writeFileSync(foreign, "---\ndescription: propio\n---\n", "utf8");

    expect(removeOpenCodeCommands(paths, false)).toBe(MALAHOR_COMMAND_FILES.length);
    expect(fs.existsSync(path.join(synced.destination, "malahor-actualizar.md"))).toBe(false);
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
    const managed = path.join(synced.destination, "malahor-actualizar.md");
    fs.writeFileSync(managed, "---\ndescription: prueba\n---\n", "utf8");

    expect(removeOpenCodeCommands(paths, true)).toBe(1);
    expect(fs.existsSync(managed)).toBe(true);
  });
});
