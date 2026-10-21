import fs from "node:fs";
import path from "node:path";

import type { OpenCodeHostInfo } from "./detector";
import { isManagedContent } from "./managed-plugin";
import {
  floorSatisfied,
  OPENCODE_SDK_MIN_VERSION,
  OPENCODE_SDK_PACKAGE,
  OPENCODE_SDK_PIN,
  readSdkOwnership,
} from "./opencode-sdk";
import type { MalahorPackagePaths } from "./package";
import type { MalahorPaths } from "./paths";

export const PLUGIN_ID = "malahor";
export const PLUGIN_STATE_SCHEMA = 1;
export const OPENCODE_V1_SDK_PACKAGE = "@opencode-ai/plugin";

export type HealthStatus = "ok" | "warn" | "fail";

export interface PluginHealthCheck {
  name: string;
  status: HealthStatus;
  message: string;
}

export interface PluginHealthContext {
  paths: MalahorPaths;
  host: OpenCodeHostInfo;
  packagePaths: MalahorPackagePaths | null;
}

export interface PluginStateSnapshot {
  schema: number;
  plugin: string;
  pluginVersion: string;
  host: "v1" | "v2" | "unknown";
  capabilities: Record<string, boolean>;
  degraded: string[];
  criticalGaps: string[];
  updatedAt: string;
}

export function pluginHealthChecks(context: PluginHealthContext): PluginHealthCheck[] {
  return [
    inspectOpenCodeSdk(context),
    inspectPluginsDir(context),
    inspectManagedPlugin(context),
    inspectPluginState(context),
  ];
}

export function inspectOpenCodeSdk(context: PluginHealthContext): PluginHealthCheck {
  const packageJsonPath = path.join(context.paths.opencodeDir, "package.json");
  const pkg = readJsonRecord(packageJsonPath);
  const v2Dependency = pkg.ok ? dependencyValue(pkg.value, OPENCODE_SDK_PACKAGE) : null;
  const v1Dependency = pkg.ok ? dependencyValue(pkg.value, OPENCODE_V1_SDK_PACKAGE) : null;
  const v2Installed = readInstalledVersion(context.paths.opencodeDir, OPENCODE_SDK_PACKAGE);
  const v1Installed = readInstalledVersion(context.paths.opencodeDir, OPENCODE_V1_SDK_PACKAGE);
  const ownership = readSdkOwnership(context.paths.opencodeSdkState);

  if (context.host.kind === "v2") {
    if (!pkg.ok) {
      return sdkCheck("fail", pkg.missing
        ? `package.json falta: ${packageJsonPath}; corre install/update`
        : `package.json invalido: ${pkg.error}; no se toca`);
    }

    if (!v2Dependency) {
      return sdkCheck("fail", `${OPENCODE_SDK_PACKAGE} no declarado en ${packageJsonPath}; corre install/update`);
    }

    if (!floorSatisfied(v2Dependency)) {
      return sdkCheck("fail", `${OPENCODE_SDK_PACKAGE}@${v2Dependency} no cumple el piso ${OPENCODE_SDK_MIN_VERSION}; corre install/update`);
    }

    if (!v2Installed) {
      return sdkCheck("fail", `${OPENCODE_SDK_PACKAGE}@${v2Dependency} declarado pero node_modules falta; corre install/update`);
    }

    if (!floorSatisfied(v2Installed)) {
      return sdkCheck("fail", `${OPENCODE_SDK_PACKAGE} instalado ${v2Installed} por debajo del piso ${OPENCODE_SDK_MIN_VERSION}; corre install/update`);
    }

    const exactPin = v2Dependency === OPENCODE_SDK_PIN;
    const message = `${OPENCODE_SDK_PACKAGE} ${v2Dependency} (instalado ${v2Installed}; piso ${OPENCODE_SDK_MIN_VERSION}; ${exactPin ? "pin exacto" : "no pin exacto"}; ${ownership ? "ownership Malahor" : "sin ownership"})`;

    return sdkCheck(exactPin ? "ok" : "warn", message);
  }

  const parts = [
    v1Dependency
      ? `v1 ${OPENCODE_V1_SDK_PACKAGE}@${v1Dependency}${v1Installed ? ` (instalado ${v1Installed})` : " (node_modules falta)"}`
      : `v1 ${OPENCODE_V1_SDK_PACKAGE} no declarado`,
    v2Dependency
      ? `v2 ${OPENCODE_SDK_PACKAGE}@${v2Dependency}${v2Installed ? ` (instalado ${v2Installed})` : " (node_modules falta)"}`
      : `v2 ${OPENCODE_SDK_PACKAGE} no declarado (policy T-5.0.3)`,
  ];

  if (!pkg.ok) {
    const state = pkg.missing ? "falta" : "invalido";
    return sdkCheck("warn", `${packageJsonPath} ${state}; ${parts.join("; ")}`);
  }

  if (context.host.kind === "v1") {
    if (!v1Dependency) {
      return sdkCheck("warn", `host V1 sin ${OPENCODE_V1_SDK_PACKAGE}; ${parts.join("; ")}`);
    }
    if (!v1Installed) {
      return sdkCheck("warn", `${OPENCODE_V1_SDK_PACKAGE} declarado pero node_modules falta; ${parts.join("; ")}`);
    }
    if (!v2Dependency) {
      return sdkCheck("warn", `host V1 sin pin V2 (${OPENCODE_SDK_PACKAGE}@${OPENCODE_SDK_PIN}); ${parts.join("; ")}`);
    }
    if (!v2Installed) {
      return sdkCheck("warn", `V2 declarado pero node_modules falta; ${parts.join("; ")}`);
    }
    if (!floorSatisfied(v2Dependency) || !floorSatisfied(v2Installed)) {
      return sdkCheck("warn", `V2 no cumple el piso ${OPENCODE_SDK_MIN_VERSION}; ${parts.join("; ")}`);
    }

    return sdkCheck("ok", parts.join("; "));
  }

  return sdkCheck("warn", `host desconocido; ${parts.join("; ")}`);
}

