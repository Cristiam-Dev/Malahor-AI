// malahor-managed
// Entrypoint fuente del plugin gestionado. `bun run build:plugin` lo bundlea a
// assets/opencode/plugins/malahor/index.ts. No importa el SDK: solo usa la
// forma estructural de los hosts V1/V2 para no romper la carga.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePaths, type MalahorPaths } from "../cli/core/paths";
import { registeredProjectRoots } from "../cli/core/context";
import { resolveProject } from "../cli/core/project";
import { codegraphRoot, codegraphRuntime } from "../cli/core/codegraph-runtime";
import { loadHookPolicy } from "../cli/core/hooks/policy-loader";
import {
  checkpointBeforeCompaction,
  injectCompactionInstructions,
  type CompactionStorage,
} from "./compaction";
import { markMemoryPersisted, maybeInjectMemoryNudge } from "./memory-nudge";
import { startEventCapture, type EventDomain } from "./events";
import {
  evaluatePermission,
  evaluateSessionHook,
  evaluateShellHook,
  evaluateToolHook,
  formatPluginBlock,
  shouldBlockPluginResult,
  type PluginAdapterOptions,
} from "../cli/core/hooks/plugin-adapter";
import type { HookEvent, HookResult } from "../cli/core/hooks/types";
import { injectMalahorProtocol } from "./protocol";

const PLUGIN_ID = "malahor";
const PLUGIN_VERSION = "0.4.0";
const STATE_SCHEMA = 1;

type HostKind = "v1" | "v2" | "unknown";

interface HostInspection {
  host: HostKind;
  capabilities: Record<string, boolean>;
  degraded: string[];
  criticalGaps: string[];
}

interface PluginState extends HostInspection {
  schema: number;
  plugin: string;
  pluginVersion: string;
  updatedAt: string;
}

type Cleanup = () => Promise<void> | void;

type HookDomain = {
  hook: (name: string, callback: (input: Record<string, unknown>) => Promise<void> | void) => Promise<unknown> | unknown;
  get?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
};

type McpServerConfig = Record<string, unknown>;

type McpEditor = {
  get: (name: string) => McpServerConfig | undefined;
  set: (name: string, config: McpServerConfig) => void;
};

type McpTransformDomain = {
  transform: (callback: (editor: McpEditor) => void) => Promise<unknown> | unknown;
};

type StorageDomain = CompactionStorage;

const SESSION_HOOKS: HookEvent[] = [
  "session.prompt.before",
  "session.context.before",
  "session.compaction.before",
  "session.generate.before",
  "session.title.before",
  "session.model-request.before",
  "session.http-request.before",
  "session.http-response.after",
];

const BLOCKING_SHELL_ASK_IDS = ["MAL-HOOK-PUSH-CLI-EVIDENCE"];

function detectHost(value: unknown): HostKind {
  if (!isRecord(value)) return "unknown";

  const isV2 =
    (isRecord(value.session) && typeof value.session.hook === "function") ||
    (isRecord(value.mcp) && typeof value.mcp.transform === "function") ||
    (isRecord(value.agent) && typeof value.agent.transform === "function");
  if (isV2) return "v2";

  const isV1 =
    isRecord(value.client) &&
    isRecord(value.project) &&
    typeof value.directory === "string";
  if (isV1) return "v1";

  return "unknown";
}

