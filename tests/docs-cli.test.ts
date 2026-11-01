import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runDocs, type DocsOptions } from "../src/cli/commands/docs";

const ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "MALAHOR_HOME",
  "MALAHOR_CONFIG",
  "MALAHOR_OPENCODE_DIR",
  "MALAHOR_OPENCODE_DETECT",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
] as const;

let scratch: string;
let repo: string;
let home: string;
let previousEnv: Record<string, string | undefined>;

function invoke(overrides: Partial<DocsOptions>): string {
  const options: DocsOptions = {
    action: "status",
    args: [],
    project: "demo",
    path: undefined,
    app: undefined,
    dryRun: false,
    apply: false,
    yes: false,
    ...overrides,
  };
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  let output = "";
  try {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    runDocs(options);
    return output;
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  }
}

function projects(): Record<string, { docs?: { path: string } }> {
  return JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf8"));
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-docs-cli-"));
  repo = path.join(scratch, "repo");
  home = path.join(scratch, "malahor-home");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, "assets", "vault-template"), { recursive: true });
  fs.writeFileSync(path.join(home, "assets", "vault-template", "README.md"), "---\ntype: vault\n---\n\n# Vault\n");
  fs.writeFileSync(path.join(home, "projects.json"), `${JSON.stringify({
    demo: { context: "memory", roots: [repo], defaultRoot: repo },
  }, null, 2)}\n`, "utf8");

  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: path.join(scratch, "user"),
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    MALAHOR_HOME: home,
    MALAHOR_CONFIG: path.join(home, "config.jsonc"),
    MALAHOR_OPENCODE_DIR: path.join(scratch, "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  });
  delete process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_INTEROP;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("CLI docs", () => {
  test("valida que --path, --app, --apply y --yes solo aparezcan donde corresponden", () => {
    expect(() => invoke({ action: "status", path: path.join(scratch, "external") })).toThrow(/--path solo/i);
    expect(() => invoke({ action: "init", path: "relative/docs" })).toThrow(/ruta documental.*absoluta/i);
    expect(() => invoke({ action: "status", app: "vscode" })).toThrow(/--app solo/i);
    expect(() => invoke({ action: "status", apply: true })).toThrow(/--apply.*solo/i);
    expect(() => invoke({ action: "move", yes: true })).toThrow(/--yes requiere --apply/i);
    invoke({ action: "init" });
    expect(() => invoke({ action: "open", app: "emacs", dryRun: true })).toThrow(/system, vscode u obsidian/i);
    expect(() => invoke({ action: "path", args: ["extra"] })).toThrow(/Uso: malahor-ai docs path/i);
  });

  test("path/status/init usan el proyecto registrado y el override solo se persiste fuera del dry-run", () => {
    const pathOutput = invoke({ action: "path" });
    expect(pathOutput).toContain(`Project docs: ${path.join(home, "vault", "projects", "demo")}`);
    expect(pathOutput).toContain("Source: default");

    const initialStatus = invoke({ action: "status" });
    expect(initialStatus).toContain("Initialized: no");
    expect(initialStatus).toContain("MCP runtime: missing");

    const override = path.join(scratch, "external-docs", "demo");
    const dryRun = invoke({ action: "init", path: override, dryRun: true });
    expect(dryRun).toContain("Override: would register");
    expect(fs.existsSync(override)).toBe(false);
    expect(projects().demo.docs).toBeUndefined();

    const initialized = invoke({ action: "init", path: override });
    expect(initialized).toContain("Override: registered");
    expect(fs.existsSync(path.join(override, "README.md"))).toBe(true);
    expect(projects().demo.docs?.path).toBe(override);
    expect(invoke({ action: "status" })).toContain("Initialized: yes");
    expect(invoke({ action: "path" })).toContain(`Project docs: ${override}`);
  });

  test("docs.client usa system por defecto y persiste JSONC con backup sin perder comentarios", () => {
    expect(invoke({ action: "client", args: ["get"] })).toContain("Documentation client: system");

    const original = [
      "{",
      "  // preferencia humana conservada",
      '  "docs": { "client": "system" },',
      '  "custom": { "kept": true }',
      "}",
      "",
    ].join("\n");
    const configFile = path.join(home, "config.jsonc");
    fs.writeFileSync(configFile, original, "utf8");

    const preview = invoke({ action: "client", args: ["obsidian"], dryRun: true });
    expect(preview).toContain("would set obsidian");
    expect(fs.readFileSync(configFile, "utf8")).toBe(original);

    const changed = invoke({ action: "client", args: ["set", "vscode"] });
    expect(changed).toContain("Documentation client: vscode");
    const persisted = fs.readFileSync(configFile, "utf8");
    expect(persisted).toContain("// preferencia humana conservada");
    expect(persisted).toContain('"client": "vscode"');
    expect(persisted).toContain('"custom": { "kept": true }');
    expect(invoke({ action: "client", args: ["status"] })).toContain("Documentation client: vscode");

    const backups = fs.readdirSync(path.join(home, "backups"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, "backups", backups[0]!), "utf8")).toBe(original);
  });

  test("open --dry-run aplica --app > docs.client > system sin lanzar aplicaciones", () => {
    invoke({ action: "init" });
    const expectedSystem = process.platform === "win32"
      ? "explorer.exe"
      : process.platform === "darwin" ? "open" : "xdg-open";

    const fallback = invoke({ action: "open", dryRun: true });
    expect(fallback).toContain("Requested client: system");
    expect(fallback).toContain(`Open: ${expectedSystem}`);

    fs.writeFileSync(path.join(home, "config.jsonc"), '{\n  "docs": { "client": "vscode" }\n}\n', "utf8");
    const configured = invoke({ action: "open", dryRun: true });
    expect(configured).toContain("Requested client: vscode");
    expect(configured).toContain("Open: code ");

    const explicit = invoke({ action: "open", app: "obsidian", dryRun: true });
    expect(explicit).toContain("Requested client: obsidian");
    expect(explicit).toContain(`Open: ${expectedSystem}`);
    expect(explicit).toContain("obsidian://open?path=");
  });

  test("move previsualiza y copia verificada sin borrar el origen", () => {
    invoke({ action: "init" });
    const source = path.join(scratch, "historical.md");
    const content = "---\ntype: historical\n---\n\n# Historia\n";
    fs.writeFileSync(source, content, "utf8");
    const destination = path.join(home, "vault", "projects", "demo", "historical.md");

    const preview = invoke({ action: "move", args: [source] });
    expect(preview).toContain("Move preview: 1 Markdown(s); el origen se conserva.");
    expect(preview).toContain("Preview only");
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readFileSync(source, "utf8")).toBe(content);

    const applied = invoke({ action: "move", args: [source], apply: true, yes: true });
    expect(applied).toContain("Copied and verified: 1");
    expect(fs.readFileSync(destination, "utf8")).toBe(content);
    expect(fs.readFileSync(source, "utf8")).toBe(content);
  });

  test("move exige --yes al aplicar y no sobrescribe conflictos", () => {
    invoke({ action: "init" });
    const source = path.join(scratch, "conflict.md");
    fs.writeFileSync(source, "source", "utf8");
    expect(() => invoke({ action: "move", args: [source], apply: true })).toThrow(/requiere --yes/i);

    const destination = path.join(home, "vault", "projects", "demo", "conflict.md");
    fs.writeFileSync(destination, "destination", "utf8");
    expect(() => invoke({ action: "move", args: [source], apply: true, yes: true })).toThrow(/conflicto/i);
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    expect(fs.readFileSync(destination, "utf8")).toBe("destination");
  });
});