export function inspectPluginsDir(context: PluginHealthContext): PluginHealthCheck {
  const directory = context.paths.opencodePluginsDir;

  if (isDirectory(directory)) {
    return { name: "OpenCode plugins dir", status: "ok", message: directory };
  }

  return {
    name: "OpenCode plugins dir",
    status: v2Severity(context.host),
    message: `falta o no es directorio: ${directory}; corre install/update`,
  };
}

export function inspectManagedPlugin(context: PluginHealthContext): PluginHealthCheck {
  const pluginFile = path.join(context.paths.malahorPluginDir, "index.ts");

  if (!fs.existsSync(pluginFile)) {
    return {
      name: "Plugin Malahor",
      status: v2Severity(context.host),
      message: `falta: ${pluginFile}; corre install/update`,
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(pluginFile, "utf8");
  } catch (error) {
    return {
      name: "Plugin Malahor",
      status: v2Severity(context.host),
      message: `no se pudo leer ${pluginFile}: ${(error as Error).message}`,
    };
  }

  if (!isManagedContent(content)) {
    return {
      name: "Plugin Malahor",
      status: v2Severity(context.host),
      message: `archivo ajeno en ${pluginFile}; no se pisa; mover/renombrar para que Malahor instale el suyo`,
    };
  }

  const version = parsePluginVersion(content);
  const versionLabel = version ? `v${version}` : "version desconocida";
  const assetPath = context.packagePaths
    ? path.join(context.packagePaths.assetsDir, "opencode", "plugins", "malahor", "index.ts")
    : null;

  if (!assetPath || !fs.existsSync(assetPath)) {
    return {
      name: "Plugin Malahor",
      status: "warn",
      message: `gestionado ${versionLabel}; asset del paquete no disponible para verificar`,
    };
  }

  let asset: string;
  try {
    asset = fs.readFileSync(assetPath, "utf8");
  } catch (error) {
    return {
      name: "Plugin Malahor",
      status: "warn",
      message: `gestionado ${versionLabel}; no se pudo leer el asset (${(error as Error).message})`,
    };
  }

  if (content === asset) {
    return { name: "Plugin Malahor", status: "ok", message: `gestionado ${versionLabel} (al dia)` };
  }

  return {
    name: "Plugin Malahor",
    status: "warn",
    message: `gestionado ${versionLabel} desactualizado vs asset; corre update o doctor --self-heal`,
  };
}

export function inspectPluginState(context: PluginHealthContext): PluginHealthCheck {
  const stateFile = context.paths.pluginState;

  if (!fs.existsSync(stateFile)) {
    return {
      name: "Plugin state",
      status: "warn",
      message: `sin evidencia de carga en ${stateFile} (plugin lazy: abri una sesion nueva; no se fabrica estado)`,
    };
  }

  const parsed = readJsonRecord(stateFile);
  if (!parsed.ok) {
    return {
      name: "Plugin state",
      status: "warn",
      message: `${stateFile} ${parsed.missing ? "falta" : `invalido (${parsed.error})`}; se regenera al cargar`,
    };
  }

  const state = parsePluginState(parsed.value);
  if (!state) {
    return { name: "Plugin state", status: "warn", message: `${stateFile} invalido (schema/plugin/campos); se regenera al cargar` };
  }

  let status: HealthStatus = "ok";
  const issues: string[] = [];
  const escalate = (next: HealthStatus): void => {
    if (next === "fail" || (next === "warn" && status === "ok")) {
      status = next;
    }
  };

  if (state.host !== context.host.kind) {
    escalate("warn");
    issues.push(`host estado=${state.host}, detectado=${context.host.kind}`);
  }

  if (state.host === "unknown") {
    escalate(context.host.kind === "v2" ? "fail" : "warn");
    issues.push("host=unknown");
  }

  if (state.criticalGaps.length > 0) {
    escalate(context.host.kind === "v2" ? "fail" : "warn");
    issues.push(`criticalGaps=${state.criticalGaps.join(",")}`);
  }

  if (state.degraded.length > 0) {
    escalate("warn");
    issues.push(`degraded=${state.degraded.join(",")}`);
  }

  const installedVersion = readInstalledPluginVersion(context.paths);
  if (installedVersion && state.pluginVersion !== installedVersion) {
    escalate("warn");
    issues.push(`version estado=${state.pluginVersion}, plugin=${installedVersion}`);
  }

  if (!Number.isFinite(Date.parse(state.updatedAt))) {
    escalate("warn");
    issues.push(`updatedAt invalido=${state.updatedAt}`);
  }

  if (process.platform !== "win32") {
    try {
      const mode = fs.statSync(stateFile).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        escalate("warn");
        issues.push(`permisos ${mode.toString(8)} (esperado 600)`);
      }
    } catch {
      // Un stat fallido no convierte el estado en evidencia valida; el parseo ya paso.
    }
  }

  const capabilities = Object.values(state.capabilities).filter(Boolean).length;
  const total = Object.keys(state.capabilities).length;
  const summary = `${state.host} ${state.pluginVersion}; actualizado ${state.updatedAt}; caps ${capabilities}/${total}`;

  return {
    name: "Plugin state",
    status,
    message: issues.length > 0 ? `${summary}; ${issues.join("; ")}` : summary,
  };
}

