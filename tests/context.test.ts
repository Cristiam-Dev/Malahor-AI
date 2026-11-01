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

  test("acepta niveles vigentes/legacy, pero ningun sufijo habilita Obsidian gestionado", () => {
    for (const level of ["memory", "memory+codegraph", "memory+codegraph+obsidian",
      "mnemo", "mnemo+graphify", "mnemo+graphify+obsidian"]) {
      expect(parseContextLevel(level)).toBe(level);
    }
    expect(() => parseContextLevel("memory+graphify")).toThrow(/invalido/i);
    expect(obsidianEnabled(parseContextLevel("memory+codegraph+obsidian"))).toBe(false);
    expect(obsidianEnabled(parseContextLevel("mnemo+graphify+obsidian"))).toBe(false);
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
      expect(output).toContain("- Documentation:");
      expect(output).toContain("- Obsidian: optional human client; not a managed context provider or storage backend");
      expect(fs.readFileSync(projects, "utf8")).toBe(raw);
      expect(fs.existsSync(path.join(paths.malahorHome, "codegraph"))).toBe(false);
    }
  });

  test("status distingue los tres niveles legacy sin reactivar Obsidian como proveedor", () => {
    const { projects, paths } = fixture();
    fs.mkdirSync(path.dirname(projects), { recursive: true });
    for (const level of ["mnemo", "mnemo+graphify", "mnemo+graphify+obsidian"] as const) {
      const raw = JSON.stringify({ demo: { context: level, roots: [paths.cwd], defaultRoot: paths.cwd } });
      fs.writeFileSync(projects, raw, "utf8");

      const output = captureContextStatus(paths);

      expect(output).toMatch(/(?:legacy|transici[oó]n|migraci[oó]n)/i);
      expect(output).toContain("- Code context: disabled");
      expect(output).toContain("- Documentation:");
      expect(output).toContain("- Obsidian: optional human client; not a managed context provider or storage backend");
      expect(fs.readFileSync(projects, "utf8")).toBe(raw);
      expect(fs.existsSync(path.join(paths.malahorHome, "codegraph"))).toBe(false);
    }
  });

  test("el protocolo recupera proyecto, memoria, CodeGraph gestionado, docs y lecturas dirigidas en ese orden", () => {
    const order = MALAHOR_RUNTIME_PROTOCOL.split("\n").find((line) => /ordena el contexto/i.test(line));
    expect(order).toBeDefined();
    expect(order).toMatch(/proyecto.*mem_\*.*codegraph.*docs_\*.*lecturas (?:dirigidas|puntuales)/i);
    expect(order).toMatch(/codegraph.*(?:habilitad|gestionad)/i);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/Obsidian.*clientes? humanos?.*no (?:son|es) storage/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/exclusivamente mediante docs_\*.*nunca mediante filesystem, Obsidian MCP ni fallback al repositorio/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/fachada documental natural.*no exige al usuario claves, rutas internas, versiones SHA ni nombres de tools/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/No existe borrado documental permanente.*mover a un [aá]rea de archivo/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/docs_open.*cliente global o system/is);
  });

  test("el protocolo mantiene planes sin TTL y dependencias sin autoarranque", () => {
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/no caduca por tiempo/i);
    expect(MALAHOR_RUNTIME_PROTOCOL).toContain("malahor_plan_control");
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/dependencia.*no hereda permisos.*nunca inicia autom[aá]ticamente/is);
  });

  test("la proporcionalidad read-only y de commit es una regla estructural", () => {
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/inspecci[oó]n.*read-only.*sin plan.*sin.*go/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/lectura.*equivalente.*no.*revisi[oó]n.*plan/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/commit expl[ií]cito.*[uú]nico plan.*nivel 0.*[uú]nico.*go/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/solo.*cambio material.*efectos.*recursos.*riesgo.*revisi[oó]n/is);
  });

  test("el protocolo hace estructural la frontera de infraestructura", () => {
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/CI\/CD, IaC, publicaci[oó]n y despliegue.*solo lectura por defecto/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/aprobaci[oó]n de plan, implementaci[oó]n, stage o commit no autoriza/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/ASK humano separado.*vinculado a operaci[oó]n, proyecto, recursos o comando y policy hash/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/preflight de solo lectura.*diferido.*no consume ni sustituye el ASK nativo/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/Sin esa aprobaci[oó]n verificable.*leer, analizar y proponer/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/Git es local-only.*push, pull, fetch, clone/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/hard DENY.*ningún plan, perfil, token, aprobación, metadata o fallback/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/intención estructurada commit.*stage exacto revisado y el commit ordinario/is);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/precommit quedó verde.*commit-fallback/is);
  });

  test("el protocolo define el rollout local explicito para actualizar una instalacion existente", () => {
    const marker = MALAHOR_RUNTIME_PROTOCOL.search(/rollout local|actualizaci[oó]n local/i);
    const rollout = marker < 0 ? "" : MALAHOR_RUNTIME_PROTOCOL.slice(marker, marker + 2_400);
    const lines = rollout.split("\n");

    expect(rollout).not.toBe("");
    expect(rollout).toMatch(/(?:gates?|diagn[oó]stico|testing|pruebas)[\s\S]{0,400}\bbuild\b/i);
    expect(rollout).toMatch(/\b(?:sandbox|dry-run)\b/i);
    expect(rollout).toMatch(/\b(?:guardrails?|hooks?)\b/i);
    expect(rollout).toMatch(/(?:\bupdate(?:\s+--yes)?\s+real\b|actualizaci[oó]n real)[\s\S]{0,300}\bdoctor\b/i);
    expect(lines.some((line) => /instalaci[oó]n existente/i.test(line) && /\bupdate\b/i.test(line))).toBe(true);
    expect(lines.some((line) => /\binstall\b/i.test(line) && /(?:solo|[uú]nicamente|reservad)/i.test(line)
      && /(?:bootstrap|ausencia)/i.test(line))).toBe(true);
    expect(rollout).toMatch(/(?:det[eé]n(?:te|gase|erse)?|detien|interrump|aborta)[\s\S]{0,500}\bASK\b[\s\S]{0,80}\bDENY\b/i);
    expect(rollout).toMatch(/(?:det[eé]n(?:te|gase|erse)?|detien|interrump|aborta)[\s\S]{0,500}(?:dependencias nuevas|nuevas dependencias)/i);
    expect(rollout).toMatch(/(?:det[eé]n(?:te|gase|erse)?|detien|interrump|aborta)[\s\S]{0,500}(?:efectos distintos|cambian? (?:los )?efectos)/i);
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
