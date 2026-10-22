import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { hookDefaultPolicyPath, hookProjectPolicyPath, loadHookPolicy, saveHookProfile } from "../src/cli/core/hooks/policy-loader";
import { mergeSecurityLayers, unenforcedControlPaths, validateSecurityLayer } from "../src/cli/core/hooks/security-policy";
import type { SecurityLayer } from "../src/cli/core/hooks/types";
import { resolvePaths } from "../src/cli/core/paths";

const NO_CORPORATE = { corporatePath: null } as const;

function fixturePaths() {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-policy-"));
  return resolvePaths({ HOME: root, MALAHOR_HOME: path.join(root, ".malahor") }, root);
}

function securityLayer(overrides: Partial<SecurityLayer> = {}): SecurityLayer {
  return {
    schemaVersion: 1,
    contractVersion: 1,
    policyVersion: "2026-10-21.1",
    issuer: "test",
    issuedAt: "2026-10-21T00:00:00.000Z",
    controls: {},
    ...overrides,
  };
}

function sampleFromSchema(schema: Record<string, unknown>, defs: Record<string, unknown>, key = ""): unknown {
  if (typeof schema.$ref === "string") {
    return sampleFromSchema(defs[schema.$ref.split("/").at(-1) ?? ""] as Record<string, unknown>, defs, key);
  }
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (key === "issuedAt") return "2026-10-21T00:00:00.000Z";
  if (schema.type === "boolean") return false;
  if (schema.type === "integer") return 1;
  if (schema.type === "string") return "sample";
  if (schema.type === "array") return [];
  if (schema.type === "object") {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    return Object.fromEntries(Object.entries(properties ?? {}).map(([name, value]) => [name, sampleFromSchema(value, defs, name)]));
  }
  return null;
}