export function parsePluginVersion(content: string): string | null {
  const match = /\bconst\s+PLUGIN_VERSION\s*=\s*"([^"]+)"/.exec(content);
  return match?.[1] ?? null;
}

export function parsePluginState(value: unknown): PluginStateSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.schema !== PLUGIN_STATE_SCHEMA) return null;
  if (value.plugin !== PLUGIN_ID) return null;
  if (typeof value.pluginVersion !== "string" || !value.pluginVersion.trim()) return null;
  if (value.host !== "v1" && value.host !== "v2" && value.host !== "unknown") return null;
  if (!isRecord(value.capabilities)) return null;
  if (!isStringArray(value.degraded) || !isStringArray(value.criticalGaps)) return null;
  if (typeof value.updatedAt !== "string" || !value.updatedAt.trim()) return null;

  const capabilities: Record<string, boolean> = {};
  for (const [name, available] of Object.entries(value.capabilities)) {
    if (typeof available !== "boolean") return null;
    capabilities[name] = available;
  }

  return {
    schema: value.schema,
    plugin: value.plugin,
    pluginVersion: value.pluginVersion,
    host: value.host,
    capabilities,
    degraded: [...value.degraded],
    criticalGaps: [...value.criticalGaps],
    updatedAt: value.updatedAt,
  };
}

function sdkCheck(status: HealthStatus, message: string): PluginHealthCheck {
  return { name: "OpenCode SDK", status, message };
}

function v2Severity(host: OpenCodeHostInfo): HealthStatus {
  return host.kind === "v2" ? "fail" : "warn";
}

function dependencyValue(pkg: Record<string, unknown>, name: string): string | null {
  if (!isRecord(pkg.dependencies)) return null;
  const value = pkg.dependencies[name];
  return typeof value === "string" ? value : null;
}

function readInstalledVersion(opencodeDir: string, packageName: string): string | null {
  const file = path.join(opencodeDir, "node_modules", ...packageName.split("/"), "package.json");
  const parsed = readJsonRecord(file);
  if (!parsed.ok) return null;
  return typeof parsed.value.version === "string" ? parsed.value.version : null;
}

function readInstalledPluginVersion(paths: MalahorPaths): string | null {
  const file = path.join(paths.malahorPluginDir, "index.ts");
  try {
    return parsePluginVersion(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

type JsonReadResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; missing: boolean; error?: string };

function readJsonRecord(filePath: string): JsonReadResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, missing: true };
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(parsed)) {
      return { ok: false, missing: false, error: "no es un objeto JSON" };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, missing: false, error: (error as Error).message };
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
