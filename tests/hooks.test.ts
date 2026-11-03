import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { assertHooksAllowed, evaluateHookRules, formatHookResult, hookExitCode, runHooks } from "../src/cli/core/hooks/engine";
import { buildSecretPatchSummary, detectFileSecretCounts, detectFileSecretFindings } from "../src/cli/core/hooks/secret-scan";
import {
  HOOK_EVENTS,
  HOOK_RESOURCE_KINDS,
  type HookContext,
  type HookPolicyMeta,
  type HookResult,
  type HookRule,
  type HookViolation,
} from "../src/cli/core/hooks/types";
import { callTool } from "../src/mnemo/tools";

const baseContext = (overrides: Partial<HookContext>): HookContext => ({
  event: "git.commit.before",
  harness: "cli",
  profile: "standard",
  cwd: process.cwd(),
  projectRoot: process.cwd(),
  malahorHome: path.join(process.cwd(), ".sandbox", "home", ".malahor"),
  audit: { enabled: false },
  ...overrides,
});

const policyMeta = (overrides: Partial<HookPolicyMeta>): HookPolicyMeta => ({
  contractVersion: 1,
  schemaVersion: 1,
  policyVersion: "test",
  issuer: "test",
  policyHash: "test",
  sources: [],
  corporateStatus: "absent",
  corporateRequired: false,
  criticalGaps: [],
  warnings: [],
  ...overrides,
});

const BLOCK_CLASSES = [
  "approval-required",
  "remediable-deny",
  "control-unavailable",
  "hard-deny",
  "advisory",
] as const;

type BlockClassContract = typeof BLOCK_CLASSES[number];

function violationContract(result: HookResult, id: string): (HookViolation & { blockClass?: unknown }) | undefined {
  return result.violations.find((violation) => violation.id === id) as
    | (HookViolation & { blockClass?: unknown })
    | undefined;
}

function expectBlockClass(result: HookResult, id: string, expected: BlockClassContract): void {
  const violation = violationContract(result, id);
  expect(violation, `falta la violación ${id}`).toBeDefined();
  expect(violation?.blockClass).toBe(expected);
  expect(BLOCK_CLASSES).toContain(violation?.blockClass as BlockClassContract);
}

