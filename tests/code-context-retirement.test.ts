import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const RETIRED_PROVIDER = "graphify";

function filesBelow(root: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(target, extension));
    else if (entry.isFile() && target.endsWith(extension)) files.push(target);
  }
  return files;
}

function runCli(...args: string[]): ReturnType<typeof spawnSync> {
  const home = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-retirement-cli-"));
  return spawnSync("bun", [path.join(ROOT, "src/cli/index.ts"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      MALAHOR_HOME: path.join(home, ".malahor"),
      MALAHOR_OPENCODE_DIR: path.join(home, ".config", "opencode"),
      MALAHOR_OPENCODE_DETECT: "0",
    },
  });
}

describe("retiro del proveedor de contexto de código", () => {
  test("el CLI ya no publica comandos ni flags retirados", () => {
    const help = runCli("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).not.toMatch(new RegExp(RETIRED_PROVIDER, "i"));
    expect(help.stdout).not.toContain("--with-graphify");
    expect(help.stdout).not.toContain("  graph ");

    const context = runCli("context", "status");
    expect(context.status).toBe(0);
    expect(context.stdout).toContain("Context level: memory+codegraph");
    expect(context.stdout).toContain("Code context: degradado");
    expect(context.stdout).not.toMatch(new RegExp(RETIRED_PROVIDER, "i"));

    const retired = runCli(RETIRED_PROVIDER);
    expect(retired.status).toBe(1);
    expect(retired.stderr).toContain(`Unknown command: ${RETIRED_PROVIDER}`);
  });

  test("el paquete y la documentación activa no lo anuncian", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      description: string;
      keywords: string[];
      scripts: Record<string, string>;
    };
    const metadata = JSON.stringify({
      description: packageJson.description,
      keywords: packageJson.keywords,
      scripts: packageJson.scripts,
    });
    expect(metadata).not.toMatch(new RegExp(RETIRED_PROVIDER, "i"));

    const docs = [path.join(ROOT, "README.md"), ...filesBelow(path.join(ROOT, "assets"), ".md")];
    for (const file of docs) {
      expect(fs.readFileSync(file, "utf8")).not.toMatch(new RegExp(RETIRED_PROVIDER, "i"));
    }
  });

  test("la implementación ejecutable y sus campos especializados desaparecieron", () => {
    expect(fs.existsSync(path.join(ROOT, "src/cli/commands/graph.ts"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "src/cli/core/graphify.ts"))).toBe(false);

    for (const file of [
      "src/cli/index.ts",
      "src/cli/commands/install.ts",
      "src/cli/commands/update.ts",
      "src/cli/commands/doctor.ts",
      "src/cli/core/detector.ts",
      "src/cli/core/injector.ts",
      "src/cli/core/paths.ts",
      "src/cli/core/project.ts",
      "src/plugin/protocol.ts",
    ]) {
      expect(fs.readFileSync(path.join(ROOT, file), "utf8")).not.toMatch(new RegExp(RETIRED_PROVIDER, "i"));
    }

    const pathsSource = fs.readFileSync(path.join(ROOT, "src/cli/core/paths.ts"), "utf8");
    const projectSource = fs.readFileSync(path.join(ROOT, "src/cli/core/project.ts"), "utf8");
    expect(pathsSource).not.toContain("graphsDir");
    expect(projectSource).not.toContain("graphKey");
  });
});
