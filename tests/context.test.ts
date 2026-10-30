import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  levelForProject,
  loadProjectsFile,
  obsidianEnabled,
  parseContextLevel,
  registerProjectRoot,
  resolveRegisteredProject,
  resolveContextTarget,
  rootsForProject,
} from "../src/cli/core/context";
import { runContext } from "../src/cli/commands/context";
import { resolvePaths } from "../src/cli/core/paths";
import { MALAHOR_RUNTIME_PROTOCOL } from "../src/plugin/protocol";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; projects: string; paths: ReturnType<typeof resolvePaths> } {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-context-roots-"));
  fixtureRoots.push(root);
  const projects = path.join(root, "home", "projects.json");
  const paths = resolvePaths({
    HOME: path.join(root, "user"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    MALAHOR_HOME: path.join(root, "home"),
    MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  }, root);
  return { root, projects, paths };
}

function captureContextStatus(paths: ReturnType<typeof resolvePaths>): string {
  const overrides = {
    HOME: paths.home,
    XDG_CONFIG_HOME: path.join(path.dirname(paths.home), "config"),
    MALAHOR_HOME: paths.malahorHome,
    MALAHOR_OPENCODE_DIR: paths.opencodeDir,
    MALAHOR_OPENCODE_DETECT: "0",
    MALAHOR_CONFIG: paths.configFile,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const originalWrite = process.stdout.write;
  let output = "";
  try {
    Object.assign(process.env, overrides);
    process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
    runContext({ action: "status", args: [], dryRun: false, limit: undefined, project: "demo" });
    return output;
  } finally {
    process.stdout.write = originalWrite;
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

describe("raíces registradas por proyecto", () => {
  test("mantiene el formato persistido heredado al registrar una raiz", () => {
    const { projects, paths } = fixture();
    fs.mkdirSync(path.dirname(projects), { recursive: true });
    fs.writeFileSync(projects, JSON.stringify({ demo: { context: "mnemo+graphify+obsidian" } }), "utf8");

    registerProjectRoot(projects, "demo", paths.cwd, false);

    const loaded = loadProjectsFile(projects);
    expect(loaded.demo.context).toBe("mnemo+graphify+obsidian");
    expect(levelForProject(projects, "demo")).toBe("mnemo+graphify+obsidian");
    expect(loaded.demo.roots).toEqual([paths.cwd]);
    expect(loaded.demo.defaultRoot).toBe(paths.cwd);
    expect(rootsForProject(projects, "demo")).toEqual([paths.cwd]);
  });

  test("los proyectos nuevos usan memory+codegraph sin persistir tokens del proveedor retirado", () => {
    const { projects, paths } = fixture();

    registerProjectRoot(projects, "demo", paths.cwd, false);

    const raw = fs.readFileSync(projects, "utf8");
    expect(loadProjectsFile(projects).demo.context).toBe("memory+codegraph");
    expect(levelForProject(projects, "unregistered")).toBe("memory+codegraph");
    expect(raw).not.toMatch(/graphify/i);
  });

  test("acepta solo los tres niveles nuevos y conserva legibles los tres heredados", () => {
    for (const level of ["memory", "memory+codegraph", "memory+codegraph+obsidian",
      "mnemo", "mnemo+graphify", "mnemo+graphify+obsidian"]) {
      expect(parseContextLevel(level)).toBe(level);
    }
    expect(() => parseContextLevel("memory+graphify")).toThrow(/invalido/i);
    expect(obsidianEnabled(parseContextLevel("memory+codegraph+obsidian"))).toBe(true);
    expect(obsidianEnabled(parseContextLevel("mnemo+graphify+obsidian"))).toBe(true);
    expect(obsidianEnabled(parseContextLevel("mnemo+graphify"))).toBe(false);
  });

  test("registrar una raiz no migra niveles heredados ni altera otros proyectos", () => {
    const { projects, paths } = fixture();
    fs.mkdirSync(path.dirname(projects), { recursive: true });
    const legacy = {
      memoryOnly: { context: "mnemo" },
      codePending: { context: "mnemo+graphify" },
      docsPending: { context: "mnemo+graphify+obsidian" },
    };
    fs.writeFileSync(projects, JSON.stringify(legacy), "utf8");

    registerProjectRoot(projects, "codePending", paths.cwd, false);

    const persisted = JSON.parse(fs.readFileSync(projects, "utf8"));
    expect(persisted.memoryOnly).toEqual(legacy.memoryOnly);
    expect(persisted.docsPending).toEqual(legacy.docsPending);
    expect(persisted.codePending.context).toBe("mnemo+graphify");
    expect(persisted.codePending.roots).toEqual([paths.cwd]);
    expect(fs.existsSync(path.join(paths.malahorHome, "codegraph"))).toBe(false);
  });

  test("status declara CodeGraph degradado sin indice para niveles nuevos, sin crear ni migrar proyectos", () => {
    const { projects, paths } = fixture();
    fs.mkdirSync(path.dirname(projects), { recursive: true });
    for (const level of ["memory+codegraph", "memory+codegraph+obsidian"] as const) {
      const raw = JSON.stringify({ demo: { context: level, roots: [paths.cwd], defaultRoot: paths.cwd } });
      fs.writeFileSync(projects, raw, "utf8");

      const output = captureContextStatus(paths);

      expect(output).toContain(`- Context level: ${level}`);
      expect(output).toMatch(/- Code context: .*degrad|\bCodeGraph: .*degrad/i);
      expect(output).toMatch(/(?:index|[ií]ndice|codegraph)/i);
      expect(output).toContain(`- Obsidian: ${level.endsWith("+obsidian") ? "enabled" : "disabled"}`);
      expect(fs.readFileSync(projects, "utf8")).toBe(raw);
      expect(fs.existsSync(path.join(paths.malahorHome, "codegraph"))).toBe(false);
    }
  });

  test("status distingue los tres niveles legacy: codigo inactivo, transicion visible y Obsidian preservado", () => {
    const { projects, paths } = fixture();
    fs.mkdirSync(path.dirname(projects), { recursive: true });
    for (const level of ["mnemo", "mnemo+graphify", "mnemo+graphify+obsidian"] as const) {
      const raw = JSON.stringify({ demo: { context: level, roots: [paths.cwd], defaultRoot: paths.cwd } });
      fs.writeFileSync(projects, raw, "utf8");

      const output = captureContextStatus(paths);

      expect(output).toMatch(/(?:legacy|transici[oó]n|migraci[oó]n)/i);
      expect(output).toContain("- Code context: disabled");
      expect(output).toContain(`- Obsidian: ${level.endsWith("+obsidian") ? "enabled" : "disabled"}`);
      expect(fs.readFileSync(projects, "utf8")).toBe(raw);
      expect(fs.existsSync(path.join(paths.malahorHome, "codegraph"))).toBe(false);
    }
  });

  test("el protocolo recupera proyecto, memoria, CodeGraph gestionado, Obsidian y lecturas dirigidas en ese orden", () => {
    const order = MALAHOR_RUNTIME_PROTOCOL.split("\n").find((line) => /ordena el contexto/i.test(line));
    expect(order).toBeDefined();
    expect(order).toMatch(/proyecto.*mem_\*.*codegraph.*obsidian.*lecturas (?:dirigidas|puntuales)/i);
    expect(order).toMatch(/codegraph.*(?:habilitad|gestionad)/i);
    expect(order).toMatch(/obsidian.*habilitad/i);
  });

  test("resuelve la raíz registrada al trabajar desde otra ubicación", () => {
    const { projects, paths } = fixture();
    registerProjectRoot(projects, "malahor", paths.cwd, false);

    const target = resolveContextTarget(paths, {}, "malahor-ai");
    expect(target.canonicalKey).toBe("malahor");
    expect(target.root).toBe(paths.cwd);
    expect(target.registeredRoots).toEqual([paths.cwd]);
  });

  test("resuelve el proyecto explícito y su defaultRoot desde cualquier cwd", () => {
    const { projects, paths } = fixture();
    const frontend = path.join(paths.cwd, "Flowin-Frontend");
    const backend = path.join(paths.cwd, "Flowin-Backend");
    registerProjectRoot(projects, "flowin", frontend, false);
    registerProjectRoot(projects, "flowin", backend, false);

    const resolved = resolveRegisteredProject({ ...paths, projectsFile: projects }, {}, { override: "flowin" });

    expect(resolved.canonicalKey).toBe("flowin");
    expect(resolved.root).toBe(backend);
  });

  test("usa el proyecto explícito aunque el target quede fuera de su raíz", () => {
    const { projects, paths } = fixture();
    const repo = path.join(paths.cwd, "repo");
    registerProjectRoot(projects, "malahor", repo, false);

    const resolved = resolveRegisteredProject({ ...paths, projectsFile: projects }, {}, {
      override: "malahor",
      targetPaths: [path.join(paths.cwd, ".config", "opencode", "opencode.jsonc")],
    });

    expect(resolved.canonicalKey).toBe("malahor");
    expect(resolved.root).toBe(repo);
  });

  test("infiere el proyecto por targetPaths cuando el cwd no pertenece al repo", () => {
    const { projects, paths } = fixture();
    const repo = path.join(paths.cwd, "repo");
    registerProjectRoot(projects, "flowin", repo, false);

    const resolved = resolveRegisteredProject({ ...paths, projectsFile: projects, cwd: path.join(paths.cwd, "outside") }, {}, {
      targetPaths: [path.join(repo, "src", "index.ts")],
    });

    expect(resolved.canonicalKey).toBe("flowin");
    expect(resolved.root).toBe(repo);
  });

  test("resuelve un scope jerárquico por su proyecto raíz", () => {
    const { projects, paths } = fixture();
    const repo = path.join(paths.cwd, "repo");
    registerProjectRoot(projects, "flowin", repo, false);

    const resolved = resolveRegisteredProject({ ...paths, projectsFile: projects }, {}, {
      projectHint: "flowin/backend/auth",
    });

    expect(resolved.canonicalKey).toBe("flowin");
    expect(resolved.root).toBe(repo);
  });
});
