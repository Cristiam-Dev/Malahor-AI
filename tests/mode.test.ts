import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../src/cli/core/config";
import { assertModeWriteAllowed } from "../src/cli/core/mode-hooks";
import { applyModeChange, MODE_CHANGE_ACTION, modeName, parseModeName, previewModeChange } from "../src/cli/core/mode";
import { authorizePlan, planAllows, proposePlan, reviewPlan, type PlanScope } from "../src/cli/core/planning";
import { registerModeCommand, type ModeCommandHost } from "../src/plugin/mode-command";

const SESSION = "ses_mode_fixture";
const INITIAL_REVISION = "1".repeat(32);

type Invocation = {
  sessionID: string;
  prompt: { text: string; files?: unknown[]; agents?: unknown[]; skills?: unknown[] };
  delivery: "steer" | "queue";
};

type PermissionRequest = {
  sessionID: string;
  action: string;
  resources: string[];
  save: string[];
};

let root: string;
let repo: string;
let home: string;
let configFile: string;
let opencodeFile: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-mode-"));
  repo = path.join(root, "project");
  home = path.join(root, "malahor-home");
  configFile = path.join(home, "config.jsonc");
  opencodeFile = path.join(root, "opencode", "opencode.jsonc");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.dirname(opencodeFile), { recursive: true });
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({
    project: { context: "memory", roots: [repo], defaultRoot: repo },
  }));
  fs.writeFileSync(configFile, `{
  // comentario que no debe desaparecer
  "mode": "advisor",
  "execution": { "intervention": "guiar", "verification": false, "revision": "${INITIAL_REVISION}" },
  "other": { "theme": "amber" }
}\n`);
  fs.writeFileSync(opencodeFile, '{"theme":"dark"}\n');
  env = {
    HOME: path.join(root, "user"),
    XDG_CONFIG_HOME: path.join(root, "user", ".config"),
    MALAHOR_HOME: home,
    MALAHOR_CONFIG: configFile,
    MALAHOR_OPENCODE_DIR: path.dirname(opencodeFile),
    MALAHOR_OPENCODE_DETECT: "0",
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function applyWithHooks(target: "acompanar" | "guiar" | "ejecutar", version: string) {
  return applyModeChange(target, version, (file, backups) =>
    assertModeWriteAllowed(file, backups, repo, env, "cli"), env, repo);
}

function policy(controls: Record<string, unknown>): void {
  const file = path.join(home, "policies", "default.jsonc");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    contractVersion: 1,
    policyVersion: "fixture-1",
    issuer: "mode-test",
    issuedAt: "2026-10-29T00:00:00.000Z",
    controls: { files: controls },
  }));
}

async function command(
  resolveSessionDirectory: (sessionID: string) => Promise<string | undefined>,
  onPermission: (request: PermissionRequest) => Promise<void> | void = () => undefined,
) {
  const messages: Array<{ sessionID: string; text: string }> = [];
  const permissions: PermissionRequest[] = [];
  let execute: (input: Invocation) => Promise<void> = async () => { throw new Error("Comando no registrado"); };
  const host: ModeCommandHost = {
    command: {
      transform: async (callback) => {
        callback({ add: (definition) => {
          expect(definition.name).toBe("malahor-modo");
          execute = definition.execute;
        } });
      },
    },
    session: { synthetic: async (input) => { messages.push(input); } },
    permission: { assert: async (input) => {
      permissions.push(input);
      await onPermission(input);
    } },
  };
  await registerModeCommand(host, { cwd: repo, env, resolveSessionDirectory });
  const invoke = (text: string, sessionID = SESSION, extras: Omit<Invocation["prompt"], "text"> = {}) =>
    execute({ sessionID, prompt: { text, ...extras }, delivery: "steer" });
  return { invoke, messages, permissions };
}

