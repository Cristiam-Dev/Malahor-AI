import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PROJECT_AFFINITY_MARKER,
  createProjectAffinityResolver,
  projectAffinityKey,
  type ProjectAffinityStorage,
} from "../src/plugin/project-affinity";

const SESSION = "ses_affinity_fixture";

let root: string;
let home: string;
let hostDirectory: string;
let demo: string;
let other: string;
let env: NodeJS.ProcessEnv;
let records: Map<string, unknown>;
let storage: ProjectAffinityStorage;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-project-affinity-"));
  home = path.join(root, "malahor-home");
  hostDirectory = path.join(root, "user-home");
  demo = path.join(root, "demo");
  other = path.join(root, "other");
  for (const directory of [home, hostDirectory, demo, other]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(demo, "package.json"), JSON.stringify({ name: "demo" }));
  fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "other" }));
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({
    demo: { context: "memory", roots: [demo], defaultRoot: demo },
    other: { context: "memory", roots: [other], defaultRoot: other },
  }));
  fs.writeFileSync(path.join(home, "config.jsonc"), JSON.stringify({
    projects: { aliases: { demo: ["Producto Demo"] } },
  }));
  env = {
    HOME: hostDirectory,
    MALAHOR_HOME: home,
    MALAHOR_CONFIG: path.join(home, "config.jsonc"),
    MALAHOR_OPENCODE_DETECT: "0",
  };
  records = new Map();
  storage = {
    get: async (key) => records.get(key),
    set: async (key, value) => { records.set(key, value); },
  };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function resolver(overrides: Partial<Parameters<typeof createProjectAffinityResolver>[0]> = {}) {
  return createProjectAffinityResolver({
    cwd: hostDirectory,
    env,
    storage,
    resolveSessionHints: async () => ({ directory: hostDirectory }),
    ...overrides,
  });
}

describe("afinidad persistente sesion-proyecto", () => {
  test("resuelve un alias explicito sin depender del directorio del host y persiste solo la clave", async () => {
    const affinity = resolver();
    const project = await affinity.observePrompt({
      sessionID: SESSION,
      prompt: { text: "Proyecto: Producto Demo" },
    });

    expect(project).toEqual({ canonicalKey: "demo", root: demo });
    const record = records.get(projectAffinityKey(SESSION)) as Record<string, unknown>;
    expect(record.canonicalKey).toBe("demo");
    expect(JSON.stringify(record)).not.toContain(demo);
    expect(await resolver().resolveSessionProject(SESSION)).toEqual(project);
  });

  test("una ruta seleccionada identifica el proyecto aunque OpenCode este abierto en home", async () => {
    const project = await resolver().observePrompt({
      sessionID: SESSION,
      prompt: { text: "continua", files: [{ path: path.join(other, "src", "file.ts") }] },
    });

    expect(project).toEqual({ canonicalKey: "other", root: other });
  });

  test("una URI file codificada identifica el proyecto sin cortar su ruta", async () => {
    const file = path.join(other, "src con espacios", "file.ts");
    const uri = pathToFileURL(file).href;
    const project = await resolver().observePrompt({
      sessionID: SESSION,
      prompt: { text: "continua", files: [{ uri }] },
    });

    expect(uri).toContain("%20");
    expect(project).toEqual({ canonicalKey: "other", root: other });
  });

  test("varias candidatas piden aclaracion una vez y la respuesta fija la afinidad", async () => {
    const affinity = resolver();
    expect(await affinity.observePrompt({ sessionID: SESSION, prompt: { text: "continua" } })).toBeUndefined();

    const first: Record<string, unknown> = { sessionID: SESSION, system: [{ type: "text", text: "base" }] };
    expect(await affinity.injectContext(first)).toBe(true);
    expect(JSON.stringify(first.system)).toContain(PROJECT_AFFINITY_MARKER);
    expect(JSON.stringify(first.system)).toMatch(/Pregunta UNA sola vez/);

    const second: Record<string, unknown> = { sessionID: SESSION, system: [] };
    await affinity.injectContext(second);
    expect(JSON.stringify(second.system)).toMatch(/no repitas/);

    const selected = await affinity.observePrompt({ sessionID: SESSION, prompt: { text: "demo" } });
    expect(selected).toEqual({ canonicalKey: "demo", root: demo });
    expect(await affinity.resolveSessionProject(SESSION)).toEqual(selected);
  });

  test("una señal incompatible bloquea y solo una orden explicita cambia la sesion", async () => {
    const affinity = resolver();
    await affinity.observePrompt({ sessionID: SESSION, prompt: { text: "demo" } });

    expect(await affinity.observePrompt({
      sessionID: SESSION,
      prompt: { text: "trabaja ahora con other" },
    })).toBeUndefined();
    expect(await affinity.resolveSessionProject(SESSION)).toBeUndefined();

    const switched = await affinity.observePrompt({
      sessionID: SESSION,
      prompt: { text: "cambia esta sesion a other" },
    });
    expect(switched).toEqual({ canonicalKey: "other", root: other });
  });

  test("relee la raiz registrada y no conserva una ruta obsoleta", async () => {
    const affinity = resolver();
    await affinity.observePrompt({ sessionID: SESSION, prompt: { text: "demo" } });
    const moved = path.join(root, "demo-moved");
    fs.mkdirSync(moved);
    fs.writeFileSync(path.join(moved, "package.json"), JSON.stringify({ name: "demo" }));
    fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({
      demo: { context: "memory", roots: [moved], defaultRoot: moved },
      other: { context: "memory", roots: [other], defaultRoot: other },
    }));

    expect(await affinity.resolveSessionProject(SESSION)).toEqual({ canonicalKey: "demo", root: moved });
  });

  test("un plan vigente es señal anterior al location.directory", async () => {
    const project = await resolver({ resolvePlanProject: async () => "other" }).resolveSessionProject(SESSION);
    expect(project).toEqual({ canonicalKey: "other", root: other });
  });
});
