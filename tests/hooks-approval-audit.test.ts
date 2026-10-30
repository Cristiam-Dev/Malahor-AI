import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { approvalRecordPath, approvalsDirectory, consumeApproval, grantApproval } from "../src/cli/core/hooks/approvals";
import { auditFilePath, buildAuditEntry, writeAudit } from "../src/cli/core/hooks/audit";
import { assertHooksAllowed, runHooks } from "../src/cli/core/hooks/engine";
import type { HookContext, HookPolicyMeta, SecurityControls } from "../src/cli/core/hooks/types";

function temporaryHome(): string {
  return fs.mkdtempSync(path.join("/tmp/opencode", "malahor-approval-"));
}

function metadata(overrides: Partial<HookPolicyMeta> = {}): HookPolicyMeta {
  return {
    contractVersion: 1,
    schemaVersion: 1,
    policyVersion: "2026-10-21.1",
    issuer: "test",
    policyHash: "a".repeat(64),
    sources: [],
    corporateStatus: "absent",
    corporateRequired: false,
    criticalGaps: [],
    warnings: [],
    ...overrides,
  };
}

function context(home: string, overrides: Partial<HookContext> = {}): HookContext {
  const security: SecurityControls = {
    git: { requireChecksBeforePush: true },
    ...(overrides.security ?? {}),
  };

  return {
    event: "git.push.before",
    harness: "cli",
    profile: "release",
    cwd: home,
    projectRoot: home,
    malahorHome: home,
    project: "proyecto-x",
    client: "cliente-a",
    command: "git push",
    targetPaths: ["src/a.ts"],
    policyMeta: metadata(),
    security,
    audit: { enabled: false },
    ...overrides,
    security,
  };
}

describe("approval ledger", () => {
  test("emite y consume una aprobacion una sola vez", () => {
    const home = temporaryHome();
    const ctx = context(home);
    const record = grantApproval(ctx, { channel: "cli-tty", ttlSeconds: 60 });

    expect(record.operation).toBe("git.push.before");
    expect(record.resources).toHaveLength(1);
    expect(record.consumedAt).toBeNull();
    expect(fs.existsSync(approvalRecordPath(home, record.nonce))).toBe(true);
    expect(fs.statSync(approvalRecordPath(home, record.nonce)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(approvalsDirectory(home)).mode & 0o777).toBe(0o700);

    const first = consumeApproval(record.nonce, ctx);
    expect(first.ok).toBe(true);
    expect(first.record?.consumedAt).not.toBeNull();
    expect(consumeApproval(record.nonce, ctx).reason).toContain("consumida");
  });

  test("rechaza aprobaciones expiradas", () => {
    const home = temporaryHome();
    const ctx = context(home);
    const record = grantApproval(ctx, { channel: "cli-tty", ttlSeconds: 10, now: new Date("2026-10-21T00:00:00Z") });

    const result = consumeApproval(record.nonce, ctx, { now: new Date("2026-10-21T00:00:11Z") });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("expirada");
  });

  test("rechaza cambios de operacion, recursos, comando, cliente o politica", () => {
    const home = temporaryHome();
    const ctx = context(home);
    const record = grantApproval(ctx, { channel: "cli-tty" });

    expect(consumeApproval(record.nonce, context(home, { targetPaths: ["src/b.ts"] })).ok).toBe(false);
    expect(consumeApproval(record.nonce, context(home, { command: "git push --force" })).ok).toBe(false);
    expect(consumeApproval(record.nonce, context(home, { memoryScope: "otro-proyecto" })).ok).toBe(false);
    expect(consumeApproval(record.nonce, context(home, { client: "cliente-b" })).ok).toBe(false);
    expect(consumeApproval(record.nonce, context(home, { policyMeta: metadata({ policyHash: "b".repeat(64) }) })).ok).toBe(false);
    expect(consumeApproval(record.nonce, context(home)).ok).toBe(true);
  });

  test("vincula recursos del vault por identidad logica independiente del cwd", () => {
    const home = temporaryHome();
    const targetPaths = ["Malahor-AI/Product/pm/plan.md"];
    const ctx = context(home, {
      event: "obsidian.write.before",
      command: "",
      resourceKind: "obsidian-vault",
      targetPaths,
    });
    const record = grantApproval(ctx, { channel: "cli-tty" });

    expect(record.resources).toEqual(["obsidian-vault:Malahor-AI/Product/pm/plan.md"]);
    expect(consumeApproval(record.nonce, { ...ctx, resourceKind: "filesystem" }).ok).toBe(false);
    expect(consumeApproval(record.nonce, {
      ...ctx,
      cwd: path.join(home, "otro-cwd"),
    }).ok).toBe(true);
  });

  test("no emite aprobaciones para rutas de vault invalidas", () => {
    const home = temporaryHome();
    expect(() => grantApproval(context(home, {
      event: "obsidian.write.before",
      command: "",
      resourceKind: "obsidian-vault",
      targetPaths: ["../fuera.md"],
    }), { channel: "cli-tty" })).toThrow(/traversal/);
  });

  test("rechaza registros con vigencia invalida, permisos inseguros o TTL excedido", () => {
    const home = temporaryHome();
    const ctx = context(home);
    const record = grantApproval(ctx, { channel: "cli-tty", ttlSeconds: 60 });
    const filePath = approvalRecordPath(home, record.nonce);
    const original = fs.readFileSync(filePath, "utf8");

    const invalidExpiry = { ...record, expiresAt: "no-es-fecha" };
    fs.writeFileSync(filePath, `${JSON.stringify(invalidExpiry)}\n`, { mode: 0o600 });
    expect(consumeApproval(record.nonce, ctx).reason).toContain("vigencia");

    fs.writeFileSync(filePath, original, { mode: 0o600 });
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o644);
      expect(consumeApproval(record.nonce, ctx).reason).toContain("permisos");
      fs.chmodSync(filePath, 0o600);
    }

    expect(consumeApproval(record.nonce, context(home, {
      security: { approval: { maxTtlSeconds: 10 } },
    })).reason).toContain("TTL maximo");
  });

  test("emite la aprobacion con warning si la auditoria auxiliar falla", () => {
    const home = temporaryHome();
    const auditPath = path.join(home, "audit-as-directory");
    fs.mkdirSync(auditPath, { mode: 0o700 });
    const ctx = context(home, {
      audit: { enabled: true },
      security: { audit: { path: auditPath } },
    });

    const record = grantApproval(ctx, { channel: "cli-tty" });
    expect(record.auditWarning).toContain("archivo de auditoria invalido");
    expect(consumeApproval(record.nonce, ctx).ok).toBe(true);
  });

  test("rechaza canales no confiables o no permitidos", () => {
    const home = temporaryHome();

    expect(() => grantApproval(context(home), { channel: "model" })).toThrow(/canal/);
    expect(() => grantApproval(context(home, {
      security: { approval: { allowedChannels: ["opencode-ui"] } },
    }), { channel: "cli-tty" })).toThrow(/no permitido/);
    expect(() => grantApproval(context(home, {
      security: { approval: { allowedChannels: [] } },
    }), { channel: "cli-tty" })).toThrow(/no permitido/);
  });

  test("respeta el TTL maximo de la politica", () => {
    const home = temporaryHome();
    const now = new Date("2026-10-21T00:00:00Z");
    const record = grantApproval(context(home, {
      security: { approval: { maxTtlSeconds: 10 } },
    }), { channel: "cli-tty", ttlSeconds: 3600, now });

    expect(Date.parse(record.expiresAt) - now.getTime()).toBe(10_000);
  });
});