describe("modo portable: configuracion de Malahor", () => {
  test("mapea las tres intervenciones y carga una revision persistida", () => {
    expect(["asesor", "asistente", "ejecutor"].map((name) => modeName(parseModeName(name)))).toEqual([
      "asesor", "asistente", "ejecutor",
    ]);
    expect(() => parseModeName("admin")).toThrow(/invalido/);
    expect(loadConfig(env, repo).execution).toMatchObject({ intervention: "guiar", revision: INITIAL_REVISION });
    expect(loadConfig(env, repo).mode).toBe("assistant");
  });

  test("preview es de solo lectura y mantiene privada la version optimista", () => {
    const original = fs.readFileSync(configFile, "utf8");
    const opencode = fs.readFileSync(opencodeFile, "utf8");
    const preview = previewModeChange("ejecutar", env, repo);
    expect(preview).toMatchObject({ configFile, current: "asistente", target: "ejecutor" });
    expect(preview.changes.join(" ")).toContain("execution.intervention: guiar -> ejecutar");
    expect(preview.version).toMatch(/^[a-f0-9]{64}$/);
    expect(previewModeChange("ejecutar", env, repo).version).toBe(preview.version);
    expect(previewModeChange("acompanar", env, repo).version).not.toBe(preview.version);
    expect(fs.readFileSync(configFile, "utf8")).toBe(original);
    expect(fs.readFileSync(opencodeFile, "utf8")).toBe(opencode);
    expect(fs.existsSync(path.join(home, "backups"))).toBe(false);
  });

  test("set respalda, conserva JSONC y renueva revision; repetir el mismo modo no escribe", () => {
    const original = fs.readFileSync(configFile, "utf8");
    const opencode = fs.readFileSync(opencodeFile, "utf8");
    const applied = applyWithHooks("ejecutar", previewModeChange("ejecutar", env, repo).version);

    expect(applied.mode).toBe("ejecutor");
    expect(applied.backup).toBeTruthy();
    expect(fs.readFileSync(applied.backup!, "utf8")).toBe(original);
    const updated = fs.readFileSync(configFile, "utf8");
    expect(updated).toContain("// comentario que no debe desaparecer");
    expect(updated).toContain('"mode": "advisor"');
    expect(updated).toContain('"verification": false');
    expect(updated).toContain('"theme": "amber"');
    expect(loadConfig(env, repo).execution).toMatchObject({ intervention: "ejecutar" });
    expect(loadConfig(env, repo).execution.revision).toMatch(/^[a-f0-9]{32}$/);
    expect(loadConfig(env, repo).execution.revision).not.toBe(INITIAL_REVISION);
    expect(fs.readFileSync(opencodeFile, "utf8")).toBe(opencode);
    expect(fs.existsSync(`${configFile}.mode.lock`)).toBe(false);
    if (process.platform !== "win32") expect(fs.statSync(applied.backup!).mode & 0o777).toBe(0o600);

    const repeated = applyWithHooks("ejecutar", previewModeChange("ejecutar", env, repo).version);
    expect(repeated.backup).toBeNull();
    expect(fs.readFileSync(configFile, "utf8")).toBe(updated);
  });

  test("cambiar y volver al modo anterior conserva la sesion pero no revive planes", () => {
    const operation = { action: "edit", resource: path.join(repo, "file.ts") } as const;
    const originalScope: PlanScope = {
      sessionID: SESSION, project: "project", mode: "assistant", policyRevision: INITIAL_REVISION,
    };
    const presented = proposePlan(originalScope, {
      summary: "Plan previo", steps: ["Editar"], actions: [operation],
    });
    const active = authorizePlan(reviewPlan(presented, presented.digest), presented.digest);

    applyWithHooks("ejecutar", previewModeChange("ejecutar", env, repo).version);
    const executorRevision = loadConfig(env, repo).execution.revision;
    applyWithHooks("guiar", previewModeChange("guiar", env, repo).version);
    const current = loadConfig(env, repo);
    expect(current.mode).toBe("assistant");
    expect(current.execution.revision).not.toBe(INITIAL_REVISION);
    expect(current.execution.revision).not.toBe(executorRevision);
    expect(planAllows(active, { ...originalScope, policyRevision: current.execution.revision }, operation)).toBe(false);
  });

  test("rechaza una version falsa o desactualizada antes del hook y del respaldo", () => {
    const old = previewModeChange("ejecutar", env, repo);
    fs.appendFileSync(configFile, "// revision posterior al preview\n");
    const changed = fs.readFileSync(configFile, "utf8");
    let called = false;
    const apply = (version: string) => applyModeChange("ejecutar", version, () => { called = true; }, env, repo);
    expect(() => apply(old.version)).toThrow(/configuracion cambio/i);
    expect(() => apply("f".repeat(64))).toThrow(/configuracion cambio/i);
    expect(() => apply("invalid")).toThrow(/configuracion cambio/i);
    expect(called).toBe(false);
    expect(fs.readFileSync(configFile, "utf8")).toBe(changed);
    expect(fs.existsSync(path.join(home, "backups"))).toBe(false);
  });

  test("los overrides efectivos impiden cambios persistentes", () => {
    const version = previewModeChange("ejecutar", env, repo).version;
    const original = fs.readFileSync(configFile, "utf8");
    const overridden = { ...env, MALAHOR_EXECUTION_INTERVENTION: "acompanar" };
    expect(() => previewModeChange("ejecutar", overridden, repo)).toThrow(/sobreescribe/);
    expect(() => applyModeChange("ejecutar", version, () => undefined, overridden, repo)).toThrow(/sobreescribe/);

    fs.writeFileSync(configFile, '{"mode":"advisor","execution":{"verification":true}}\n');
    const legacy = fs.readFileSync(configFile, "utf8");
    const legacyOverride = { ...env, MALAHOR_MODE: "executor" };
    expect(() => previewModeChange("guiar", legacyOverride, repo)).toThrow(/sobreescribe|override/);
    expect(fs.readFileSync(configFile, "utf8")).toBe(legacy);
    expect(original).not.toBe(legacy);
  });

  test("no sigue config ni directorios padre que sean symlink", () => {
    const actual = path.join(root, "target.jsonc");
    const original = fs.readFileSync(configFile, "utf8");
    fs.writeFileSync(actual, original);
    fs.unlinkSync(configFile);
    fs.symlinkSync(actual, configFile);
    expect(() => previewModeChange("ejecutar", env, repo)).toThrow(/symlink|archivo regular/);
    expect(fs.readFileSync(actual, "utf8")).toBe(original);

    fs.unlinkSync(configFile);
    fs.writeFileSync(configFile, original);
    const external = path.join(root, "other-home");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "config.jsonc"), original);
    const link = path.join(home, "linked");
    fs.symlinkSync(external, link, "dir");
    const linkedEnv = { ...env, MALAHOR_CONFIG: path.join(link, "config.jsonc") };
    expect(() => previewModeChange("ejecutar", linkedEnv, repo)).toThrow(/symlink/);
    expect(fs.readFileSync(path.join(external, "config.jsonc"), "utf8")).toBe(original);
  });

  test("hooks DENY y ASK pendiente impiden escritura y respaldo", () => {
    const original = fs.readFileSync(configFile, "utf8");
    const version = previewModeChange("ejecutar", env, repo).version;
    for (const [controls, message] of [
      [{ deniedPathGlobs: ["config.jsonc"] }, /MAL-HOOK-FILE-DENYLIST/],
      [{ requireApprovalOutsideRoots: true }, /ASK pendiente/],
    ] as const) {
      policy(controls);
      expect(() => applyWithHooks("ejecutar", version)).toThrow(message);
      expect(fs.readFileSync(configFile, "utf8")).toBe(original);
      expect(fs.existsSync(path.join(home, "backups"))).toBe(false);
      expect(fs.existsSync(`${configFile}.mode.lock`)).toBe(false);
    }
  });
});