async function setupV2(context: Record<string, unknown>): Promise<Cleanup | void> {
  const cwd = locationDirectory(context) ?? process.cwd();
  const options: PluginAdapterOptions = {
    cwd,
    permissionRegistered: false,
    shellRegistered: false,
  };
  const cleanups: Cleanup[] = [];
  const capabilities: Record<string, boolean> = {};
  const degraded: string[] = [];
  const criticalGaps: string[] = [];

  const domain = (name: string): HookDomain | undefined => {
    const value = context[name];
    if (!isRecord(value) || typeof value.hook !== "function") return undefined;
    return value as unknown as HookDomain;
  };

  const mcp = transformDomain(context.mcp);
  if (mcp) {
    const registration = await registerMcpTransform(mcp, cwd, process.env, cleanups, locationCanonical(context));
    capabilities["mcp.transform"] = registration.ok;
    if (registration.warnings.length > 0) degraded.push(...registration.warnings);
  } else {
    capabilities["mcp.transform"] = false;
    degraded.push("mcp.transform");
  }

  const session = domain("session");
  const storage = storageDomain(context.storage);
  if (session?.get) {
    options.resolveSessionDirectory = async (sessionID) => {
      const value = await session.get?.({ sessionID });
      return sessionLocationDirectory(value);
    };
  }

  const permission = domain("permission");
  if (permission) {
    options.permissionRegistered = await registerHook(permission, "evaluate", async (input) => {
      const evaluated = await evaluatePermission(input, options);
      if (evaluated.effect === "deny") {
        warn(`permission.evaluate deny: ${summary(evaluated.result)}`);
      }
    }, cleanups);
  }
  if (!permission) criticalGaps.push("permission.hook");
  else if (!options.permissionRegistered) criticalGaps.push("permission.evaluate");
  capabilities.permission = Boolean(permission);
  capabilities["permission.evaluate"] = options.permissionRegistered === true;

  const shell = domain("shell");
  if (shell) {
    options.shellRegistered = await registerHook(shell, "create.before", async (input) => {
      const evaluated = await evaluateShellHook(input, options);
      if (isRecord(input.env)) {
        replaceRecord(input.env as Record<string, string | undefined>, evaluated.env);
      }
      input.timeout = evaluated.timeout;
      if (shouldBlockPluginResult(evaluated.result, options, BLOCKING_SHELL_ASK_IDS)) {
        throw new Error(formatPluginBlock(evaluated.result));
      }
    }, cleanups);
  }
  if (!shell) criticalGaps.push("shell.hook");
  else if (!options.shellRegistered) criticalGaps.push("shell.create.before");
  capabilities.shell = Boolean(shell);
  capabilities["shell.create.before"] = options.shellRegistered === true;

  const tool = domain("tool");
  if (tool) {
    const registered = await registerHook(tool, "execute.before", async (input) => {
      const result = await evaluateToolHook(input, options);
      if (shouldBlockPluginResult(result, options)) {
        throw new Error(formatPluginBlock(result));
      }
    }, cleanups);
    capabilities.tool = true;
    capabilities["tool.execute.before"] = registered;
    if (!registered) criticalGaps.push("tool.execute.before");

    const freshnessRegistered = storage && typeof storage.get === "function"
      ? await registerHook(tool, "execute.after", async (input) => {
        const marked = await markMemoryPersisted(input, storage, {
          cwd,
          env: process.env,
          resolveSessionDirectory: options.resolveSessionDirectory,
        });
        if (!marked.ok) warn(`freshness de memoria degradada${marked.reason ? `: ${marked.reason}` : ""}`);
      }, cleanups)
      : false;
    capabilities["memory.freshness"] = freshnessRegistered;
    if (!freshnessRegistered) degraded.push("memory.freshness");
  } else {
    capabilities.tool = false;
    capabilities["tool.execute.before"] = false;
    capabilities["memory.freshness"] = false;
    criticalGaps.push("tool.hook");
  }

  if (session) {
    for (const event of SESSION_HOOKS) {
      const registered = await registerHook(session, hookNameForEvent(event), async (input) => {
        const result = await evaluateSessionHook(event, input, options);
        if (event === "session.http-response.after") return;
        if (result.decision === "deny" || result.decision === "ask") {
          throw new Error(formatPluginBlock(result));
        }
      }, cleanups);
      capabilities[event] = registered;
      if (!registered) {
        if (event === "session.http-response.after") degraded.push(event);
        else criticalGaps.push(event);
      }
    }

    const protocolRegistered = await registerHook(session, "context", async (input) => {
      injectMalahorProtocol(input);
    }, cleanups);
    capabilities["protocol.context"] = protocolRegistered;
    if (!protocolRegistered) degraded.push("protocol.context");

    const compactionRegistered = await registerHook(session, "compaction", async (input) => {
      if (storage) {
        const checkpoint = await checkpointBeforeCompaction(input, storage, {
          cwd,
          resolveSessionDirectory: options.resolveSessionDirectory,
        });
        if (!checkpoint.ok) {
          warn(`checkpoint de compaction degradado${checkpoint.reason ? `: ${checkpoint.reason}` : ""}`);
        }
      } else {
        warn("checkpoint de compaction degradado: ctx.storage no disponible");
      }
      injectCompactionInstructions(input);
    }, cleanups);
    capabilities["compaction.checkpoint"] = compactionRegistered && Boolean(storage);
    if (!compactionRegistered || !storage) degraded.push("compaction.checkpoint");

    const nudgeRegistered = storage && typeof storage.get === "function"
      ? await registerHook(session, "context", async (input) => {
        const nudge = await maybeInjectMemoryNudge(input, storage, {
          cwd,
          env: process.env,
          resolveSessionDirectory: options.resolveSessionDirectory,
        });
        if (!nudge.ok && nudge.reason) warn(`nudge de memoria degradado: ${nudge.reason}`);
      }, cleanups)
      : false;
    capabilities["memory.nudge"] = nudgeRegistered;
    if (!nudgeRegistered) degraded.push("memory.nudge");
  } else {
    capabilities.session = false;
    for (const event of SESSION_HOOKS) capabilities[event] = false;
    capabilities["protocol.context"] = false;
    capabilities["compaction.checkpoint"] = false;
    capabilities["memory.nudge"] = false;
    criticalGaps.push("session.hook");
  }
  capabilities.session = Boolean(session);

  const event = eventDomain(context.event);
  if (event && storage) {
    const capture = startEventCapture(event, storage, {
      cwd,
      captureSubagentsOptIn: captureSubagentsOptIn(cwd, process.env),
      resolveSessionDirectory: options.resolveSessionDirectory,
      onError: (message) => warn(message),
    });
    capabilities.event = capture.ok;
    cleanups.push(capture.cleanup);
    if (!capture.ok) degraded.push("event");
  } else {
    capabilities.event = false;
    degraded.push("event");
  }

  const auxiliary = ["mcp", "agent", "command", "skill", "storage"] as const;
  for (const name of auxiliary) {
    const available = name === "storage"
      ? context.storage !== undefined && context.storage !== null
      : isRecord(context[name]) && (
        typeof (context[name] as Record<string, unknown>).transform === "function"
        || typeof (context[name] as Record<string, unknown>).hook === "function"
        || typeof (context[name] as Record<string, unknown>).subscribe === "function"
      );
    capabilities[name] = available;
    if (!available) degraded.push(name);
  }

  const inspection: HostInspection = {
    host: "v2",
    capabilities,
    degraded: unique(degraded),
    criticalGaps: unique(criticalGaps),
  };
  const recorded = recordState(inspection);
  if (!recorded) warn("estado de diagnostico no disponible (degradado auxiliar)");
  if (inspection.criticalGaps.length > 0) {
    warn(`controles criticos no disponibles: ${inspection.criticalGaps.join(", ")}; no se habilitan operaciones protegidas`);
  } else if (inspection.degraded.length > 0) {
    warn(`capacidades auxiliares degradadas: ${inspection.degraded.join(", ")}`);
  }

  return async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        warn(`cleanup fallido: ${(error as Error).message}`);
      }
    }
  };
}