describe("hook policy loader", () => {
  test("usa standard por defecto sin archivos", () => {
    const paths = fixturePaths();
    const loaded = loadHookPolicy(paths, "malahor", undefined, NO_CORPORATE);

    expect(loaded.policy.profile).toBe("standard");
    expect(loaded.policy.git.validateCommitMessage).toBe(true);
    expect(loaded.policy.git.requireChecksBeforePush).toBe(false);
    expect(loaded.sources).toEqual([]);
  });

  test("perfil release default exige checks antes de push", () => {
    const paths = fixturePaths();
    saveHookProfile(paths, "release");
    const loaded = loadHookPolicy(paths, "malahor", undefined, NO_CORPORATE);

    expect(loaded.sources).toEqual([hookDefaultPolicyPath(paths)]);
    expect(loaded.policy.profile).toBe("release");
    expect(loaded.policy.git.requireChecksBeforePush).toBe(true);
  });

  test("perfil por proyecto sobreescribe default", () => {
    const paths = fixturePaths();
    saveHookProfile(paths, "release");
    saveHookProfile(paths, "light", "flowin");
    const loaded = loadHookPolicy(paths, "flowin", undefined, NO_CORPORATE);

    expect(loaded.sources).toEqual([hookDefaultPolicyPath(paths), hookProjectPolicyPath(paths, "flowin")]);
    expect(loaded.policy.profile).toBe("light");
    expect(loaded.policy.git.requireChecksBeforePush).toBe(false);
  });

  test("override CLI gana sobre archivos", () => {
    const paths = fixturePaths();
    saveHookProfile(paths, "release");
    const loaded = loadHookPolicy(paths, "malahor", "off", NO_CORPORATE);

    expect(loaded.policy.profile).toBe("off");
    expect(loaded.policy.git.blockDestructiveCommands).toBe(true);
    expect(loaded.policy.secrets.scanBeforeCommit).toBe(true);
    expect(loaded.policy.memory.destructiveRequiresPreview).toBe(true);
  });

  test("v1 sin schemaVersion no se confunde con v0", () => {
    const paths = fixturePaths();
    const filePath = hookDefaultPolicyPath(paths);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      contractVersion: 1,
      policyVersion: "2026-10-21.1",
      issuer: "test",
      issuedAt: "2026-10-21T00:00:00.000Z",
      controls: { git: { requireChecksBeforePush: true } },
    }), "utf8");

    const loaded = loadHookPolicy(paths, "malahor", undefined, NO_CORPORATE);

    expect(loaded.policy.git.requireChecksBeforePush).toBe(false);
    expect(loaded.warnings.some((warning) => warning.includes("schemaVersion"))).toBe(true);
  });

  test("local intenta aflojar el suelo y se conserva con warning", () => {
    const paths = fixturePaths();
    const filePath = hookDefaultPolicyPath(paths);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      profile: "standard",
      git: { blockDestructiveCommands: false },
      secrets: { scanBeforeCommit: false },
    }), "utf8");

    const loaded = loadHookPolicy(paths, "malahor", undefined, NO_CORPORATE);

    expect(loaded.policy.git.blockDestructiveCommands).toBe(true);
    expect(loaded.policy.secrets.scanBeforeCommit).toBe(true);
    expect(loaded.warnings.some((warning) => warning.includes("git.blockDestructiveCommands"))).toBe(true);
    expect(loaded.warnings.some((warning) => warning.includes("secrets.scanBeforeCommit"))).toBe(true);
  });

  test("politica v1 local aplica controles y calcula hash estable", () => {
    const paths = fixturePaths();
    const filePath = hookDefaultPolicyPath(paths);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      contractVersion: 1,
      policyVersion: "2026-10-21.1",
      issuer: "test",
      issuedAt: "2026-10-21T00:00:00.000Z",
      controls: {
        git: { requireChecksBeforePush: true },
      },
    }), "utf8");

    const loaded = loadHookPolicy(paths, "malahor", undefined, NO_CORPORATE);
    const again = loadHookPolicy(paths, "malahor", undefined, NO_CORPORATE);

    expect(loaded.sources).toEqual([filePath]);
    expect(loaded.policy.git.requireChecksBeforePush).toBe(true);
    expect(loaded.security.git?.requireChecksBeforePush).toBe(true);
    expect(loaded.policyMeta.sources.some((source) => source.kind === "local" && source.schemaVersion === 1)).toBe(true);
    expect(loaded.policyHash).toBe(again.policyHash);
  });

  test("campo desconocido local se ignora con warning", () => {
    const paths = fixturePaths();
    const filePath = hookDefaultPolicyPath(paths);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      contractVersion: 1,
      policyVersion: "2026-10-21.1",
      issuer: "test",
      issuedAt: "2026-10-21T00:00:00.000Z",
      controls: {
        git: { requireChecksBeforePush: true, controlInventado: true },
      },
      extra: true,
    }), "utf8");

    const loaded = loadHookPolicy(paths, "malahor", undefined, NO_CORPORATE);

    expect(loaded.policy.git.requireChecksBeforePush).toBe(true);
    expect(loaded.warnings.some((warning) => warning.includes("controlInventado"))).toBe(true);
    expect(loaded.warnings.some((warning) => warning.includes("extra"))).toBe(true);
  });

  test("merge v1 es monotono y conserva allowlists intersectadas", () => {
    const corporate = securityLayer({
      controls: {
        git: { blockDestructive: true },
        files: { allowedReadRoots: ["/repo", "/shared"] },
      },
    });
    const local = securityLayer({
      controls: {
        git: { blockDestructive: false },
        files: { allowedReadRoots: ["/repo", "/tmp"] },
      },
    });

    const merged = mergeSecurityLayers([
      { layer: corporate, source: { kind: "corporate", authority: 1, status: "valid" } },
      { layer: local, source: { kind: "local", authority: 3, status: "valid" } },
    ]);

    expect(merged.controls.git?.blockDestructive).toBe(true);
    expect(merged.controls.files?.allowedReadRoots).toEqual(["/repo"]);
    expect(merged.warnings.some((warning) => warning.includes("blockDestructive"))).toBe(true);
  });

  test("solo exige mediacion para controles habilitados, no para configuracion", () => {
    const configured = securityLayer({
      controls: {
        audit: { path: "/var/log/malahor/audit.jsonl" },
        host: { declaredLimits: ["V1 no cubre Code Mode"] },
      },
    });
    const required = securityLayer({
      controls: {
        audit: { required: true, path: "/var/log/malahor/audit.jsonl" },
        host: { requiredControls: ["git.blockDestructive", "git.requirePushApproval"] },
      },
    });

    expect(unenforcedControlPaths(configured)).toEqual([]);
    expect(unenforcedControlPaths(required)).not.toContain("audit.required");
    expect(unenforcedControlPaths(required)).not.toContain("audit.path");
    expect(unenforcedControlPaths(required)).not.toContain("host.required[git.blockDestructive]");
    expect(unenforcedControlPaths(required)).toContain("host.required[git.requirePushApproval]");
  });

  test("acepta todas las claves del schema v1", () => {
    const schema = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "docs/security/policy.schema.json"), "utf8")) as Record<string, unknown>;
    const value = sampleFromSchema(schema, schema.$defs as Record<string, unknown>);
    const result = validateSecurityLayer(value, { strict: true });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("valida const del esquema v1", () => {
    const valid = validateSecurityLayer(securityLayer({
      controls: {
        approval: { askWithoutChannel: "deny" },
        audit: { includePayloads: false },
        host: { doctorMayCertify: false },
      },
    }), { strict: true });

    const invalid = validateSecurityLayer(securityLayer({
      controls: {
        audit: { includePayloads: true as never },
      },
    }), { strict: true });

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.some((error) => error.includes("audit.includePayloads"))).toBe(true);
  });

  test("politica corporativa presente pero no confiable falla cerrada", () => {
    const paths = fixturePaths();
    const corporatePath = path.join(paths.home, "corporate.json");
    fs.writeFileSync(corporatePath, JSON.stringify(securityLayer()), "utf8");

    const loaded = loadHookPolicy(paths, "malahor", undefined, {
      corporatePath,
      corporateRequired: true,
      platform: "linux",
      env: {},
    });

    expect(loaded.policyMeta.corporateStatus).toBe("untrusted");
    expect(loaded.policyMeta.corporateRequired).toBe(true);
    expect(loaded.warnings.some((warning) => warning.includes("no confiable"))).toBe(true);
  });

  test("politica corporativa obligatoria ausente falla cerrada", () => {
    const paths = fixturePaths();
    const missing = path.join(paths.home, "missing-corporate.json");

    const loaded = loadHookPolicy(paths, "malahor", undefined, {
      corporatePath: missing,
      corporateRequired: true,
      platform: "linux",
      env: {},
    });

    expect(loaded.policyMeta.corporateStatus).toBe("required-missing");
    expect(loaded.policyMeta.corporateRequired).toBe(true);
  });

  test("config invalida genera warning y cae a defaults", () => {
    const paths = fixturePaths();
    const filePath = hookDefaultPolicyPath(paths);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ profile: "romper" }), "utf8");

    const loaded = loadHookPolicy(paths, "malahor", undefined, NO_CORPORATE);

    expect(loaded.warnings.length).toBe(1);
    expect(loaded.policy.profile).toBe("standard");
  });
});
