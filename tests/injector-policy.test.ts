import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { syncOpenCodeConfig } from "../src/cli/core/injector";
import { resolvePaths, type MalahorPaths } from "../src/cli/core/paths";

let root: string;
let paths: MalahorPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-injector-policy-"));
  const opencode = path.join(root, "opencode");
  fs.mkdirSync(opencode, { recursive: true });
  paths = resolvePaths({
    ...process.env,
    MALAHOR_HOME: path.join(root, "home"),
    MALAHOR_OPENCODE_DIR: opencode,
    MALAHOR_OPENCODE_DETECT: "0",
  }, root);
});

function writeConfig(agent: Record<string, unknown>): void {
  fs.writeFileSync(paths.opencodeConfig, `${JSON.stringify({ agent: { build: agent } }, null, 2)}\n`, "utf8");
}

function readBuild(): Record<string, unknown> {
  const config = JSON.parse(fs.readFileSync(paths.opencodeConfig, "utf8")) as {
    agent?: { build?: Record<string, unknown> };
  };
  return config.agent?.build ?? {};
}

describe("inyeccion de politica de build", () => {
  test("guiar no escribe permission.bash cuando no existia", () => {
    writeConfig({});

    syncOpenCodeConfig(paths, {
      execution: { intervention: "guiar", verification: true },
      applyPolicy: true,
    }, false);

    const permission = readBuild().permission as Record<string, unknown>;
    expect(permission).toMatchObject({ edit: "deny", task: "deny" });
    expect(permission.bash).toBeUndefined();
  });

  test("guiar conserva la whitelist legacy sin reescribirla", () => {
    const legacy = { "*": "deny", "git status*": "allow" };
    writeConfig({ permission: { bash: legacy } });

    syncOpenCodeConfig(paths, {
      execution: { intervention: "acompanar", verification: true },
      applyPolicy: true,
    }, false);

    const permission = readBuild().permission as Record<string, unknown>;
    expect(permission.bash).toEqual(legacy);
    expect(permission.edit).toBe("deny");
    expect(permission.task).toBe("deny");
  });

  test("ejecutar conserva la whitelist legacy y retira solo edit/task de Malahor", () => {
    const legacy = { "*": "deny", "git status*": "allow" };
    writeConfig({ permission: { bash: legacy, edit: "deny", task: "deny", webfetch: "ask" } });

    syncOpenCodeConfig(paths, {
      execution: { intervention: "ejecutar", verification: false },
      applyPolicy: true,
    }, false);

    const permission = readBuild().permission as Record<string, unknown>;
    expect(permission.bash).toEqual(legacy);
    expect(permission.edit).toBeUndefined();
    expect(permission.task).toBeUndefined();
    expect(permission.webfetch).toBe("ask");
  });
});