describe("malahor hooks", () => {
  test("el CLI expone los eventos del runtime V2", () => {
    const events = new Set<string>(HOOK_EVENTS);
    for (const event of [
      "shell.exec.before",
      "file.read.before",
      "file.write.before",
      "tool.execute.before",
      "session.prompt.before",
      "plugin.permission.before",
      "codegraph.index.before",
    ]) {
      expect(events.has(event)).toBe(true);
    }
    expect(events.has("graphify.generate.before")).toBe(false);
    expect(events.has("obsidian.write.before")).toBe(false);
    expect(HOOK_RESOURCE_KINDS).toEqual(["filesystem"]);
  });

  test("deniega el resourceKind legacy y solo acepta rutas filesystem", () => {
    const result = runHooks(baseContext({
      event: "file.write.before",
      resourceKind: "obsidian-vault" as unknown as HookContext["resourceKind"],
      targetPaths: ["Product/pm/plan-fase-5.md"],
      metadata: { writesMalahorData: true },
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-RESOURCE-KIND")).toBe(true);
  });

  test("el CLI rechaza el evento y resourceKind retirados de Obsidian", () => {
    const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hook-cli-resource-"));
    try {
      const env = {
        ...process.env,
        MALAHOR_HOME: path.join(root, "home"),
        MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
        MALAHOR_OPENCODE_DETECT: "0",
      };
      const retiredEvent = Bun.spawnSync([
        "bun", "run", "src/cli/index.ts", "hooks", "check", "obsidian.write.before", "--json",
      ], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
      const retiredKind = Bun.spawnSync([
        "bun", "run", "src/cli/index.ts", "hooks", "check", "file.write.before",
        "--resource-kind", "obsidian-vault", "--json",
      ], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });

      expect(retiredEvent.exitCode).toBe(1);
      expect(retiredEvent.stderr.toString()).toMatch(/Evento hook invalido/i);
      expect(retiredKind.exitCode).toBe(1);
      expect(retiredKind.stderr.toString()).toMatch(/Tipo de recurso invalido.*filesystem/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("mantiene el limite del repo para recursos fisicos de Malahor", () => {
    const result = runHooks(baseContext({
      event: "memory.write.before",
      targetPaths: ["src/datos-operativos.json"],
      metadata: { writesMalahorData: true },
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-REPO-BOUNDARY")).toBe(true);
  });

  test("presenta target y pide aprobacion para Git local destructivo", () => {
    const result = runHooks(baseContext({
      event: "git.reset.before",
      command: "git reset --hard HEAD~1",
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
    expect(result.violations.some((violation) => violation.message.includes("HEAD~1"))).toBe(true);
  });

  test("bloquea secretos antes de stage/commit", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-"));
    const secretFile = path.join(dir, ".env");
    fs.writeFileSync(secretFile, `${"API"}_KEY='12345678901234567890'\n`, "utf8");

    const result = runHooks(baseContext({
      event: "file.stage.before",
      cwd: dir,
      projectRoot: dir,
      targetPaths: [".env"],
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(true);
  });

  test("lectura y stage siguen denegando un archivo con hallazgos", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-secret-events-"));
    const target = path.join(dir, "fixture.ts");
    const identifier = ["api", "key"].join("_");
    const syntheticValue = ["synthetic", "0123456789abcdef"].join("-");
    fs.writeFileSync(target, `export const ${identifier} = '${syntheticValue}';\n`, "utf8");

    try {
      for (const event of ["file.read.before", "file.stage.before"] as const) {
        const result = runHooks(baseContext({
          event,
          cwd: dir,
          projectRoot: dir,
          targetPaths: [target],
        }));

        expect(result.decision).toBe("deny");
        expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("entrega un bloque saneado y copiable para un fixture sintetico reconocido", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-remediation-"));
    const target = path.join(dir, "tests", "fixtures", "redaction.test.ts");
    const identifier = ["api", "key"].join("_");
    const syntheticValue = ["synthetic", "0123456789abcdef"].join("-");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `const redactionProbe = "${identifier}='${syntheticValue}'";\n`, "utf8");

    try {
      const result = runHooks(baseContext({
        event: "file.read.before",
        cwd: dir,
        projectRoot: dir,
        targetPaths: [target],
      }));
      const violation = result.violations.find((item) => item.id === "MAL-HOOK-SECRETS");
      const remediation = violation?.remediations?.find((item) => item.kind === "replace-block");

      expect(result.decision).toBe("deny");
      expect(remediation).toMatchObject({
        version: 1,
        kind: "replace-block",
        reason: "synthetic-test-fixture",
        path: "tests/fixtures/redaction.test.ts",
        startLine: 1,
        endLine: 1,
        anchor: "redactionProbe",
        revalidate: true,
      });
      expect(remediation?.before.join("\n")).toContain("[VALOR SINTETICO OCULTO]");
      expect(remediation?.replacement.join("\n")).toContain('["api", "key"].join("_")');
      expect(remediation?.replacement.join("\n")).toContain('["synthetic", "fixture", "credential"].join("-")');
      expect(JSON.stringify(result)).not.toContain(syntheticValue);

      const output = formatHookResult(result);
      expect(output).toMatch(/abre tests\/fixtures\/redaction\.test\.ts:1/i);
      expect(output).toMatch(/reemplaza esa linea o bloque completo/i);
      expect(output).toMatch(/guarda.*revalidar/i);
      expect(output).not.toContain(syntheticValue);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("un valor real o ambiguo mantiene DENY sin bloque de reemplazo", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-real-secret-"));
    const target = path.join(dir, "tests", "fixtures", "unsafe.test.ts");
    const identifier = ["access", "token"].join("_");
    const unsafeValue = ["production", "fedcba9876543210"].join("-");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `export const ${identifier} = '${unsafeValue}';\n`, "utf8");

    try {
      const result = runHooks(baseContext({
        event: "file.read.before",
        cwd: dir,
        projectRoot: dir,
        targetPaths: [target],
      }));
      const violation = result.violations.find((item) => item.id === "MAL-HOOK-SECRETS");

      expect(result.decision).toBe("deny");
      expect(violation?.remediations?.some((item) => item.kind === "replace-block")).toBe(false);
      expect(violation?.remediations).toContainEqual(expect.objectContaining({
        kind: "remove-secret",
        reason: "value-not-demonstrably-synthetic",
        path: "tests/fixtures/unsafe.test.ts",
        startLine: 1,
      }));
      expect(formatHookResult(result)).toContain("value-not-demonstrably-synthetic");
      expect(formatHookResult(result)).toMatch(/retira la credencial.*rotalo/is);
      expect(JSON.stringify(result)).not.toContain(unsafeValue);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("un formato de fixture no soportado no recibe codigo de reemplazo", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-ambiguous-fixture-"));
    const target = path.join(dir, "tests", "fixtures", "credentials.env");
    const identifier = ["api", "key"].join("_");
    const syntheticValue = ["synthetic", "0123456789abcdef"].join("-");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${identifier}='${syntheticValue}'\n`, "utf8");

    try {
      const result = runHooks(baseContext({
        event: "file.read.before",
        cwd: dir,
        projectRoot: dir,
        targetPaths: [target],
      }));
      const remediations = result.violations.flatMap((item) => item.remediations ?? []);

      expect(result.decision).toBe("deny");
      expect(remediations.some((item) => item.kind === "replace-block")).toBe(false);
      expect(remediations).toContainEqual(expect.objectContaining({
        kind: "remove-secret",
        reason: "unsupported-file-type",
        startLine: 1,
      }));
      expect(JSON.stringify(result)).not.toContain(syntheticValue);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("genera una receta para una asignacion sintetica dentro de una expresion compleja", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-complex-fixture-"));
    const target = path.join(dir, "tests", "fixtures", "request.test.ts");
    const identifier = ["api", "key"].join("_");
    const syntheticValue = ["synthetic", "0123456789abcdef"].join("-");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `const request = { metadata: "prefix ${identifier}='${syntheticValue}' suffix" };\n`,
      "utf8",
    );

    try {
      const result = runHooks(baseContext({
        event: "file.read.before",
        cwd: dir,
        projectRoot: dir,
        targetPaths: [target],
      }));
      const remediation = result.violations
        .flatMap((item) => item.remediations ?? [])
        .find((item) => item.kind === "replace-block");

      expect(result.decision).toBe("deny");
      expect(remediation).toMatchObject({
        kind: "replace-block",
        reason: "synthetic-test-fixture",
        path: "tests/fixtures/request.test.ts",
        startLine: 1,
        anchor: "metadata",
      });
      expect(remediation?.before.join("\n")).toContain("[VALOR SINTETICO OCULTO]");
      expect(remediation?.replacement.join("\n")).toContain('"prefix "');
      expect(remediation?.replacement.join("\n")).toContain("\"' suffix\"");
      expect(remediation?.replacement.join("\n")).toContain('["api", "key"].join("_")');
      expect(JSON.stringify(result)).not.toContain(syntheticValue);

      fs.writeFileSync(target, `${remediation?.replacement.join("\n")}\n`, "utf8");
      const revalidated = runHooks(baseContext({
        event: "file.read.before",
        cwd: dir,
        projectRoot: dir,
        targetPaths: [target],
      }));
      expect(revalidated.decision).toBe("allow");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rechaza una linea sintetica con varios hallazgos como ambigua", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-multiple-fixture-"));
    const target = path.join(dir, "tests", "fixtures", "multiple.test.ts");
    const firstIdentifier = ["api", "key"].join("_");
    const secondIdentifier = ["access", "token"].join("_");
    const firstValue = ["synthetic", "0123456789abcdef"].join("-");
    const secondValue = ["synthetic", "fedcba9876543210"].join("-");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `const values = ["${firstIdentifier}='${firstValue}'", "${secondIdentifier}='${secondValue}'"];\n`,
      "utf8",
    );

    try {
      const result = runHooks(baseContext({
        event: "file.read.before",
        cwd: dir,
        projectRoot: dir,
        targetPaths: [target],
      }));
      const remediations = result.violations.flatMap((item) => item.remediations ?? []);

      expect(result.decision).toBe("deny");
      expect(remediations).toHaveLength(2);
      expect(remediations.every((item) => item.kind === "remove-secret"
        && item.reason === "multiple-findings")).toBe(true);
      expect(JSON.stringify(result)).not.toContain(firstValue);
      expect(JSON.stringify(result)).not.toContain(secondValue);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rechaza una cadena sintetica usada como clave porque el reemplazo seria invalido", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-key-fixture-"));
    const target = path.join(dir, "tests", "fixtures", "object-key.test.ts");
    const identifier = ["secret", "key"].join("_");
    const syntheticValue = ["synthetic", "0123456789abcdef"].join("-");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `const values = { "${identifier}='${syntheticValue}'": true };\n`, "utf8");

    try {
      const result = runHooks(baseContext({
        event: "file.read.before",
        cwd: dir,
        projectRoot: dir,
        targetPaths: [target],
      }));
      const remediations = result.violations.flatMap((item) => item.remediations ?? []);

      expect(result.decision).toBe("deny");
      expect(remediations).toContainEqual(expect.objectContaining({
        kind: "remove-secret",
        reason: "unsupported-syntax",
      }));
      expect(remediations.some((item) => item.kind === "replace-block")).toBe(false);
      expect(JSON.stringify(result)).not.toContain(syntheticValue);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no confunde un placeholder multilinea del codigo con una credencial", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-source-"));
    const sourceFile = path.join(dir, "integration.ts");
    fs.writeFileSync(sourceFile, 'throw new Error("SERVICE_API_KEY: ");\n', "utf8");

    const result = runHooks(baseContext({
      event: "file.stage.before",
      cwd: dir,
      projectRoot: dir,
      targetPaths: [sourceFile],
    }));

    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(false);
  });

  test("exige preview y confirmacion para memoria destructiva", () => {
    const result = runHooks(baseContext({
      event: "memory.delete.apply",
      destructive: true,
      memoryScope: "flowin-backend",
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.map((violation) => violation.id)).toContain("MAL-HOOK-MEM-PREVIEW");
    expect(result.violations.map((violation) => violation.id)).toContain("MAL-HOOK-MEM-CONFIRM");
  });

  test("permite memoria destructiva con preview y confirmacion exacta", () => {
    const result = runHooks(baseContext({
      event: "memory.delete.apply",
      destructive: true,
      memoryScope: "flowin-backend",
      confirmation: "flowin-backend",
      metadata: {
        previewToken: "delete:flowin-backend:6:0",
        requiresConfirmation: "flowin-backend",
      },
    }));

    expect(result.decision).toBe("allow");
  });

  test("detecta politica insegura antes de aplicar permisos", () => {
    const result = runHooks(baseContext({
      event: "install.beforePolicy",
      profile: "release",
      metadata: {
        appliesPolicyBeforeValidation: true,
        bashDenyTotal: true,
      },
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.length).toBe(2);
  });

  test("push es hard DENY aunque el perfil pudiera rebajar otros controles", () => {
    const result = runHooks(baseContext({ event: "git.push.before", profile: "release" }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-REMOTE-DENY")).toBe(true);
  });

  // follow-up: clasificación DENY incremental
  test.skip("clasifica ASK aprobable y Git remoto inequívoco sin confundir sus bloqueos", () => {
    const approval = runHooks(baseContext({
      event: "git.reset.before",
      command: "git reset --hard HEAD~1",
    }));
    const hardDeny = runHooks(baseContext({
      event: "shell.exec.before",
      command: "git fetch origin",
      confirmation: "APPROVE",
    }));

    expect(approval.decision).toBe("ask");
    expectBlockClass(approval, "MAL-HOOK-GIT-DESTRUCTIVE", "approval-required");
    expect(hardDeny.decision).toBe("deny");
    expectBlockClass(hardDeny, "MAL-HOOK-GIT-REMOTE-DENY", "hard-deny");
    expect(formatHookResult(approval)).toContain("approval-required");
    expect(formatHookResult(hardDeny)).toContain("hard-deny");
  });

  // follow-up: clasificación DENY incremental
  test.skip("un hallazgo positivo de secreto es DENY remediable, no hard DENY", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-block-class-secret-"));
    const target = path.join(dir, "credential.ts");
    const identifier = ["access", "token"].join("_");
    const value = ["production", "0123456789abcdef"].join("-");
    fs.writeFileSync(target, `export const ${identifier} = '${value}';\n`, "utf8");

    try {
      const result = runHooks(baseContext({
        event: "file.stage.before",
        cwd: dir,
        projectRoot: dir,
        targetPaths: [target],
      }));

      expect(result.decision).toBe("deny");
      expectBlockClass(result, "MAL-HOOK-SECRETS", "remediable-deny");
      expect(violationContract(result, "MAL-HOOK-SECRETS")?.blockClass).not.toBe("hard-deny");
      expect(formatHookResult(result)).toContain("remediable-deny");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // follow-up: clasificación DENY incremental
  test.skip("un patch sin resumen evaluable falla cerrado como control no disponible", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-block-class-patch-"));
    const target = path.join(dir, "benign.ts");
    fs.writeFileSync(target, "export const ready = true;\n", "utf8");

    try {
      const result = runHooks(baseContext({
        event: "file.write.before",
        cwd: dir,
        projectRoot: dir,
        resourceKind: "filesystem",
        targetPaths: [target],
        metadata: { tool: "patch" },
      }));
      const messages = result.violations.map((violation) => violation.message).join("\n");

      expect(result.decision).toBe("deny");
      expect(result.violations.map((violation) => violation.id)).toContain("MAL-HOOK-PATCH-UNEVALUABLE");
      expect(result.violations.map((violation) => violation.id)).not.toContain("MAL-HOOK-SECRETS");
      expectBlockClass(result, "MAL-HOOK-PATCH-UNEVALUABLE", "control-unavailable");
      expect(result.violations.some((violation) =>
        (violation as HookViolation & { blockClass?: unknown }).blockClass === "hard-deny")).toBe(false);
      expect(messages).not.toMatch(/(?:secreto|credencial).*(?:detectad|confirmad)|(?:detectad|confirmad).*(?:secreto|credencial)/i);
      expect(formatHookResult(result)).toContain("control-unavailable");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("un patch sin evidencia interna falla cerrado como no evaluable, sin afirmar un secreto", () => {
    const result = runHooks(baseContext({
      event: "file.write.before",
      metadata: { tool: "patch", secretPatchSummary: { version: 1, evaluable: true, files: [] } },
      targetPaths: ["src/example.ts"],
    }));
    const violation = result.violations.find((item) => item.id === "MAL-HOOK-PATCH-UNEVALUABLE");

    expect(result.decision).toBe("deny");
    expect(violation?.diagnostic).toMatchObject({ code: "PATCH_NOT_EVALUABLE", reason: "missing-evidence" });
    expect(result.violations.some((item) => item.id === "MAL-HOOK-SECRETS")).toBe(false);
    expect(formatHookResult(result)).toMatch(/no se pudo evaluar/i);
    expect(formatHookResult(result)).not.toMatch(/secretos detectados/i);
  });

  test("el scanner distingue contextos incorrectos, ambiguos y un hallazgo en la postimagen completa", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-patch-check-"));
    const file = path.join(dir, "fixture.ts");
    const identifier = ["api", "key"].join("_");
    const value = ["synthetic", "0123456789abcdef"].join("-");
    const patch = (...body: string[]) => [
      "*** Begin Patch", "*** Update File: fixture.ts", "@@", ...body, "*** End Patch",
    ].join("\n");
    try {
      fs.writeFileSync(file, "export const ready = true;\n", "utf8");
      const misaligned = buildSecretPatchSummary(patch("- export const ready = true;", "+export const ready = false;"), dir);
      expect(misaligned).toMatchObject({ evaluable: false, failure: { code: "PATCH_NOT_EVALUABLE", reason: "context-mismatch", operation: "update", path: "fixture.ts" } });
      expect(JSON.stringify(misaligned)).not.toContain("export const ready");

      fs.writeFileSync(file, "same\nsame\n", "utf8");
      const ambiguous = buildSecretPatchSummary(patch("-same", "+changed"), dir);
      expect(ambiguous).toMatchObject({ evaluable: false, failure: { reason: "ambiguous-context" } });

      fs.writeFileSync(file, `export const ${identifier} =\n  '${value}';\nexport const ready = false;\n`, "utf8");
      const safeEdit = buildSecretPatchSummary(patch("-export const ready = false;", "+export const ready = true;"), dir);
      expect(safeEdit.evaluable).toBe(true);
      expect(safeEdit.files[0]?.after["credential-assignment"]).toBe(1);
      expect(JSON.stringify(safeEdit)).not.toContain(value);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tokens y asignaciones multilínea se detectan en el archivo completo y no salen en recetas", () => {
    const identifier = ["api", "key"].join("_");
    const syntheticValue = ["synthetic", "0123456789abcdef"].join("-");
    const bearerValue = ["abcdefghijklmnopqrstuvwxyz", "12345678"].join("");
    const content = `export const ${identifier} =\n '${syntheticValue}';\n`;
    const findings = detectFileSecretFindings(content, "tests/fixtures/credential.test.ts");
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "credential-assignment", line: 1,
    })]));
    expect(JSON.stringify(findings)).not.toContain(syntheticValue);

    const line = `const redactionProbe = "${identifier}='${syntheticValue}' Bearer ${bearerValue}";`;
    const mixed = detectFileSecretFindings(line, "tests/fixtures/credential.test.ts");
    expect(detectFileSecretCounts(line)["bearer-token"]).toBe(1);
    expect(mixed.map((item) => item.kind)).toContain("bearer-token");
    expect(mixed.some((item) => item.remediation?.kind === "replace-block")).toBe(false);
    expect(JSON.stringify(mixed)).not.toContain(syntheticValue);
    expect(JSON.stringify(mixed)).not.toContain(bearerValue);
  });

  test("un destino fuera de la raíz no se imprime, y una operación de dos archivos evalúa ambas postimágenes", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-patch-two-"));
    try {
      fs.writeFileSync(path.join(dir, "first.ts"), "export const first = false;\n");
      fs.writeFileSync(path.join(dir, "second.ts"), "export const second = false;\n");
      const outside = buildSecretPatchSummary([
        "*** Begin Patch", "*** Update File: ../external.ts", "@@", "-before", "+after", "*** End Patch",
      ].join("\n"), dir);
      expect(outside).toMatchObject({ evaluable: false, failure: { reason: "invalid-path" } });
      expect(JSON.stringify(outside)).not.toContain("external.ts");

      const combined = buildSecretPatchSummary([
        "*** Begin Patch", "*** Update File: first.ts", "@@", "-export const first = false;", "+export const first = true;",
        "*** Update File: second.ts", "@@", "-export const second = false;", "+export const second = true;", "*** End Patch",
      ].join("\n"), dir);
      expect(combined).toMatchObject({ evaluable: true, files: [{ path: "first.ts" }, { path: "second.ts" }] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("digest, proof y secretPatchSummary son términos de código, no evidencia de secreto", () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-benign-terms-"));
    const target = path.join(dir, "signed-state.ts");
    fs.writeFileSync(target, [
      'export const digest = "sha256:fixture";',
      'export const proof = "signed-fixture";',
      "export const secretPatchSummary = { evaluable: true };",
    ].join("\n"), "utf8");

    try {
      const result = runHooks(baseContext({
        event: "file.stage.before",
        cwd: dir,
        projectRoot: dir,
        targetPaths: [target],
      }));

      expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(false);
      expect(result.decision).toBe("allow");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("advierte mensajes de commit fuera del formato Malahor", () => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m 'update stuff'",
      profile: "release",
      metadata: { validationOnly: true },
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-COMMIT-MESSAGE")).toBe(true);
  });

  test("acepta mensajes de commit Malahor", () => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      profile: "release",
      metadata: { validationOnly: true },
    }));

    expect(result.decision).toBe("allow");
  });

  test.each([
    "🛡️ security(núcleo-seguro): protege sesión y envío",
    "♻️ refactor(catálogo): reordena índices públicos",
    "✨ feat!: cambia el contrato público",
    "✨ feat(api-pública)!: cambia el contrato público",
  ])("acepta el contrato compartido con emoji completo, Unicode y breaking: %s", (message) => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: `git commit -m '${message}'`,
      profile: "release",
      metadata: { validationOnly: true },
    }));

    expect(result.decision).toBe("allow");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-COMMIT-MESSAGE")).toBe(false);
  });

  test.each([
    "feat(núcleo): falta el icono",
    "! feat(core): puntuación no es un icono",
    "✨ feature(núcleo): tipo fuera del contrato",
    "✨ feat(núcleo)!!: breaking mal ubicado",
    "✨ feat(núcleo): ",
  ])("rechaza subjects sin icono o fuera del contrato: %s", (message) => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: `git commit -m '${message}'`,
      profile: "release",
      metadata: { validationOnly: true },
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-COMMIT-MESSAGE")).toBe(true);
  });

  test("el hook delega la validación en git-commit-message sin duplicar tipos", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "cli", "core", "hooks", "rules.ts"), "utf8");

    expect(source).toMatch(/from\s+["']\.\.\/git-commit-message["']/);
    expect(source).not.toMatch(/feat\|fix\|docs\|style\|refactor\|perf\|test\|build\|ci\|chore\|revert/);
  });

  test("pide consentimiento para commit real sin intencion explicita", () => {
    const result = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      targetPaths: ["src/fixture.ts"],
      profile: "release",
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-CONSENT")).toBe(true);
  });

  test("tokens y metadata legacy no autorizan commit ni stage", () => {
    const commit = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      targetPaths: ["src/fixture.ts"],
      confirmation: "USER_REQUESTED_COMMIT",
      profile: "release",
    }));
    const stage = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add -- src/fixture.ts",
      targetPaths: ["src/fixture.ts"],
      metadata: { userExplicitlyRequestedStage: true },
      profile: "release",
    }));

    expect(commit.decision).toBe("ask");
    expect(commit.violations.some((violation) => violation.id === "MAL-HOOK-GIT-CONSENT")).toBe(true);
    expect(stage.decision).toBe("ask");
    expect(stage.violations.some((violation) => violation.id === "MAL-HOOK-GIT-STAGE-CONSENT")).toBe(true);
  });

  test("una intencion commit estructurada cubre stage exacto y commit ordinario", () => {
    const stage = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add -- src/fixture.ts",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));
    const commit = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -m '🧠 feat(memoria): agrega hooks seguros'",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));
    const amend = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit --amend --no-edit",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));

    expect(stage.decision).toBe("allow");
    expect(commit.decision).toBe("allow");
    expect(amend.decision).toBe("ask");
    expect(amend.violations.some((violation) => violation.id === "MAL-HOOK-GIT-CONSENT")).toBe(true);
  });

  test("la intencion commit rechaza stage amplio, paths distintos y commit -a", () => {
    const broadStage = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add -A",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));
    const differentPath = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add -- src/otro.ts",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));
    const magicPathspec = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add -- :/",
      targetPaths: [":/"],
      gitIntent: "commit",
    }));
    const implicitStage = runHooks(baseContext({
      event: "git.commit.before",
      command: "git commit -am '🧠 feat(memoria): agrega hooks seguros'",
      targetPaths: ["src/fixture.ts"],
      gitIntent: "commit",
    }));

    for (const result of [broadStage, differentPath, magicPathspec]) {
      expect(result.decision).toBe("deny");
      expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-INTENT-SCOPE")).toBe(true);
    }
    expect(implicitStage.decision).toBe("deny");
    expect(implicitStage.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE-DENY")).toBe(true);
  });

  test("pide consentimiento para stage real sin intencion explicita", () => {
    const result = runHooks(baseContext({
      event: "file.stage.before",
      command: "git add README.md",
      profile: "release",
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-STAGE-CONSENT")).toBe(true);
  });

  test("profile off no elimina el ASK destructivo local", () => {
    const result = runHooks(baseContext({
      event: "git.reset.before",
      command: "git reset --hard HEAD~1",
      profile: "off",
    }));

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
  });

  test("assertHooksAllowed bloquea ask pendiente", () => {
    expect(() => assertHooksAllowed(baseContext({
      event: "git.reset.before",
      command: "git reset --hard HEAD~1",
      profile: "release",
    }))).toThrow(/ASK pendiente/);
  });

  test("CHECKS_OK no habilita un remoto hard DENY", () => {
    const result = runHooks(baseContext({
      event: "git.push.before",
      profile: "release",
      confirmation: "CHECKS_OK",
    }));

    expect(result.decision).toBe("deny");
    expect(() => assertHooksAllowed(baseContext({
      event: "git.push.before",
      profile: "release",
      confirmation: "CHECKS_OK",
    }))).toThrow(/remota prohibida|hard DENY/i);
  });

  test.each([
    "git pull",
    "git fetch --all",
    "git clone https://example.com/demo.git",
    "git remote update",
    "git -c alias.publicar=push publicar",
    "echo \"$(git fetch origin)\"",
    "printf '%s' `git push origin HEAD`",
  ])("deniega remoto desde shell aun con metadata de aprobacion: %s", (command) => {
    const result = runHooks(baseContext({
      event: "shell.exec.before",
      command,
      profile: "off",
      confirmation: "APPROVE",
      gitIntent: "commit",
      metadata: { checksVerified: true, planID: "plan", revision: "rev" },
    }));
    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-REMOTE-DENY")).toBe(true);
  });

  test("permite git ls-files como lectura local", () => {
    const result = runHooks(baseContext({
      event: "shell.exec.before",
      command: "git ls-files -- docs README.md LICENSE THIRD_PARTY_NOTICES.md",
      profile: "off",
    }));

    expect(result.decision).toBe("allow");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-REMOTE-DENY")).toBe(false);
  });

  test.each([
    "git rm -- src/fixture.ts",
    "git stash push -m temporal",
    "git revert abc123",
    "git update-index --assume-unchanged src/fixture.ts",
    "git update-ref refs/heads/dev abc123",
    "git tag -d v1.0.0",
    "git notes add -m nota abc123",
  ])("deniega mutadores locales no modelados: %s", (command) => {
    const result = runHooks(baseContext({
      event: "shell.exec.before",
      command,
      profile: "off",
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE-DENY")).toBe(true);
  });

  test("USER_REQUESTED_COMMIT no autoriza un ask de mensaje", () => {
    const context = baseContext({
      event: "git.commit.before",
      command: "git commit -m 'update stuff'",
      targetPaths: ["src/fixture.ts"],
      profile: "release",
      confirmation: "USER_REQUESTED_COMMIT",
    });

    expect(runHooks(context).decision).toBe("ask");
    expect(() => assertHooksAllowed(context)).toThrow(/ASK pendiente/);
  });

  test("hookExitCode distingue deny, ask y allow", () => {
    expect(hookExitCode("deny")).toBe(2);
    expect(hookExitCode("ask")).toBe(3);
    expect(hookExitCode("warn")).toBe(0);
    expect(hookExitCode("allow")).toBe(0);
  });

  // follow-up: clasificación DENY incremental
  test.skip("error de control critico deniega y error auxiliar solo advierte", () => {
    const critical: HookRule[] = [{
      id: "control-critico",
      run: () => { throw new Error("timeout"); },
    }];
    const auxiliary: HookRule[] = [{
      id: "control-auxiliar",
      critical: false,
      run: () => { throw new Error("lectura opcional"); },
    }];

    const criticalResult = evaluateHookRules(baseContext({}), critical);
    const auxiliaryResult = evaluateHookRules(baseContext({}), auxiliary);

    expect(criticalResult[0]?.id).toBe("MAL-HOOK-CONTROL-ERROR");
    expect(criticalResult[0]?.decision).toBe("deny");
    expect((criticalResult[0] as (HookViolation & { blockClass?: unknown }) | undefined)?.blockClass)
      .toBe("control-unavailable");
    expect((criticalResult[0] as (HookViolation & { blockClass?: unknown }) | undefined)?.blockClass)
      .not.toBe("hard-deny");
    expect(auxiliaryResult[0]?.id).toBe("MAL-HOOK-CONTROL-WARN");
    expect(auxiliaryResult[0]?.decision).toBe("warn");
  });

  test("politica corporativa no evaluable bloquea la operacion", () => {
    const result = runHooks(baseContext({
      policyMeta: policyMeta({ corporateStatus: "untrusted" }),
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-POLICY-CORPORATE")).toBe(true);
  });

  test("control exigido sin mediacion bloquea la operacion afectada", () => {
    const result = runHooks(baseContext({
      event: "git.push.before",
      policyMeta: policyMeta({ criticalGaps: ["corporate:git.requirePushApproval"] }),
    }));

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-POLICY-GAP")).toBe(true);
  });

  test("expone hook check por MCP", () => {
    const result = callTool({
      name: "malahor_hook_check",
      arguments: {
        event: "git.reset.before",
        command: "git reset --hard",
      },
    }) as { decision: string; violations: Array<{ id: string }> };

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
  });

  test("el wrapper MCP rechaza el resourceKind retirado antes de resolver archivos", () => {
    expect(() => callTool({
      name: "malahor_hook_check",
      arguments: {
        event: "file.write.before",
        resourceKind: "obsidian-vault",
        paths: ["Product/manual.md"],
      },
    })).toThrow(/resourceKind.*filesystem/i);
  });
});
