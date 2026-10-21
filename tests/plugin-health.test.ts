import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { detectOpenCodeHost, hostKindForVersion, parseOpenCodeVersion, type OpenCodeHostInfo } from "../src/cli/core/detector";
import { resolvePaths, type MalahorPaths } from "../src/cli/core/paths";
import {
  inspectManagedPlugin,
  inspectOpenCodeSdk,
  inspectPluginState,
  inspectPluginsDir,
  parsePluginState,
  parsePluginVersion,
  PLUGIN_STATE_SCHEMA,
  pluginHealthChecks,
  type PluginHealthContext,
  type PluginStateSnapshot,
} from "../src/cli/core/plugin-health";
import { OPENCODE_SDK_PACKAGE, OPENCODE_SDK_PIN } from "../src/cli/core/opencode-sdk";
import type { MalahorPackagePaths } from "../src/cli/core/package";

const V1_SDK = "@opencode-ai/plugin";
const PLUGIN_VERSION = "0.2.0-scaffold.1";

function tempDir(): string {
  return fs.mkdtempSync(path.join("/tmp/opencode", "malahor-plugin-health-"));
}

function pathsFor(root: string): MalahorPaths {
  return resolvePaths(
    {
      HOME: path.join(root, "home"),
      MALAHOR_HOME: path.join(root, "malahor"),
      MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
      MALAHOR_OPENCODE_DETECT: "0",
    },
    root,
  );
}

function packagePathsFor(root: string): MalahorPackagePaths {
  return {
    root,
    assetsDir: path.join(root, "assets"),
    mnemoBuild: path.join(root, "dist", "mnemo", "index.js"),
  };
}

function context(root: string, host: OpenCodeHostInfo = { kind: "v2", version: "2.0.32" }): PluginHealthContext {
  return { paths: pathsFor(root), host, packagePaths: packagePathsFor(root) };
}

function writeJson(filePath: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", ...(mode ? { mode } : {}) });
  if (mode) fs.chmodSync(filePath, mode);
}

function writePackage(paths: MalahorPaths, dependencies: Record<string, string>): void {
  writeJson(path.join(paths.opencodeDir, "package.json"), { dependencies });
}

function writeInstalled(paths: MalahorPaths, packageName: string, version: string): void {
  writeJson(
    path.join(paths.opencodeDir, "node_modules", ...packageName.split("/"), "package.json"),
    { name: packageName, version },
  );
}

function pluginContent(version = PLUGIN_VERSION): string {
  return `// malahor-managed\nconst PLUGIN_VERSION = "${version}";\nexport default {};\n`;
}