describe("CLI mode en entorno aislado", () => {
  test("preview no muestra token y set exige TTY o --yes", () => {
    const isolatedEnv: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => !key.startsWith("MALAHOR_") && typeof value === "string"),
    );
    Object.assign(isolatedEnv, env);
    const entry = path.resolve(import.meta.dir, "..", "src", "cli", "index.ts");
    const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, entry, "mode", ...args], {
      cwd: repo, env: isolatedEnv, stdout: "pipe", stderr: "pipe",
    });
    const opencode = fs.readFileSync(opencodeFile, "utf8");
    const original = fs.readFileSync(configFile, "utf8");
    const internalVersion = previewModeChange("ejecutar", env, repo).version;

    expect(invoke("status").stdout.toString()).toContain("Modo efectivo: asistente (guiar)");
    const preview = invoke("preview", "ejecutor");
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout.toString()).toContain("mode set ejecutor");
    expect(preview.stdout.toString()).not.toMatch(/token/i);
    expect(preview.stdout.toString()).not.toContain(internalVersion);
    expect(fs.readFileSync(configFile, "utf8")).toBe(original);

    const nonInteractive = invoke("set", "ejecutor");
    expect(nonInteractive.exitCode).toBe(1);
    expect(nonInteractive.stderr.toString()).toContain("--yes");
    expect(fs.readFileSync(configFile, "utf8")).toBe(original);

    const applied = invoke("set", "ejecutor", "--yes");
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout.toString()).toContain("Modo persistido: ejecutor");
    expect(applied.stdout.toString()).toContain("siguiente turno");
    expect(applied.stdout.toString()).not.toMatch(/token/i);
    expect(fs.readdirSync(path.join(home, "backups"))).toHaveLength(1);
    expect(loadConfig(env, repo).execution.intervention).toBe("ejecutar");
    expect(fs.readFileSync(opencodeFile, "utf8")).toBe(opencode);
    expect(invoke("apply", "guiar").exitCode).toBe(1);
  });
});