async function setupV1(input: Record<string, unknown>): Promise<void> {
  const capabilities = {
    client: isRecord(input.client),
    project: isRecord(input.project),
    directory: typeof input.directory === "string",
    worktree: typeof input.worktree === "string",
    shell: typeof input.$ === "function",
    workspace: isRecord(input.experimental_workspace),
  };
  const degraded = Object.entries(capabilities)
    .filter(([, available]) => !available)
    .map(([name]) => name);
  const criticalGaps = [
    "v1.permission.hook",
    "v1.tool.hook",
    "v1.shell.hook",
    "v1.session.hook",
  ];
  recordState({ host: "v1", capabilities, degraded, criticalGaps });
  warn("host V1 detectado: no hay hooks de mediacion; cobertura V1 completa queda en T-5.6.4");
}

async function setupUnknown(): Promise<void> {
  recordState({
    host: "unknown",
    capabilities: {},
    degraded: ["host-api-desconocida"],
    criticalGaps: ["host-api-desconocida"],
  });
  warn("API de host no reconocida; plugin inactivo (degradacion segura)");
}

const plugin = {
  id: PLUGIN_ID,

  async setup(context: unknown): Promise<Cleanup | void> {
    const host = detectHost(context);
    if (host === "v2") return setupV2(context as Record<string, unknown>);
    if (host === "v1") {
      await setupV1(context as Record<string, unknown>);
      return;
    }
    await setupUnknown();
  },

  async server(input: unknown): Promise<Record<string, never>> {
    const host = detectHost(input);
    if (host === "v2") {
      await setupV2(input as Record<string, unknown>);
    } else if (host === "v1") {
      await setupV1(input as Record<string, unknown>);
    } else {
      await setupUnknown();
    }
    return {};
  },
};