function writePluginAsset(ctx: PluginHealthContext, content = pluginContent()): void {
  const file = path.join(ctx.packagePaths?.assetsDir ?? "", "opencode", "plugins", "malahor", "index.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeInstalledPlugin(ctx: PluginHealthContext, content = pluginContent()): void {
  const file = path.join(ctx.paths.malahorPluginDir, "index.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function validState(overrides: Partial<PluginStateSnapshot> = {}): PluginStateSnapshot {
  return {
    schema: PLUGIN_STATE_SCHEMA,
    plugin: "malahor",
    pluginVersion: PLUGIN_VERSION,
    host: "v2",
    capabilities: { session: true, permission: true },
    degraded: [],
    criticalGaps: [],
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  };
}

function writeState(ctx: PluginHealthContext, state: PluginStateSnapshot, mode = 0o600): void {
  writeJson(ctx.paths.pluginState, state, mode);
}

describe("deteccion de host OpenCode", () => {
  test("parsea la version del CLI y clasifica V1/V2", () => {
    expect(parseOpenCodeVersion("2.0.32")).toBe("2.0.32");
    expect(parseOpenCodeVersion("opencode v1.14.20\n")).toBe("1.14.20");
    expect(parseOpenCodeVersion("sin version")).toBeNull();

    expect(hostKindForVersion("2.0.32")).toBe("v2");
    expect(hostKindForVersion("1.14.20")).toBe("v1");
    expect(hostKindForVersion("3.0.0")).toBe("unknown");
  });

  test("detecta con runner inyectado y degrada a unknown sin romper", () => {
    const paths = pathsFor(tempDir());

    expect(detectOpenCodeHost(paths, { runVersion: () => "opencode 2.0.32" })).toEqual({ kind: "v2", version: "2.0.32" });
    expect(detectOpenCodeHost(paths, { runVersion: () => "1.14.20" })).toEqual({ kind: "v1", version: "1.14.20" });
    expect(detectOpenCodeHost(paths, { runVersion: () => { throw new Error("boom"); } })).toMatchObject({ kind: "unknown", version: null, error: "boom" });
    expect(detectOpenCodeHost(paths, { runVersion: () => "sin version" })).toMatchObject({ kind: "unknown", version: null });
  });
});

describe("salud del SDK de OpenCode", () => {
  test("V2 con pin exacto e instalado queda OK y reconoce ownership", () => {
    const ctx = context(tempDir());
    writePackage(ctx.paths, { [OPENCODE_SDK_PACKAGE]: OPENCODE_SDK_PIN });
    writeInstalled(ctx.paths, OPENCODE_SDK_PACKAGE, OPENCODE_SDK_PIN);
    writeJson(ctx.paths.opencodeSdkState, {
      package: OPENCODE_SDK_PACKAGE,
      pinnedVersion: OPENCODE_SDK_PIN,
      addedDependency: true,
      createdPackageJson: false,
      installedWith: "bun",
      updatedAt: "2026-10-19T00:00:00.000Z",
    });

    const check = inspectOpenCodeSdk(ctx);

    expect(check.status).toBe("ok");
    expect(check.message).toContain("pin exacto");
    expect(check.message).toContain("ownership Malahor");
  });

  test("V2 con version mayor o rango que cumple el piso avisa, no falla", () => {
    const higher = context(tempDir());
    writePackage(higher.paths, { [OPENCODE_SDK_PACKAGE]: "2.0.32" });
    writeInstalled(higher.paths, OPENCODE_SDK_PACKAGE, "2.0.32");
    expect(inspectOpenCodeSdk(higher).status).toBe("warn");

    const range = context(tempDir());
    writePackage(range.paths, { [OPENCODE_SDK_PACKAGE]: "^2.0.4" });
    writeInstalled(range.paths, OPENCODE_SDK_PACKAGE, "2.5.0");
    expect(inspectOpenCodeSdk(range).status).toBe("warn");
  });

  test("V2 falla sin package.json, sin dependencia, bajo piso o sin node_modules", () => {
    const missingPackage = context(tempDir());
    expect(inspectOpenCodeSdk(missingPackage).status).toBe("fail");

    const missingDependency = context(tempDir());
    writePackage(missingDependency.paths, {});
    expect(inspectOpenCodeSdk(missingDependency).status).toBe("fail");

    const belowFloor = context(tempDir());
    writePackage(belowFloor.paths, { [OPENCODE_SDK_PACKAGE]: "1.0.0" });
    writeInstalled(belowFloor.paths, OPENCODE_SDK_PACKAGE, "1.0.0");
    expect(inspectOpenCodeSdk(belowFloor).status).toBe("fail");

    const missingInstalled = context(tempDir());
    writePackage(missingInstalled.paths, { [OPENCODE_SDK_PACKAGE]: OPENCODE_SDK_PIN });
    expect(inspectOpenCodeSdk(missingInstalled).status).toBe("fail");
  });

  test("V2 con JSON invalido falla sin intentar reparar", () => {
    const ctx = context(tempDir());
    fs.mkdirSync(ctx.paths.opencodeDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.paths.opencodeDir, "package.json"), "{ roto", "utf8");

    const check = inspectOpenCodeSdk(ctx);

    expect(check.status).toBe("fail");
    expect(check.message).toContain("invalido");
  });

  test("V1 conserva el SDK V1 y avisa si falta el pin V2", () => {
    const ok = context(tempDir(), { kind: "v1", version: "1.14.20" });
    writePackage(ok.paths, { [V1_SDK]: "1.14.20", [OPENCODE_SDK_PACKAGE]: OPENCODE_SDK_PIN });
    writeInstalled(ok.paths, V1_SDK, "1.14.20");
    writeInstalled(ok.paths, OPENCODE_SDK_PACKAGE, OPENCODE_SDK_PIN);
    expect(inspectOpenCodeSdk(ok).status).toBe("ok");

    const withoutV2 = context(tempDir(), { kind: "v1", version: "1.14.20" });
    writePackage(withoutV2.paths, { [V1_SDK]: "1.14.20" });
    writeInstalled(withoutV2.paths, V1_SDK, "1.14.20");
    const check = inspectOpenCodeSdk(withoutV2);
    expect(check.status).toBe("warn");
    expect(check.message).toContain("sin pin V2");
  });
});

describe("salud del plugin gestionado", () => {
  test("V2 sin plugins dir o sin plugin falla", () => {
    const noDir = context(tempDir());
    expect(inspectPluginsDir(noDir).status).toBe("fail");
    expect(inspectManagedPlugin(noDir).status).toBe("fail");

    const noPlugin = context(tempDir());
    writePluginAsset(noPlugin);
    expect(inspectManagedPlugin(noPlugin).status).toBe("fail");
  });

  test("V2 con asset y archivo gestionado identico queda OK", () => {
    const ctx = context(tempDir());
    writePluginAsset(ctx);
    writeInstalledPlugin(ctx);

    expect(inspectPluginsDir(ctx).status).toBe("ok");
    const check = inspectManagedPlugin(ctx);
    expect(check.status).toBe("ok");
    expect(check.message).toContain(`v${PLUGIN_VERSION}`);
  });

  test("V2 con archivo ajeno falla y no propone pisarlo", () => {
    const ctx = context(tempDir());
    writePluginAsset(ctx);
    writeInstalledPlugin(ctx, "// plugin del usuario\nexport default {};\n");

    const check = inspectManagedPlugin(ctx);

    expect(check.status).toBe("fail");
    expect(check.message).toContain("ajeno");
    expect(check.message).toContain("no se pisa");
  });

  test("plugin gestionado desactualizado avisa; V1 no escala a fallo", () => {
    const ctx = context(tempDir());
    writePluginAsset(ctx, pluginContent("0.3.0"));
    writeInstalledPlugin(ctx, pluginContent("0.2.0"));
    expect(inspectManagedPlugin(ctx).status).toBe("warn");

    const v1 = context(tempDir(), { kind: "v1", version: "1.14.20" });
    expect(inspectManagedPlugin(v1).status).toBe("warn");
  });

  test("parsePluginVersion lee la constante del asset", () => {
    expect(parsePluginVersion(pluginContent("9.9.9"))).toBe("9.9.9");
    expect(parsePluginVersion("export default {}")).toBeNull();
  });
});

describe("estado del plugin", () => {
  test("estado ausente es WARN por carga lazy, no FAIL", () => {
    const ctx = context(tempDir());

    const check = inspectPluginState(ctx);

    expect(check.status).toBe("warn");
    expect(check.message).toContain("lazy");
    expect(check.message).toContain("no se fabrica estado");
  });

  test("estado V2 valido queda OK y respeta 0600", () => {
    const ctx = context(tempDir());
    writeState(ctx, validState());

    const check = inspectPluginState(ctx);

    expect(check.status).toBe("ok");
    expect(check.message).toContain("caps 2/2");
  });

  test("criticalGaps falla en V2 y solo avisa en V1", () => {
    const v2 = context(tempDir());
    writeState(v2, validState({ criticalGaps: ["permission.hook"] }));
    expect(inspectPluginState(v2).status).toBe("fail");

    const v1 = context(tempDir(), { kind: "v1", version: "1.14.20" });
    writeState(v1, validState({ host: "v1", criticalGaps: ["permission.hook"] }));
    expect(inspectPluginState(v1).status).toBe("warn");
  });

  test("degradadas, host distinto, version distinta y permisos amplios avisan", () => {
    const ctx = context(tempDir());
    writeInstalledPlugin(ctx);
    writeState(ctx, validState({
      degraded: ["mcp"],
      host: "v1",
      pluginVersion: "0.1.0",
    }), 0o644);

    const check = inspectPluginState(ctx);

    expect(check.status).toBe("warn");
    expect(check.message).toContain("degraded=mcp");
    expect(check.message).toContain("host estado=v1");
    expect(check.message).toContain("version estado=0.1.0");
    if (process.platform !== "win32") {
      expect(check.message).toContain("permisos 644");
    }
  });

  test("estado invalido o schema desconocido es WARN", () => {
    const invalid = context(tempDir());
    fs.mkdirSync(path.dirname(invalid.paths.pluginState), { recursive: true });
    fs.writeFileSync(invalid.paths.pluginState, "{ roto", "utf8");
    expect(inspectPluginState(invalid).status).toBe("warn");

    expect(parsePluginState({ ...validState(), schema: 99 })).toBeNull();
    expect(parsePluginState({ ...validState(), plugin: "otro" })).toBeNull();
  });

  test("pluginHealthChecks compone SDK, dir, plugin y estado", () => {
    const ctx = context(tempDir());
    writePackage(ctx.paths, { [OPENCODE_SDK_PACKAGE]: OPENCODE_SDK_PIN });
    writeInstalled(ctx.paths, OPENCODE_SDK_PACKAGE, OPENCODE_SDK_PIN);
    writePluginAsset(ctx);
    writeInstalledPlugin(ctx);
    writeState(ctx, validState());

    expect(pluginHealthChecks(ctx).map((check) => check.name)).toEqual([
      "OpenCode SDK",
      "OpenCode plugins dir",
      "Plugin Malahor",
      "Plugin state",
    ]);
  });
});
