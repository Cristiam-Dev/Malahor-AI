// malahor-managed
// Plugin base de Malahor. Scaffold T-5.0.4: forma dual V1/V2, sin registros
// funcionales todavia (Fase 5.1) y sin imports del SDK para no romper hosts V1.
//
// Seguridad (§13): este archivo no registra permisos ni relaja controles.
// Todo control critico futuro debe fallar cerrado; lo unico fail-open permitido
// son capacidades auxiliares (por ejemplo, el estado de diagnostico).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ID = "malahor";
const PLUGIN_VERSION = "0.2.0-scaffold.1";
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

function inspectV2(context: Record<string, unknown>): HostInspection {
  const capability = (domain: string, member: string): boolean => {
    const value = context[domain];
    return isRecord(value) && typeof value[member] === "function";
  };

  const capabilities = {
    mcp: capability("mcp", "transform"),
    agent: capability("agent", "transform"),
    command: capability("command", "transform"),
    skill: capability("skill", "transform"),
    session: capability("session", "hook"),
    permission: capability("permission", "hook"),
    tool: capability("tool", "hook"),
    event: capability("event", "subscribe"),
    storage: context.storage !== undefined && context.storage !== null,
  };

  const criticalGaps: string[] = [];
  if (!capabilities.session) criticalGaps.push("session.hook");
  if (!capabilities.permission) criticalGaps.push("permission.hook");

  const auxiliary = ["mcp", "agent", "command", "skill", "tool", "event", "storage"] as const;
  const degraded = auxiliary.filter((name) => !capabilities[name]);

  return { host: "v2", capabilities, degraded, criticalGaps };
}

function inspectV1(input: Record<string, unknown>): HostInspection {
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

  return { host: "v1", capabilities, degraded, criticalGaps: [] };
}

function inspectUnknown(): HostInspection {
  return {
    host: "unknown",
    capabilities: {},
    degraded: ["host-api-desconocida"],
    criticalGaps: ["host-api-desconocida"],
  };
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

function warn(message: string): void {
  console.warn(`[${PLUGIN_ID}] ${message}`);
}

async function setupV2(context: Record<string, unknown>): Promise<void> {
  const inspection = inspectV2(context);
  const recorded = recordState(inspection);

  if (!recorded) {
    warn("estado de diagnostico no disponible (degradado auxiliar)");
  }
  if (inspection.criticalGaps.length > 0) {
    warn(`controles criticos no disponibles: ${inspection.criticalGaps.join(", ")}; no se habilitan operaciones protegidas`);
  } else if (inspection.degraded.length > 0) {
    warn(`capacidades auxiliares degradadas: ${inspection.degraded.join(", ")}`);
  }
}

async function setupV1(input: Record<string, unknown>): Promise<void> {
  const inspection = inspectV1(input);
  recordState(inspection);
  warn("host V1 detectado; scaffold sin registros (cobertura V1 completa: T-5.6.4)");
}

async function setupUnknown(): Promise<void> {
  const inspection = inspectUnknown();
  recordState(inspection);
  warn("API de host no reconocida; plugin inactivo (degradacion segura)");
}

const plugin = {
  id: PLUGIN_ID,

  async setup(context: unknown): Promise<void> {
    const host = detectHost(context);
    if (host === "v2") {
      await setupV2(context as Record<string, unknown>);
      return;
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
