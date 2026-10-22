import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  loadProjectsFile,
  registerProjectRoot,
  resolveRegisteredProject,
  resolveContextTarget,
  rootsForProject,
  saveProjectContext,
} from "../src/cli/core/context";
import { resolvePaths } from "../src/cli/core/paths";

function fixture(): { root: string; projects: string; paths: ReturnType<typeof resolvePaths> } {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-context-roots-"));
  const projects = path.join(root, "home", "projects.json");
  const paths = resolvePaths({
    ...process.env,
    MALAHOR_HOME: path.join(root, "home"),
    MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  }, root);
  return { root, projects, paths };
}

describe("raíces registradas por proyecto", () => {
  test("mantiene formato legacy y agrega roots/defaultRoot fuera del repo", () => {
    const { projects, paths } = fixture();
    fs.mkdirSync(path.dirname(projects), { recursive: true });
    fs.writeFileSync(projects, JSON.stringify({ demo: { context: "mnemo" } }), "utf8");

    registerProjectRoot(projects, "demo", paths.cwd, false);
    saveProjectContext(projects, "demo", "mnemo+graphify+obsidian", false, paths.cwd);

    const loaded = loadProjectsFile(projects);
    expect(loaded.demo.context).toBe("mnemo+graphify+obsidian");
    expect(loaded.demo.roots).toEqual([paths.cwd]);
    expect(loaded.demo.defaultRoot).toBe(paths.cwd);
    expect(rootsForProject(projects, "demo")).toEqual([paths.cwd]);
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
