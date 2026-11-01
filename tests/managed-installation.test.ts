import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { copyAssets } from "../src/cli/core/assets";
import { removeManagedInstructions } from "../src/cli/core/instructions";
import {
  beginManagedInstallation,
  pruneLegacyRuntimeArtifacts,
  type ManagedInstallationTransaction,
} from "../src/cli/core/managed-installation";
import {
  MALAHOR_COMMAND_FILES,
  managedCommandsManifestPath,
  removeOpenCodeCommands,
  syncOpenCodeCommands,
} from "../src/cli/core/opencode-commands";
import { resolvePaths, type MalahorPaths } from "../src/cli/core/paths";

const COMMANDS_DIR = path.join(process.cwd(), "assets", "opencode", "commands");
const roots: string[] = [];

function scratch(): string {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-managed-installation-"));
  roots.push(root);
  return root;
}

function pathsFor(root: string): MalahorPaths {
  return resolvePaths({
    HOME: path.join(root, "user"),
    XDG_CONFIG_HOME: path.join(root, "user", ".config"),
    MALAHOR_HOME: path.join(root, "user", ".malahor"),
    MALAHOR_CONFIG: path.join(root, "user", ".malahor", "config.jsonc"),
    MALAHOR_OPENCODE_DIR: path.join(root, "user", ".config", "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  }, path.join(root, "repo"));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function metadata(transaction: ManagedInstallationTransaction): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(transaction.backupDirectory, "transaction.json"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("instalación gestionada limpia", () => {
  test("assets reemplaza el árbol gestionado completo y no deja residuos", () => {
    const root = scratch();
    const source = path.join(root, "source");
    const destination = path.join(root, "home", ".malahor", "assets");
    write(path.join(source, "opencode", "AGENTS.md"), "nuevo\n");
    write(path.join(destination, "opencode", "AGENTS.md"), "anterior\n");
    write(path.join(destination, "opencode", "OPENCODE.md"), "residuo legacy\n");

    const result = copyAssets(source, destination, false);

    expect(result.replaced).toBe(true);
    expect(fs.readFileSync(path.join(destination, "opencode", "AGENTS.md"), "utf8")).toBe("nuevo\n");
    expect(fs.existsSync(path.join(destination, "opencode", "OPENCODE.md"))).toBe(false);
  });

  test("assets dry-run no crea, reemplaza ni retira archivos", () => {
    const root = scratch();
    const source = path.join(root, "source");
    const destination = path.join(root, "assets");
    write(path.join(source, "fresh.md"), "fresh\n");
    write(path.join(destination, "stale.md"), "stale\n");

    const result = copyAssets(source, destination, true);

    expect(result.replaced).toBe(false);
    expect(fs.existsSync(path.join(destination, "fresh.md"))).toBe(false);
    expect(fs.readFileSync(path.join(destination, "stale.md"), "utf8")).toBe("stale\n");
  });

  test("rollback restaura payload, configuración y archivos ajenos capturados", () => {
    const root = scratch();
    const paths = pathsFor(root);
    write(path.join(paths.assetsDir, "old.md"), "old asset\n");
    write(path.join(paths.opencodeDir, "commands", "foreign.md"), "foreign\n");
    write(path.join(paths.opencodeDir, "skills", "foreign", "SKILL.md"), "old foreign skill\n");
    write(paths.opencodeConfig, "{\"old\":true}\n");
    write(paths.mnemoIndex, "old runtime\n");

    const transaction = beginManagedInstallation(paths, false);
    fs.rmSync(paths.assetsDir, { recursive: true });
    write(path.join(paths.assetsDir, "new.md"), "new asset\n");
    write(path.join(paths.opencodeDir, "commands", "foreign.md"), "changed\n");
    fs.rmSync(path.join(paths.opencodeDir, "skills"), { recursive: true, force: true });
    write(path.join(paths.opencodeDir, "skills", "managed-new", "SKILL.md"), "new managed skill\n");
    write(paths.opencodeConfig, "{\"new\":true}\n");
    write(paths.docsIndex, "new docs runtime\n");

    transaction.rollback();

    expect(fs.readFileSync(path.join(paths.assetsDir, "old.md"), "utf8")).toBe("old asset\n");
    expect(fs.existsSync(path.join(paths.assetsDir, "new.md"))).toBe(false);
    expect(fs.readFileSync(path.join(paths.opencodeDir, "commands", "foreign.md"), "utf8")).toBe("foreign\n");
    expect(fs.readFileSync(path.join(paths.opencodeDir, "skills", "foreign", "SKILL.md"), "utf8")).toBe("old foreign skill\n");
    expect(fs.existsSync(path.join(paths.opencodeDir, "skills", "managed-new"))).toBe(false);
    expect(fs.readFileSync(paths.opencodeConfig, "utf8")).toBe("{\"old\":true}\n");
    expect(fs.readFileSync(paths.mnemoIndex, "utf8")).toBe("old runtime\n");
    expect(fs.existsSync(paths.docsIndex)).toBe(false);
    expect(metadata(transaction).status).toBe("rolled-back");
  });

  test("install y update sincronizan skills; uninstall usa la eliminación acreditada", () => {
    const install = fs.readFileSync(path.join(process.cwd(), "src", "cli", "commands", "install.ts"), "utf8");
    const update = fs.readFileSync(path.join(process.cwd(), "src", "cli", "commands", "update.ts"), "utf8");
    const uninstall = fs.readFileSync(path.join(process.cwd(), "src", "cli", "commands", "uninstall.ts"), "utf8");

    for (const source of [install, update]) {
      expect(source).toMatch(/syncOpenCodeSkills\s*\(/);
      expect(source).toMatch(/assetsDir[\s\S]{0,120}["']skills["']/);
    }
    expect(uninstall).toMatch(/removeOpenCodeSkills\s*\(/);
  });

  test("commit conserva el payload nuevo y un backup verificable", () => {
    const root = scratch();
    const paths = pathsFor(root);
    write(path.join(paths.assetsDir, "old.md"), "old\n");
    const transaction = beginManagedInstallation(paths, false);
    write(path.join(paths.assetsDir, "old.md"), "new\n");

    transaction.commit();

    expect(fs.readFileSync(path.join(paths.assetsDir, "old.md"), "utf8")).toBe("new\n");
    expect(fs.existsSync(transaction.backupDirectory)).toBe(true);
    expect(metadata(transaction).status).toBe("committed");
  });

  test("poda dependencias runtime legacy y conserva la base de memoria", () => {
    const root = scratch();
    const paths = pathsFor(root);
    write(paths.mnemoDb, "{\"observations\":[]}\n");
    write(path.join(paths.mnemoDir, "package.json"), "{}\n");
    write(path.join(paths.mnemoDir, "node_modules", "legacy", "index.js"), "legacy\n");
    write(path.join(paths.docsDir, "package-lock.json"), "{}\n");

    const removed = pruneLegacyRuntimeArtifacts(paths, false);

    expect(removed).toHaveLength(3);
    expect(fs.readFileSync(paths.mnemoDb, "utf8")).toBe("{\"observations\":[]}\n");
    expect(fs.existsSync(path.join(paths.mnemoDir, "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(paths.mnemoDir, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(paths.docsDir, "package-lock.json"))).toBe(false);
  });

  test("instalación previa sin manifest se adopta sin tocar comandos ajenos", () => {
    const root = scratch();
    const paths = pathsFor(root);
    const destination = path.join(paths.opencodeDir, "commands");
    write(path.join(destination, "malahor-commit.md"), "legacy managed\n");
    write(path.join(destination, "foreign.md"), "foreign\n");

    const result = syncOpenCodeCommands(COMMANDS_DIR, paths, false);

    expect(result.files).toBe(MALAHOR_COMMAND_FILES.length);
    expect(fs.existsSync(managedCommandsManifestPath(paths))).toBe(true);
    expect(fs.readFileSync(path.join(destination, "foreign.md"), "utf8")).toBe("foreign\n");
  });

  test("sync poda residuos acreditados y conserva un residuo modificado", () => {
    const root = scratch();
    const paths = pathsFor(root);
    syncOpenCodeCommands(COMMANDS_DIR, paths, false);
    const destination = path.join(paths.opencodeDir, "commands");
    const stale = path.join(destination, "malahor-old.md");
    const changed = path.join(destination, "malahor-customized.md");
    write(stale, "owned stale\n");
    write(changed, "user version\n");
    const manifest = JSON.parse(fs.readFileSync(managedCommandsManifestPath(paths), "utf8")) as {
      version: number;
      files: Array<{ name: string; sha256: string }>;
    };
    manifest.files.push(
      { name: "malahor-old.md", sha256: sha256("owned stale\n") },
      { name: "malahor-customized.md", sha256: sha256("original managed\n") },
    );
    fs.writeFileSync(managedCommandsManifestPath(paths), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = syncOpenCodeCommands(COMMANDS_DIR, paths, false);

    expect(result.removed).toBe(1);
    expect(result.preserved).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(changed, "utf8")).toBe("user version\n");
  });

  test("un manifest manipulado no puede borrar fuera de commands ni seguir symlinks", () => {
    if (process.platform === "win32") return;
    const root = scratch();
    const paths = pathsFor(root);
    syncOpenCodeCommands(COMMANDS_DIR, paths, false);
    const destination = path.join(paths.opencodeDir, "commands");
    const outside = path.join(root, "outside.md");
    const linked = path.join(destination, "malahor-linked.md");
    write(outside, "outside\n");
    fs.symlinkSync(outside, linked);
    const manifestPath = managedCommandsManifestPath(paths);
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      version: 1,
      files: [
        { name: "../outside.md", sha256: sha256("outside\n") },
        { name: "malahor-linked.md", sha256: sha256("outside\n") },
      ],
    })}\n`, "utf8");

    const result = syncOpenCodeCommands(COMMANDS_DIR, paths, false);

    expect(result.removed).toBe(0);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside\n");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
  });

  test("uninstall usa hashes o fallback legacy y conserva comandos ajenos", () => {
    const root = scratch();
    const paths = pathsFor(root);
    const synced = syncOpenCodeCommands(COMMANDS_DIR, paths, false);
    const foreign = path.join(synced.destination, "foreign.md");
    write(foreign, "foreign\n");

    expect(removeOpenCodeCommands(paths, false)).toBe(MALAHOR_COMMAND_FILES.length);
    expect(fs.readFileSync(foreign, "utf8")).toBe("foreign\n");
    expect(fs.existsSync(managedCommandsManifestPath(paths))).toBe(false);
  });

  test("uninstall de instrucciones exige marcador y respeta dry-run", () => {
    const root = scratch();
    const backups = path.join(root, "backups");
    const foreign = path.join(root, "OPENCODE.md");
    write(foreign, "# archivo propio\n");
    expect(removeManagedInstructions(foreign, backups, false).action).toBe("kept-foreign");
    expect(fs.existsSync(foreign)).toBe(true);

    const managed = path.join(root, "AGENTS.md");
    write(managed, "<!-- malahor-managed: fixture -->\n");
    expect(removeManagedInstructions(managed, backups, true).action).toBe("would-remove");
    expect(fs.existsSync(managed)).toBe(true);
    expect(removeManagedInstructions(managed, backups, false).action).toBe("removed");
    expect(fs.existsSync(managed)).toBe(false);
  });
});