describe("/malahor-modo: comando V2 sin shell", () => {
  test("status, preview y cambio directo usan confirmacion nativa sin token", async () => {
    const { invoke, messages, permissions } = await command(async (sessionID) => sessionID === SESSION ? repo : undefined);
    const opencode = fs.readFileSync(opencodeFile, "utf8");
    const internalVersion = previewModeChange("ejecutar", env, repo).version;
    await invoke("/malahor-modo");
    expect(messages.at(-1)?.text).toContain("Modo efectivo: asistente (guiar)");
    await invoke("/malahor-modo preview ejecutor");
    expect(messages.at(-1)?.text).toContain("/malahor-modo ejecutor");
    expect(messages.at(-1)?.text).not.toMatch(/token/i);
    expect(messages.at(-1)?.text).not.toContain(internalVersion);
    expect(loadConfig(env, repo).execution.intervention).toBe("guiar");

    await invoke("/malahor-modo ejecutor");
    expect(permissions).toEqual([{
      sessionID: SESSION,
      action: MODE_CHANGE_ACTION,
      resources: [configFile, "asistente", "ejecutor"],
      save: [],
    }]);
    expect(permissions[0]?.resources).not.toContain(internalVersion);
    expect(messages.at(-1)?.text).toContain("Modo persistido: ejecutor");
    expect(messages.at(-1)?.text).toContain("siguiente turno de esta misma sesion");
    expect(messages.at(-1)?.text).not.toMatch(/token/i);
    expect(loadConfig(env, repo).execution.intervention).toBe("ejecutar");
    expect(fs.readdirSync(path.join(home, "backups"))).toHaveLength(1);
    expect(fs.readFileSync(opencodeFile, "utf8")).toBe(opencode);
  });

  test("una confirmacion nativa rechazada no escribe ni emite exito", async () => {
    const { invoke, messages, permissions } = await command(async () => repo, () => {
      throw new Error("permiso rechazado");
    });
    const original = fs.readFileSync(configFile, "utf8");
    await expect(invoke("/malahor-modo ejecutor")).rejects.toThrow("permiso rechazado");
    expect(permissions).toHaveLength(1);
    expect(messages).toEqual([]);
    expect(fs.readFileSync(configFile, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(home, "backups"))).toBe(false);
  });

  test("rechaza sesion ausente, proyecto ajeno, adjuntos e inyeccion de shell", async () => {
    const foreign = path.join(root, "foreign");
    fs.mkdirSync(foreign);
    const { invoke, messages, permissions } = await command(async (sessionID) =>
      sessionID === SESSION ? repo : sessionID === "ses_foreign" ? foreign : undefined);
    const original = fs.readFileSync(configFile, "utf8");
    const marker = path.join(root, "not-created");
    await expect(invoke("/malahor-modo status", "ses_missing")).rejects.toThrow(/Sesion/);
    await expect(invoke("/malahor-modo status", "ses_foreign")).rejects.toThrow(/registrad/);
    await expect(invoke("/malahor-modo status", SESSION, { files: ["adjunto"] })).rejects.toThrow(/adjuntos/);
    await expect(invoke(`/malahor-modo ejecutor && touch ${marker}`)).rejects.toThrow(/Uso/);
    expect(messages).toEqual([]);
    expect(permissions).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(configFile, "utf8")).toBe(original);
  });

  test("los hooks DENY y ASK siguen vigentes despues de la confirmacion nativa", async () => {
    const { invoke, messages, permissions } = await command(async () => repo);
    const original = fs.readFileSync(configFile, "utf8");
    for (const [controls, message] of [
      [{ deniedPathGlobs: ["config.jsonc"] }, /MAL-HOOK-FILE-DENYLIST/],
      [{ requireApprovalOutsideRoots: true }, /ASK pendiente/],
    ] as const) {
      policy(controls);
      await expect(invoke("/malahor-modo ejecutor")).rejects.toThrow(message);
      expect(messages).toEqual([]);
      expect(fs.readFileSync(configFile, "utf8")).toBe(original);
      expect(fs.existsSync(path.join(home, "backups"))).toBe(false);
    }
    expect(permissions).toHaveLength(2);
  });
});