export default plugin;

async function registerHook(
  domain: HookDomain,
  name: string,
  callback: (input: Record<string, unknown>) => Promise<void>,
  cleanups: Cleanup[],
): Promise<boolean> {
  try {
    const registration = await domain.hook(name, callback);
    if (isRecord(registration) && typeof registration.dispose === "function") {
      cleanups.push(() => (registration.dispose as () => Promise<void> | void)());
    }
    return true;
  } catch (error) {
    warn(`no se pudo registrar ${name}: ${(error as Error).message}`);
    return false;
  }
}

function hookNameForEvent(event: HookEvent): string {
  if (event === "session.prompt.before") return "prompt";
  if (event === "session.context.before") return "context";
  if (event === "session.compaction.before") return "compaction";
  if (event === "session.generate.before") return "generate";
  if (event === "session.title.before") return "title";
  if (event === "session.model-request.before") return "model.request";
  if (event === "session.http-request.before") return "http.request";
  if (event === "session.http-response.after") return "http.response";
  return event;
}

function locationDirectory(context: Record<string, unknown>): string | undefined {
  const location = isRecord(context.location) ? context.location : undefined;
  if (!location) return undefined;
  return typeof location.directory === "string" ? location.directory : undefined;
}

function locationCanonical(context: Record<string, unknown>): string | undefined {
  const location = isRecord(context.location) ? context.location : undefined;
  const project = location && isRecord(location.project) ? location.project : undefined;
  return typeof project?.canonical === "string" ? project.canonical : undefined;
}

function transformDomain(value: unknown): McpTransformDomain | undefined {
  if (!isRecord(value) || typeof value.transform !== "function") return undefined;
  return value as unknown as McpTransformDomain;
}

function storageDomain(value: unknown): StorageDomain | undefined {
  if (!isRecord(value) || typeof value.set !== "function") return undefined;
  return value as unknown as StorageDomain;
}

function eventDomain(value: unknown): EventDomain | undefined {
  if (!isRecord(value) || typeof value.subscribe !== "function") return undefined;
  return value as unknown as EventDomain;
}

function captureSubagentsOptIn(cwd: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const paths = resolvePaths({ ...env, MALAHOR_OPENCODE_DETECT: "0" }, cwd);
    const project = resolveProject(cwd);
    const loaded = loadHookPolicy(paths, project.canonicalKey);
    return loaded.security?.persistence?.captureSubagentsOptIn === true;
  } catch {
    return false;
  }
}

