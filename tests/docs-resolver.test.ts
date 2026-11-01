import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { resolvePaths, type MalahorPaths } from "../src/cli/core/paths";
import {
  normalizeDocsRootInput,
  openDocsClient,
  planDocsOpen,
  windowsPathForClient,
} from "../src/docs/client";
import {
  checkDocsProject,
  initializeDocsProject,
  resolveDocsProject,
  type DocsResolution,
} from "../src/docs/resolver";
import {
  appendDoc,
  listDocs,
  moveDoc,
  readDoc,
  searchDocs,
  versionOf,
  writeDoc,
} from "../src/docs/store";

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

let scratch: string;
let repo: string;
let home: string;
let paths: MalahorPaths;

function writeProjects(value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(paths.projectsFile), { recursive: true });
  fs.writeFileSync(paths.projectsFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function registeredProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context: "memory",
    roots: [repo],
    defaultRoot: repo,
    ...overrides,
  };
}

function directResolution(projectRoot = path.join(scratch, "store")): DocsResolution {
  fs.mkdirSync(projectRoot, { recursive: true });
  return {
    project: "demo",
    projectRoot,
    vaultRoot: path.join(scratch, "vault"),
    source: "override",
    initialized: true,
  };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-docs-resolver-"));
  repo = path.join(scratch, "repo");
  home = path.join(scratch, "malahor-home");
  fs.mkdirSync(repo, { recursive: true });
  paths = resolvePaths({
    HOME: path.join(scratch, "user"),
    MALAHOR_HOME: home,
    MALAHOR_OPENCODE_DIR: path.join(scratch, "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  }, repo);
  writeProjects({ demo: registeredProject() });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("resolver e inicializacion del vault documental", () => {
  test("resuelve la raiz default y un override absoluto externo para un proyecto registrado", () => {
    const defaultDocs = resolveDocsProject(paths, {}, "demo");
    expect(defaultDocs).toMatchObject({
      project: "demo",
      projectRoot: path.join(home, "vault", "projects", "demo"),
      vaultRoot: path.join(home, "vault"),
      source: "default",
      initialized: false,
    });

    const override = path.join(scratch, "external-docs", "demo");
    const customDocs = resolveDocsProject(paths, {}, "demo", override);
    expect(customDocs.projectRoot).toBe(override);
    expect(customDocs.source).toBe("override");
  });

  test("rechaza proyectos no registrados y claves que colisionan por mayusculas", () => {
    expect(() => resolveDocsProject(paths, {}, "missing")).toThrow(/no esta registrado/i);

    writeProjects({ demo: registeredProject(), Demo: registeredProject() });
    expect(() => resolveDocsProject(paths, {}, "demo")).toThrow(/colisionan/i);
  });

  test("rechaza raices dentro del repo, bajo MALAHOR_HOME, mediante symlink o solapadas", () => {
    expect(() => resolveDocsProject(paths, {}, "demo", path.join(repo, "docs")))
      .toThrow(/fuera de repositorios/i);
    expect(() => resolveDocsProject(paths, {}, "demo", path.join(home, "custom")))
      .toThrow(/externo a MALAHOR_HOME/i);

    const real = path.join(scratch, "external-real");
    const linked = path.join(scratch, "external-linked");
    fs.mkdirSync(real);
    fs.symlinkSync(real, linked, "dir");
    expect(() => resolveDocsProject(paths, {}, "demo", linked)).toThrow(/symlink/i);

    const otherRepo = path.join(scratch, "other-repo");
    const shared = path.join(scratch, "shared-docs");
    fs.mkdirSync(otherRepo);
    writeProjects({
      demo: registeredProject({ docs: { path: shared } }),
      other: {
        context: "memory",
        roots: [otherRepo],
        defaultRoot: otherRepo,
        docs: { path: path.join(shared, "nested") },
      },
    });
    expect(() => resolveDocsProject(paths, {}, "demo")).toThrow(/solapan/i);
  });

  test("rechaza tambien el vault default si MALAHOR_HOME queda dentro del repositorio", () => {
    const nestedPaths = resolvePaths({
      HOME: path.join(scratch, "user"),
      MALAHOR_HOME: path.join(repo, ".malahor"),
      MALAHOR_OPENCODE_DIR: path.join(scratch, "opencode-nested"),
      MALAHOR_OPENCODE_DETECT: "0",
    }, repo);
    fs.mkdirSync(path.dirname(nestedPaths.projectsFile), { recursive: true });
    fs.writeFileSync(nestedPaths.projectsFile, JSON.stringify({ demo: registeredProject() }));

    expect(() => resolveDocsProject(nestedPaths, {}, "demo")).toThrow(/fuera de repositorios/i);
  });

  test("init crea solo faltantes, es idempotente y nunca sobrescribe contenido existente", () => {
    const template = path.join(scratch, "template");
    fs.mkdirSync(path.join(template, "templates"), { recursive: true });
    fs.writeFileSync(path.join(template, "README.md"), "---\ntype: vault\n---\n\n# Vault\n");
    fs.writeFileSync(path.join(template, "templates", "note.md"), "---\ntype: template\n---\n\n# Note\n");
    const resolution = resolveDocsProject(paths, {}, "demo");

    const first = initializeDocsProject(resolution, template, false);
    expect(first.created.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(resolution.projectRoot, "README.md"))).toBe(true);
    for (const area of ["Product", "Design", "SDD", "Discovery"]) {
      expect(fs.statSync(path.join(resolution.projectRoot, area)).isDirectory()).toBe(true);
    }

    const projectReadme = path.join(resolution.projectRoot, "README.md");
    const vaultReadme = path.join(resolution.vaultRoot, "README.md");
    fs.writeFileSync(projectReadme, "contenido humano conservado\n", "utf8");
    fs.writeFileSync(vaultReadme, "indice humano conservado\n", "utf8");
    const second = initializeDocsProject({ ...resolution, initialized: true }, template, false);

    expect(second.created).toEqual([]);
    expect(second.kept).toContain(projectReadme);
    expect(fs.readFileSync(projectReadme, "utf8")).toBe("contenido humano conservado\n");
    expect(fs.readFileSync(vaultReadme, "utf8")).toBe("indice humano conservado\n");
  });

  test("check informa UTF-8, tamano, symlinks, colisiones y enlaces no portables o rotos", () => {
    const resolution = resolveDocsProject(paths, {}, "demo");
    initializeDocsProject(resolution, undefined, false);
    const root = resolution.projectRoot;
    fs.writeFileSync(path.join(root, "valid.md"), "---\ntype: note\n---\n\n# Valida\n", "utf8");
    fs.writeFileSync(path.join(root, "links.md"), [
      "---", "type: links", "---", "",
      "[valido](valid.md)",
      "[roto](missing.md)",
      "[escape](../../outside.md)",
      "[absoluto](/tmp/outside.md)",
      "[windows](C:\\vault\\outside.md)",
      "[file](file:///tmp/outside.md)",
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(root, "plain.md"), "# Sin frontmatter\n", "utf8");
    fs.writeFileSync(path.join(root, "invalid.md"), Buffer.from([0xc3, 0x28]));
    fs.writeFileSync(path.join(root, "large.md"), Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 0x61));
    fs.writeFileSync(path.join(root, "Case.md"), "---\ntype: note\n---\n");
    fs.writeFileSync(path.join(root, "case.md"), "---\ntype: note\n---\n");
    fs.symlinkSync(path.join(root, "valid.md"), path.join(root, "linked.md"));

    const issues = checkDocsProject({ ...resolution, initialized: true });
    const codes = new Set(issues.map((issue) => issue.code));
    for (const code of [
      "utf8", "size", "symlink", "case-collision", "frontmatter",
      "broken-link", "link-escape", "absolute-link",
    ]) {
      expect(codes.has(code)).toBe(true);
    }
    expect(issues.some((issue) => issue.path === "links.md" && issue.code === "broken-link")).toBe(true);
  });
});

describe("cliente humano documental", () => {
  test("planifica el launcher system por plataforma sin ejecutar procesos", () => {
    const resolution = directResolution();
    for (const [platform, command] of [
      ["linux", "xdg-open"],
      ["darwin", "open"],
      ["win32", "explorer.exe"],
    ] as const) {
      const result = planDocsOpen(resolution, {
        app: "system",
        dryRun: true,
        platform,
        env: {},
        run: () => { throw new Error("el dry-run no debe ejecutar procesos"); },
      });
      expect(result).toMatchObject({ requestedClient: "system", client: "system", command, dryRun: true });
      expect(result.args).toEqual([resolution.projectRoot]);
    }
  });

  test("convierte rutas Windows a WSL y de WSL a Windows mediante el runner inyectado", () => {
    const calls: Array<{ command: string; args: readonly string[]; capture: boolean }> = [];
    const run = (command: string, args: readonly string[], capture: boolean): string => {
      calls.push({ command, args, capture });
      if (args[0] === "-u") return "/mnt/c/Users/Felipe/Malahor Docs";
      if (args[0] === "-w") return "C:\\Users\\Felipe\\Malahor Docs";
      throw new Error("conversion inesperada");
    };
    const host = { platform: "linux" as const, env: { WSL_DISTRO_NAME: "Ubuntu" }, run };

    expect(normalizeDocsRootInput("C:\\Users\\Felipe\\Malahor Docs", host))
      .toBe("/mnt/c/Users/Felipe/Malahor Docs");
    expect(windowsPathForClient("/mnt/c/Users/Felipe/Malahor Docs", host))
      .toBe("C:\\Users\\Felipe\\Malahor Docs");
    expect(calls).toEqual([
      { command: "wslpath", args: ["-u", "C:\\Users\\Felipe\\Malahor Docs"], capture: true },
      { command: "wslpath", args: ["-w", "/mnt/c/Users/Felipe/Malahor Docs"], capture: true },
    ]);

    expect(normalizeDocsRootInput("C:\\Users\\Felipe\\Malahor Docs", {
      platform: "win32",
      env: {},
      run: () => { throw new Error("Windows no necesita wslpath"); },
    })).toBe("C:\\Users\\Felipe\\Malahor Docs");
  });

  test("VSCode en WSL intenta code y code.exe, y degrada a system si el cliente no esta disponible", () => {
    const resolution = directResolution();
    const launched: string[] = [];
    const wsl = openDocsClient(resolution, {
      app: "vscode",
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      run: (command, _args, capture) => {
        if (capture) return "C:\\Malahor\\demo";
        launched.push(command);
        if (command === "code") throw new Error("code no disponible");
        return "";
      },
    });
    expect(launched).toEqual(["code", "code.exe"]);
    expect(wsl).toMatchObject({ requestedClient: "vscode", client: "vscode", command: "code.exe" });
    expect(wsl.args).toEqual(["C:\\Malahor\\demo"]);

    const fallbackLaunches: string[] = [];
    const fallback = openDocsClient(resolution, {
      app: "vscode",
      platform: "linux",
      env: {},
      run: (command) => {
        fallbackLaunches.push(command);
        if (command === "code") throw new Error("code no disponible");
        return "";
      },
    });
    expect(fallbackLaunches).toEqual(["code", "xdg-open"]);
    expect(fallback).toMatchObject({
      requestedClient: "vscode",
      client: "system",
      command: "xdg-open",
      fallback: { from: "vscode" },
    });
  });

  test("construye URI de Obsidian y rechaza paths absolutos o traversal antes de lanzar", () => {
    const resolution = directResolution();
    fs.mkdirSync(path.join(resolution.projectRoot, "Product"), { recursive: true });
    const note = path.join(resolution.projectRoot, "Product", "nota uno.md");
    fs.writeFileSync(note, "# Nota\n", "utf8");

    const planned = planDocsOpen(resolution, {
      path: "Product/nota uno.md",
      app: "obsidian",
      platform: "linux",
      env: {},
      dryRun: true,
      run: () => { throw new Error("el dry-run no debe ejecutar procesos"); },
    });
    expect(planned.command).toBe("xdg-open");
    expect(planned.args).toEqual([`obsidian://open?path=${encodeURIComponent(note)}`]);

    for (const unsafe of ["../nota.md", "Product/../../nota.md", "/tmp/nota.md", "C:/vault/nota.md", "C:\\vault\\nota.md"]) {
      expect(() => planDocsOpen(resolution, {
        path: unsafe,
        app: "system",
        platform: "linux",
        env: {},
        dryRun: true,
        run: () => { throw new Error("no debe ejecutarse"); },
      })).toThrow();
    }
  });
});

describe("store Markdown confinado y versionado", () => {
  test("crea, lee, lista, busca, sobrescribe, anexa y mueve con SHA-256", () => {
    const resolution = directResolution();
    const created = writeDoc(resolution, "Product/plan.md", "alpha alpha\n", { ifNoneMatch: "*" });
    expect(created.version).toBe(versionOf("alpha alpha\n"));
    expect(created.size).toBe(Buffer.byteLength("alpha alpha\n"));
    expect(readDoc(resolution, "Product/plan.md")).toEqual(created);
    expect(listDocs(resolution, "Product")).toEqual([{ path: "Product/plan.md", type: "file" }]);
    expect(searchDocs(resolution, "ALPHA", 10)).toEqual([
      { path: "Product/plan.md", matches: 2, preview: "alpha alpha" },
    ]);

    const replaced = writeDoc(resolution, "Product/plan.md", "beta\n", { ifMatch: created.version });
    const appended = appendDoc(resolution, "Product/plan.md", "gamma\n", { ifMatch: replaced.version });
    expect(appended.content).toBe("beta\ngamma\n");

    const moved = moveDoc(resolution, "Product/plan.md", "SDD/plan.md", appended.version);
    expect(moved.path).toBe("SDD/plan.md");
    expect(moved.version).toBe(appended.version);
    expect(fs.existsSync(path.join(resolution.projectRoot, "Product", "plan.md"))).toBe(false);
    expect(readDoc(resolution, "SDD/plan.md").content).toBe("beta\ngamma\n");
  });

  test("rechaza traversal, rutas absolutas, separadores Windows y nombres reservados", () => {
    const resolution = directResolution();
    for (const unsafe of [
      "../outside.md",
      "Product/../../outside.md",
      "/tmp/outside.md",
      "C:/vault/outside.md",
      "C:\\vault\\outside.md",
      "//server/share/outside.md",
      "Product//note.md",
      "Product/note.md/",
      "CON.md",
      "Product/trailing.md ",
    ]) {
      expect(() => writeDoc(resolution, unsafe, "fixture", { ifNoneMatch: "*" })).toThrow();
    }
    expect(fs.readdirSync(resolution.projectRoot)).toEqual([]);
  });

  test("rechaza colisiones de mayusculas, symlinks y archivos que no sean Markdown regular", () => {
    const resolution = directResolution();
    writeDoc(resolution, "Notes/A.md", "a", { ifNoneMatch: "*" });
    expect(() => writeDoc(resolution, "notes/B.md", "b", { ifNoneMatch: "*" })).toThrow(/colisiona/i);

    const outside = path.join(scratch, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.md"), "outside", "utf8");
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(resolution.projectRoot, "linked.md"));
    fs.symlinkSync(outside, path.join(resolution.projectRoot, "linked-dir"), "dir");

    expect(() => readDoc(resolution, "linked.md")).toThrow(/symlink/i);
    expect(() => writeDoc(resolution, "linked-dir/new.md", "no", { ifNoneMatch: "*" })).toThrow(/symlink/i);
    expect(() => listDocs(resolution)).toThrow(/symlink/i);
    expect(fs.readFileSync(path.join(outside, "secret.md"), "utf8")).toBe("outside");
  });

  test("aplica limites UTF-8 y 2 MiB tanto al leer como al escribir", () => {
    const resolution = directResolution();
    fs.writeFileSync(path.join(resolution.projectRoot, "invalid.md"), Buffer.from([0xc3, 0x28]));
    fs.writeFileSync(path.join(resolution.projectRoot, "large.md"), Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 0x61));

    expect(() => readDoc(resolution, "invalid.md")).toThrow(/UTF-8/i);
    expect(() => readDoc(resolution, "large.md")).toThrow(/excede/i);
    expect(() => writeDoc(resolution, "too-large.md", "x".repeat(MAX_MARKDOWN_BYTES + 1), { ifNoneMatch: "*" }))
      .toThrow(/excede/i);
    expect(fs.existsSync(path.join(resolution.projectRoot, "too-large.md"))).toBe(false);
  });

  test("hace observables las carreras mediante create-only e ifMatch sin dejar temporales", () => {
    const resolution = directResolution();
    const initial = writeDoc(resolution, "race.md", "v1", { ifNoneMatch: "*" });
    const readerA = readDoc(resolution, "race.md");
    const readerB = readDoc(resolution, "race.md");
    expect(readerA.version).toBe(initial.version);
    expect(readerB.version).toBe(initial.version);

    const winner = writeDoc(resolution, "race.md", "winner", { ifMatch: readerA.version });
    expect(() => writeDoc(resolution, "race.md", "stale", { ifMatch: readerB.version })).toThrow(/Version conflict/i);
    expect(() => appendDoc(resolution, "race.md", "stale append", { ifMatch: readerB.version })).toThrow(/Version conflict/i);
    expect(readDoc(resolution, "race.md")).toEqual(winner);

    writeDoc(resolution, "create-race.md", "first", { ifNoneMatch: "*" });
    expect(() => writeDoc(resolution, "create-race.md", "second", { ifNoneMatch: "*" })).toThrow();
    expect(readDoc(resolution, "create-race.md").content).toBe("first");
    expect(fs.readdirSync(resolution.projectRoot).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("move nunca sobrescribe un destino y conserva el origen ante conflicto", () => {
    const resolution = directResolution();
    const source = writeDoc(resolution, "source.md", "source", { ifNoneMatch: "*" });
    writeDoc(resolution, "destination.md", "destination", { ifNoneMatch: "*" });

    expect(() => moveDoc(resolution, "source.md", "destination.md", source.version)).toThrow(/destino ya existe/i);
    expect(readDoc(resolution, "source.md").content).toBe("source");
    expect(readDoc(resolution, "destination.md").content).toBe("destination");
    expect(() => moveDoc(resolution, "source.md", "SOURCE.md", source.version)).toThrow(/mayusculas/i);
  });
});
