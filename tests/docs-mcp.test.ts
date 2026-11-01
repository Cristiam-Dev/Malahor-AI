import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { callTool } from "../src/docs/index";
import { docsToolDefinitions } from "../src/docs/tool-definitions";

const ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "MALAHOR_HOME",
  "MALAHOR_CONFIG",
  "MALAHOR_OPENCODE_DIR",
  "MALAHOR_OPENCODE_DETECT",
] as const;

let scratch: string;
let repo: string;
let home: string;
let projectDocs: string;
let previousEnv: Record<string, string | undefined>;

function docsCall(name: string, args: Record<string, unknown>): unknown {
  return callTool({ name, arguments: args });
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-docs-mcp-"));
  repo = path.join(scratch, "repo");
  home = path.join(scratch, "malahor-home");
  projectDocs = path.join(home, "vault", "projects", "demo");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDocs, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
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
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("contrato MCP first-party docs", () => {
  test("publica las ocho tools con schemas cerrados y open acotada", () => {
    expect(docsToolDefinitions.map((tool) => tool.name)).toEqual([
      "resolve", "list", "read", "search", "write", "append", "move", "open",
    ]);
    for (const tool of docsToolDefinitions) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required).toContain("project");
    }

    const write = docsToolDefinitions.find((tool) => tool.name === "write")!;
    const move = docsToolDefinitions.find((tool) => tool.name === "move")!;
    const open = docsToolDefinitions.find((tool) => tool.name === "open")!;
    expect(write.inputSchema.properties.ifNoneMatch).toEqual({ type: "string", enum: ["*"] });
    expect(write.inputSchema.properties.ifMatch).toMatchObject({ pattern: "^[a-f0-9]{64}$" });
    expect(move.inputSchema.required).toEqual(["project", "source", "destination", "ifMatch"]);
    expect(open.inputSchema.required).toEqual(["project"]);
    expect(Object.keys(open.inputSchema.properties)).toEqual(["project", "path", "app"]);
    expect(open.inputSchema.properties.path).toMatchObject({ type: "string" });
    expect(open.inputSchema.properties.app).toEqual({ type: "string", enum: ["system", "vscode", "obsidian"] });
  });

  test("resolve/list/read/search/write/append/move operan solo en la raiz registrada", () => {
    const resolution = docsCall("resolve", { project: "demo" }) as {
      project: string; projectRoot: string; source: string;
    };
    expect(resolution).toMatchObject({ project: "demo", projectRoot: projectDocs, source: "default" });

    const created = docsCall("write", {
      project: "demo",
      path: "Product/brief.md",
      content: "---\ntype: brief\n---\n\nneedle\n",
      ifNoneMatch: "*",
    }) as { version: string; content: string };
    expect(created.version).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(path.join(projectDocs, "Product", "brief.md"), "utf8")).toBe(created.content);

    const appended = docsCall("append", {
      project: "demo",
      path: "Product/brief.md",
      content: "needle again\n",
      ifMatch: created.version,
    }) as { version: string; content: string };
    expect(appended.content).toContain("needle again");
    expect(appended.version).not.toBe(created.version);

    expect(docsCall("list", { project: "demo", path: "Product" })).toEqual([
      { path: "Product/brief.md", type: "file" },
    ]);
    expect(docsCall("read", { project: "demo", path: "Product/brief.md" })).toMatchObject({
      path: "Product/brief.md",
      version: appended.version,
    });
    expect(docsCall("search", { project: "demo", query: "NEEDLE", limit: 5 })).toEqual([
      expect.objectContaining({ path: "Product/brief.md", matches: 2 }),
    ]);

    const moved = docsCall("move", {
      project: "demo",
      source: "Product/brief.md",
      destination: "SDD/brief.md",
      ifMatch: appended.version,
    }) as { path: string; version: string };
    expect(moved).toMatchObject({ path: "SDD/brief.md", version: appended.version });
    expect(fs.existsSync(path.join(projectDocs, "Product", "brief.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectDocs, "SDD", "brief.md"))).toBe(true);
  });

  test("valida tipos, campos extra, limites y nombres de tool antes de tocar el store", () => {
    expect(() => callTool(undefined)).toThrow(/name debe ser string/i);
    expect(() => callTool({ name: "read", arguments: [] as unknown as Record<string, unknown> }))
      .toThrow(/arguments debe ser un objeto/i);
    expect(() => docsCall("resolve", { project: "demo", path: "extra" }))
      .toThrow(/Argumentos desconocidos.*path/i);
    expect(() => docsCall("open", { project: "demo", command: "rm -rf /" }))
      .toThrow(/Argumentos desconocidos.*command/i);
    expect(() => docsCall("open", { project: "demo", app: "emacs" }))
      .toThrow(/system, vscode u obsidian/i);
    expect(() => docsCall("open", { project: "demo", path: "../outside.md" }))
      .toThrow(/Traversal/i);
    expect(() => docsCall("open", { project: "demo", path: "/tmp/outside.md" }))
      .toThrow(/relativa/i);
    expect(() => docsCall("missing", { project: "demo" })).toThrow(/desconocida/i);
    expect(() => docsCall("read", { project: "demo", path: 7 })).toThrow(/path debe ser string/i);
    expect(() => docsCall("search", { project: "demo", query: "x", limit: 0 })).toThrow(/entero entre 1 y 50/i);
    expect(() => docsCall("search", { project: "demo", query: "x", limit: 1.5 })).toThrow(/entero entre 1 y 50/i);
    expect(() => docsCall("write", {
      project: "demo", path: "x.md", content: "x", ifNoneMatch: "anything",
    })).toThrow(/ifNoneMatch solo acepta/i);
    expect(() => docsCall("write", {
      project: "demo", path: "x.md", content: "x", ifMatch: "not-a-sha",
    })).toThrow(/SHA-256/i);
    expect(fs.readdirSync(projectDocs)).toEqual([]);
  });

  test("rechaza proyectos y paths arbitrarios sin tocar archivos externos", () => {
    const outside = path.join(scratch, "outside.md");
    fs.writeFileSync(outside, "sentinel", "utf8");

    expect(() => docsCall("resolve", { project: "unregistered" })).toThrow(/no esta registrado/i);
    for (const unsafe of ["../outside.md", "/tmp/outside.md", "C:\\vault\\outside.md"]) {
      expect(() => docsCall("write", {
        project: "demo", path: unsafe, content: "escaped", ifNoneMatch: "*",
      })).toThrow();
    }
    expect(fs.readFileSync(outside, "utf8")).toBe("sentinel");
    expect(fs.readdirSync(projectDocs)).toEqual([]);
  });

  test("propaga conflictos optimistas entre clientes MCP concurrentes", () => {
    const first = docsCall("write", {
      project: "demo", path: "race.md", content: "v1", ifNoneMatch: "*",
    }) as { version: string };
    const clientA = docsCall("read", { project: "demo", path: "race.md" }) as { version: string };
    const clientB = docsCall("read", { project: "demo", path: "race.md" }) as { version: string };
    expect(clientA.version).toBe(first.version);
    expect(clientB.version).toBe(first.version);

    docsCall("write", { project: "demo", path: "race.md", content: "winner", ifMatch: clientA.version });
    expect(() => docsCall("write", {
      project: "demo", path: "race.md", content: "stale", ifMatch: clientB.version,
    })).toThrow(/Version conflict/i);
    expect((docsCall("read", { project: "demo", path: "race.md" }) as { content: string }).content).toBe("winner");
  });
});