async function registerMcpTransform(
  domain: McpTransformDomain,
  cwd: string,
  env: NodeJS.ProcessEnv,
  cleanups: Cleanup[],
  canonical?: string,
): Promise<{ ok: boolean; warnings: string[] }> {
  const paths = resolvePaths({ ...env, MALAHOR_OPENCODE_DETECT: "0" }, cwd);
  const warnings: string[] = [];
  if (!fs.existsSync(paths.mnemoIndex)) {
    warnings.push("mcp.mnemo-index-missing");
  }

  try {
    const registration = await domain.transform((editor) => {
      const existingMnemo = editor.get("mnemo");
      if (fs.existsSync(paths.mnemoIndex)) {
        if (!existingMnemo || isMalahorMnemo(existingMnemo, paths)) {
          editor.set("mnemo", {
            ...(existingMnemo ?? {}),
            type: "local",
            command: ["node", paths.mnemoIndex],
            disabled: false,
            codemode: false,
          });
        } else {
          warnings.push("mcp.mnemo-foreign-definition");
        }
      }

      const existingObsidian = editor.get("obsidian");
      if (!existingObsidian) {
        warnings.push("mcp.obsidian-definition-missing");
      } else if (existingObsidian.type !== "remote") {
        warnings.push("mcp.obsidian-legacy-local");
      } else {
        // La definición remota aprobada se conserva sin copiar headers ni secretos
        // a otro store; la resolución dinámica del host pertenece a T-5.11.8.
        editor.set("obsidian", { ...existingObsidian, disabled: false, codemode: false });
      }

      const existingCodegraph = editor.get("codegraph");
      let target: ReturnType<typeof codegraphRoot> | undefined;
      try {
        const registered = canonical ? registeredProjectRoots(paths.projectsFile)
          .find((entry) => fs.realpathSync(entry.root) === fs.realpathSync(canonical)) : undefined;
        if (!canonical || registered) target = codegraphRoot(paths, registered?.canonicalKey);
      } catch { /* No registered root at this location. */ }
      const runtime = target && codegraphRuntime(paths, target.project, target.root);
      if (!runtime) {
        warnings.push("mcp.codegraph-no-managed-index");
        if (existingCodegraph && isManagedCodegraph(existingCodegraph, paths)) {
          editor.set("codegraph", { ...existingCodegraph, disabled: true });
        }
      } else if (existingCodegraph && !isManagedCodegraph(existingCodegraph, paths)) {
        warnings.push("mcp.codegraph-foreign-definition");
      } else {
        editor.set("codegraph", {
          type: "local",
          command: ["node", runtime.proxy, runtime.binary, runtime.root, runtime.database, target!.project, paths.projectsFile, paths.malahorHome],
          cwd: runtime.root,
          environment: { NODE_OPTIONS: "", NODE_PATH: "" },
          disabled: false,
          codemode: false,
          protocol: "legacy",
        });
      }
    });
    if (isRecord(registration) && typeof registration.dispose === "function") {
      cleanups.push(() => (registration.dispose as () => Promise<void> | void)());
    }
    return { ok: true, warnings: unique(warnings) };
  } catch (error) {
    warn(`no se pudo registrar ctx.mcp.transform: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, warnings: ["mcp.transform-registration"] };
  }
}

function isManagedCodegraph(config: McpServerConfig, paths: MalahorPaths): boolean {
  return config.type === "local" && Array.isArray(config.command)
    && config.command[0] === "node" && config.command[1] === path.join(paths.malahorHome, "codegraph", "bin", "mcp-proxy.mjs");
}

function isMalahorMnemo(config: McpServerConfig, paths: MalahorPaths): boolean {
  if (config.type !== "local" || !Array.isArray(config.command)) return false;
  const command = config.command.filter((item): item is string => typeof item === "string");
  return command.some((item) => path.resolve(paths.opencodeDir, item) === path.resolve(paths.mnemoIndex));
}

function sessionLocationDirectory(value: unknown): string | undefined {
  const response = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(response)) return undefined;
  const location = isRecord(response.location) ? response.location : undefined;
  return location && typeof location.directory === "string" ? location.directory : undefined;
}

function recordState(inspection: HostInspection): boolean {
  const directory = resolveMalahorHome();
  const file = path.join(directory, "plugin-state.json");
  const state: PluginState = {
    schema: STATE_SCHEMA,
    plugin: PLUGIN_ID,
    pluginVersion: PLUGIN_VERSION,
    host: inspection.host,
    capabilities: inspection.capabilities,
    degraded: inspection.degraded,
    criticalGaps: inspection.criticalGaps,
    updatedAt: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.plugin-state.${process.pid}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    return true;
  } catch (error) {
    warn(`no se pudo escribir ${file}: ${(error as Error).message}`);
    return false;
  }
}

function resolveMalahorHome(): string {
  const override = process.env.MALAHOR_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".malahor");
}

function replaceRecord(target: Record<string, string | undefined>, source: Record<string, string | undefined>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function summary(result: HookResult): string {
  return result.violations
    .filter((violation) => violation.decision === "deny")
    .map((violation) => violation.id)
    .join(",") || result.decision;
}

function warn(message: string): void {
  console.warn(`[${PLUGIN_ID}] ${message}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
