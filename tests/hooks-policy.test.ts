import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { hookDefaultPolicyPath, hookProjectPolicyPath, loadHookPolicy, saveHookProfile } from "../src/cli/core/hooks/policy-loader";
import { resolvePaths } from "../src/cli/core/paths";

function fixturePaths() {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-policy-"));
  return resolvePaths({ HOME: root, MALAHOR_HOME: path.join(root, ".malahor") }, root);
}

describe("hook policy loader", () => {
  test("usa standard por defecto sin archivos", () => {
    const paths = fixturePaths();
    const loaded = loadHookPolicy(paths, "malahor");

    expect(loaded.policy.profile).toBe("standard");
    expect(loaded.policy.git.validateCommitMessage).toBe(true);
    expect(loaded.policy.git.requireChecksBeforePush).toBe(false);
    expect(loaded.sources).toEqual([]);
  });

  test("perfil release default exige checks antes de push", () => {
    const paths = fixturePaths();
    saveHookProfile(paths, "release");
    const loaded = loadHookPolicy(paths, "malahor");

    expect(loaded.sources).toEqual([hookDefaultPolicyPath(paths)]);
    expect(loaded.policy.profile).toBe("release");
    expect(loaded.policy.git.requireChecksBeforePush).toBe(true);
  });

  test("perfil por proyecto sobreescribe default", () => {
    const paths = fixturePaths();
    saveHookProfile(paths, "release");
    saveHookProfile(paths, "light", "flowin");
    const loaded = loadHookPolicy(paths, "flowin");

    expect(loaded.sources).toEqual([hookDefaultPolicyPath(paths), hookProjectPolicyPath(paths, "flowin")]);
    expect(loaded.policy.profile).toBe("light");
    expect(loaded.policy.git.requireChecksBeforePush).toBe(false);
  });

  test("override CLI gana sobre archivos", () => {
    const paths = fixturePaths();
    saveHookProfile(paths, "release");
    const loaded = loadHookPolicy(paths, "malahor", "off");

    expect(loaded.policy.profile).toBe("off");
    expect(loaded.policy.git.blockDestructiveCommands).toBe(false);
  });

  test("config invalida genera warning y cae a defaults", () => {
    const paths = fixturePaths();
    const filePath = hookDefaultPolicyPath(paths);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ profile: "romper" }), "utf8");

    const loaded = loadHookPolicy(paths, "malahor");

    expect(loaded.warnings.length).toBe(1);
    expect(loaded.policy.profile).toBe("standard");
  });
});