describe("assert with approvals and audit", () => {
  test("ask sin aprobacion bloquea", () => {
    const home = temporaryHome();
    expect(() => assertHooksAllowed(context(home))).toThrow(/ASK pendiente/);
  });

  test("ask con aprobacion valida se consume y permite", () => {
    const home = temporaryHome();
    const ctx = context(home);
    const record = grantApproval(ctx, { channel: "cli-tty" });
    const result = assertHooksAllowed({ ...ctx, approval: record.nonce });

    expect(result.decision).toBe("allow");
    expect(result.approvalRef).toBe(record.nonce);
    expect(() => assertHooksAllowed({ ...ctx, approval: record.nonce })).toThrow(/consumida|ASK pendiente/);
  });

  test("deny no se convierte en allow por aprobacion", () => {
    const home = temporaryHome();
    const ctx = context(home, {
      event: "memory.delete.apply",
      command: "",
      targetPaths: [],
      security: { destructive: { requirePreview: true } },
      approval: "a".repeat(64),
    });

    expect(() => assertHooksAllowed(ctx)).toThrow(/preview|confirmacion/i);
  });

  test("auditoria escribe JSONL sin payloads y con referencias hasheadas", () => {
    const home = temporaryHome();
    const ctx = context(home, {
      audit: { enabled: true },
      command: "git push --token SECRET_VALUE",
      targetPaths: ["src/a.ts"],
    });
    const result = runHooks(ctx);
    const written = writeAudit(ctx, result, { now: new Date("2026-10-21T00:00:00Z") });

    expect(written.ok).toBe(true);
    const raw = fs.readFileSync(auditFilePath(home), "utf8");
    expect(raw).not.toContain("SECRET_VALUE");
    expect(raw).not.toContain("src/a.ts");

    const entry = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(entry.auditVersion).toBe(1);
    expect(entry.event).toBe("git.push.before");
    expect(entry.operation).toBe("push");
    expect(entry.decision).toBe("ask");
    expect(String(entry.policyHash).startsWith("sha256:")).toBe(true);
    expect((entry.ruleIds as string[]).length).toBeGreaterThan(0);
    expect(String((entry.resourceRefs as string[])[0]).startsWith("sha256:")).toBe(true);
    expect(fs.statSync(auditFilePath(home)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(auditFilePath(home))).mode & 0o777).toBe(0o700);
  });

  test("auditoria de vault es estable aunque cambie el cwd", () => {
    const home = temporaryHome();
    const ctx = context(home, {
      event: "obsidian.write.before",
      command: "",
      resourceKind: "obsidian-vault",
      targetPaths: ["Malahor-AI/Product/manual.md"],
    });

    const first = buildAuditEntry(ctx, runHooks(ctx));
    const second = buildAuditEntry({ ...ctx, cwd: path.join(home, "otro-cwd") }, runHooks(ctx));
    expect(first.resourceRefs).toEqual(second.resourceRefs);
    expect(first.resourceRefs).toHaveLength(1);
  });

  test("auditoria auxiliar no disponible reporta warn sin bloquear", () => {
    const home = temporaryHome();
    const notDirectory = path.join(home, "not-a-directory");
    fs.writeFileSync(notDirectory, "x", "utf8");
    const ctx = context(home, {
      event: "git.commit.before",
      command: "",
      targetPaths: [],
      malahorHome: notDirectory,
      audit: { enabled: true },
    });

    const result = assertHooksAllowed(ctx);
    expect(result.decision).toBe("warn");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-AUDIT-WARN")).toBe(true);
  });

  test("auditoria obligatoria no disponible deniega la operacion", () => {
    const home = temporaryHome();
    const notDirectory = path.join(home, "not-a-directory");
    fs.writeFileSync(notDirectory, "x", "utf8");
    const ctx = context(home, {
      event: "git.commit.before",
      command: "",
      targetPaths: [],
      security: { audit: { required: true } },
      malahorHome: notDirectory,
      audit: { enabled: true },
    });

    expect(() => assertHooksAllowed(ctx)).toThrow(/Auditoria obligatoria/);
  });

  test("respeta la ruta de auditoria impuesta por la politica", () => {
    const home = temporaryHome();
    const custom = path.join(home, "managed", "corporate-audit.jsonl");
    const ctx = context(home, {
      audit: { enabled: true },
      security: { audit: { path: custom } },
    });

    const written = writeAudit(ctx, runHooks(ctx));
    expect(written.ok).toBe(true);
    expect(written.path).toBe(custom);
    expect(fs.existsSync(custom)).toBe(true);
    expect(fs.existsSync(auditFilePath(home))).toBe(false);
  });

  test("rota auditoria por tamano y conserva el archivo activo", () => {
    const home = temporaryHome();
    const directory = path.join(home, "audit");
    const current = path.join(directory, "security.jsonl");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(current, "x".repeat(5 * 1024 * 1024 + 1), { mode: 0o600 });
    const ctx = context(home, { audit: { enabled: true } });
    const written = writeAudit(ctx, runHooks(ctx), {
      now: new Date("2026-10-21T00:00:00Z"),
      maxFiles: 3,
    });

    expect(written.ok).toBe(true);
    const rotated = fs.readdirSync(directory).filter((name) => name !== "security.jsonl" && name.startsWith("security.") && name.endsWith(".jsonl"));
    expect(rotated).toHaveLength(1);
    expect(fs.readFileSync(current, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("retencion conserva el archivo activo y limita los rotados", () => {
    const home = temporaryHome();
    const directory = path.join(home, "audit");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "security.2026-10-20T00-00-00-000Z.jsonl"), "old\n", { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "security.2026-10-21T00-00-00-000Z.jsonl"), "old\n", { mode: 0o600 });
    const ctx = context(home, { audit: { enabled: true } });

    expect(writeAudit(ctx, runHooks(ctx), { maxFiles: 1 }).ok).toBe(true);
    expect(fs.existsSync(auditFilePath(home))).toBe(true);
    const rotated = fs.readdirSync(directory).filter((name) => name !== "security.jsonl" && name.endsWith(".jsonl"));
    expect(rotated).toHaveLength(0);
  });

  test("buildAuditEntry no incluye command ni contenido de archivos", () => {
    const home = temporaryHome();
    const ctx = context(home, { command: "git commit -m 'secreto'", targetPaths: ["src/a.ts"] });
    const entry = buildAuditEntry(ctx, runHooks(ctx));

    expect(JSON.stringify(entry)).not.toContain("secreto");
    expect(JSON.stringify(entry)).not.toContain("src/a.ts");
  });
});
