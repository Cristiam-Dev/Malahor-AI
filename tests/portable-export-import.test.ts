import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runMemory } from "../src/cli/commands/memory";
import { grantApproval } from "../src/cli/core/hooks/approvals";
import { assertHooksAllowed, runHooks } from "../src/cli/core/hooks/engine";
import type { HookContext, HookPolicyMeta } from "../src/cli/core/hooks/types";
import {
  decryptPortablePayload,
  encryptPortablePayload,
  openPortablePackage,
  writePortablePackage,
} from "../src/cli/core/portable-package";
import {
  applyPortableImport,
  capturePortableProjects,
  createPortablePayload,
  parsePortableImportDirectives,
  portableSecretFindings,
  previewPortableImport,
  previewPortableProjectsImport,
  type PortableProjectsSnapshot,
} from "../src/cli/core/portable-state";
import { loadProjectsFile } from "../src/cli/core/context";
import { MemoryStore } from "../src/mnemo/engine/store";
import {
  capturePortableMemory,
  stagePortableMemory,
  validatePortableMemorySnapshot,
} from "../src/mnemo/portable-transfer";
import { memoryLocation, memoryV2Paths } from "../src/mnemo/storage";
import { fixtureDb } from "./mnemo-fixture";
import { seedEngine, syntheticMarker } from "./memory-engine-fixture";

const roots: string[] = [];
const PASSPHRASE = Buffer.from("synthetic portable passphrase");

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sandbox(label: string): { root: string; home: string; legacy: string; projects: string; backups: string } {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", `malahor-portable-${label}-`));
  roots.push(root);
  const home = path.join(root, ".malahor");
  const mnemo = path.join(home, "mnemo");
  const backups = path.join(home, "backups");
  fs.mkdirSync(mnemo, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  return {
    root,
    home,
    legacy: path.join(mnemo, "db.json"),
    projects: path.join(home, "projects.json"),
    backups,
  };
}

function writeLegacy(file: string, value = fixtureDb()): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function writeProjects(file: string, value: Record<string, unknown>): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function policyMeta(): HookPolicyMeta {
  return {
    contractVersion: 1,
    schemaVersion: 1,
    policyVersion: "portable-test-v1",
    issuer: "test",
    policyHash: "a".repeat(64),
    sources: [],
    corporateStatus: "absent",
    corporateRequired: false,
    criticalGaps: [],
    warnings: [],
  };
}

function hookContext(home: string, overrides: Partial<HookContext>): HookContext {
  return {
    event: "memory.portable.export.apply",
    harness: "cli",
    profile: "standard",
    cwd: home,
    projectRoot: home,
    malahorHome: home,
    project: "synthetic",
    client: "synthetic",
    command: "memory portable synthetic",
    targetPaths: [],
    policyMeta: policyMeta(),
    audit: { enabled: false },
    ...overrides,
  };
}

describe("paquete portable cifrado", () => {
  test("autentica el round-trip y no expone plaintext ni manifest en cabecera", () => {
    const value = {
      format: "synthetic",
      sentinel: "SENTINEL_PORTABLE_PLAINTEXT",
      manifest: { observations: 7, projects: ["alpha"] },
    };
    const encrypted = encryptPortablePayload(value, PASSPHRASE);

    expect(encrypted.includes(Buffer.from(value.sentinel))).toBe(false);
    expect(encrypted.includes(Buffer.from("observations"))).toBe(false);
    expect(decryptPortablePayload(encrypted, PASSPHRASE)).toEqual(value);
    expect(() => decryptPortablePayload(encrypted, Buffer.from("wrong synthetic passphrase")))
      .toThrow(/autenticar|passphrase/i);

    const tampered = Buffer.from(encrypted);
    tampered[Math.floor(tampered.length / 2)]! ^= 1;
    expect(() => decryptPortablePayload(tampered, PASSPHRASE)).toThrow(/autenticar/i);

    const future = Buffer.from(encrypted);
    future[8] = 2;
    expect(() => decryptPortablePayload(future, PASSPHRASE)).toThrow(/cabecera|compatible/i);
  });

  test("publica un solo .mhpkg privado y rechaza sobrescritura", () => {
    const fixture = sandbox("package");
    const destination = path.join(fixture.root, "transfer.mhpkg");
    const value = { format: "synthetic", value: "round-trip" };

    const descriptor = writePortablePackage(destination, value, PASSPHRASE);
    expect(descriptor.path).toBe(destination);
    expect(openPortablePackage(destination, PASSPHRASE).value).toEqual(value);
    if (process.platform !== "win32") expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(() => writePortablePackage(destination, value, PASSPHRASE)).toThrow(/existe/i);
  });
});

describe("snapshot Mnemo portable", () => {
  test("convierte JSON legado a staging SQLite y reconstruye FTS5", () => {
    const fixture = sandbox("json");
    writeLegacy(fixture.legacy);
    const captured = capturePortableMemory(fixture.legacy);
    const staging = path.join(fixture.home, "portable", "json.sqlite");

    expect(captured.backend).toBe("json");
    expect(captured.snapshot.observations).toHaveLength(fixtureDb().observations.length);
    expect(captured.snapshot.sessions).toHaveLength(fixtureDb().sessions.length);
    expect(captured.snapshot.pins).toEqual([]);
    expect(captured.snapshot.relations).toEqual([]);

    stagePortableMemory(captured.snapshot, staging);
    const store = MemoryStore.open(staging, "read");
    try {
      store.verifyReadOnly();
      expect(store.all("SELECT id FROM observations ORDER BY position")).toHaveLength(fixtureDb().observations.length);
      expect(store.all("SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?", ["Respuestas"]))
        .toHaveLength(1);
    } finally {
      store.close();
    }
    expect(fs.existsSync(`${staging}-wal`)).toBe(false);
    expect(fs.existsSync(`${staging}-shm`)).toBe(false);
  });

  test("conserva IDs, posiciones, pins, relaciones y contadores de SQLite", () => {
    const fixture = sandbox("sqlite");
    const paths = memoryV2Paths(fixture.legacy);
    const engine = seedEngine(paths.database);
    engine.pin(2);
    engine.close();
    const store = MemoryStore.open(paths.database, "write");
    try {
      store.run("INSERT INTO relations VALUES (?, ?, ?, ?)", [
        2,
        3,
        "supersedes",
        "2026-11-25T00:00:00.000Z",
      ]);
    } finally {
      store.close();
    }
    syntheticMarker(fixture.home);

    const captured = capturePortableMemory(fixture.legacy);
    const snapshot = validatePortableMemorySnapshot(captured.snapshot);
    expect(captured.backend).toBe("sqlite");
    expect(snapshot.observations.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.observations.map((item) => item.position)).toEqual([0, 1, 2, 3, 4]);
    expect(snapshot.pins.map((item) => item.observationId)).toEqual([2]);
    expect(snapshot.relations).toEqual([expect.objectContaining({
      sourceId: 2,
      targetId: 3,
      kind: "supersedes",
    })]);
    expect(snapshot.state).toEqual({
      nextObservationId: 6,
      nextObservationPosition: 5,
      nextSessionPosition: 1,
    });
  });
});

describe("estado portable y mappings", () => {
  test("exige mapping explicito y estrategia replace para conflictos", () => {
    const fixture = sandbox("mapping");
    const mappedRoot = path.join(fixture.root, "mac", "repo");
    const mappedDocs = path.join(fixture.root, "mac", "docs");
    fs.mkdirSync(mappedRoot, { recursive: true });
    fs.mkdirSync(mappedDocs, { recursive: true });
    writeProjects(fixture.projects, {
      alpha: {
        context: "memory",
        roots: [path.join(fixture.root, "existing")],
        defaultRoot: path.join(fixture.root, "existing"),
      },
    });
    const source: PortableProjectsSnapshot = {
      format: "malahor-projects-v1",
      schemaVersion: 1,
      projects: [{
        key: "alpha",
        context: "memory+codegraph",
        roots: ["/home/source/repo"],
        defaultRoot: "/home/source/repo",
        docsPath: "/mnt/c/source/docs",
      }],
    };

    const unmapped = previewPortableProjectsImport(source, fixture.projects, parsePortableImportDirectives([]));
    expect(unmapped.canApply).toBe(false);
    expect(unmapped.unmappedPaths).toEqual(["/home/source/repo", "/mnt/c/source/docs"]);

    const mapped = parsePortableImportDirectives([
      `map:/home/source/repo=${mappedRoot}`,
      `map:/mnt/c/source/docs=${mappedDocs}`,
    ]);
    const conflict = previewPortableProjectsImport(source, fixture.projects, mapped);
    expect(conflict.conflicts).toEqual(["alpha"]);
    expect(conflict.canApply).toBe(false);

    const replace = previewPortableProjectsImport(source, fixture.projects, parsePortableImportDirectives([
      `map:/home/source/repo=${mappedRoot}`,
      `map:/mnt/c/source/docs=${mappedDocs}`,
      "replace:alpha",
    ]));
    expect(replace.canApply).toBe(true);
    expect(replace.next.alpha).toEqual({
      context: "memory+codegraph",
      roots: [mappedRoot],
      defaultRoot: mappedRoot,
      docs: { path: mappedDocs },
    });
  });

  test("bloquea el payload completo ante un hallazgo detectable", () => {
    const fixture = sandbox("secret");
    const db = fixtureDb();
    const marker = ["Bearer", ["SYNTHETIC", "PORTABLE", "TOKEN", "1234567890"].join("")].join(" ");
    db.observations[0]!.content = marker;
    writeLegacy(fixture.legacy, db);
    writeProjects(fixture.projects, {});
    const memory = capturePortableMemory(fixture.legacy);
    const projects = capturePortableProjects(fixture.projects);
    const payload = createPortablePayload(memory.snapshot, projects.snapshot, "2026-11-25T00:00:00.000Z");

    expect(portableSecretFindings(payload)).toEqual(["bearer-token"]);
    expect(payload.memory.observations).toHaveLength(db.observations.length);
  });
});

describe("hooks portable", () => {
  test("export siempre exige y consume aprobacion one-shot", () => {
    const fixture = sandbox("hook-export");
    const destination = path.join(fixture.root, "transfer.mhpkg");
    const context = hookContext(fixture.home, {
      event: "memory.portable.export.apply",
      targetPaths: [destination],
      metadata: {
        sourceFingerprint: "b".repeat(64),
        destination,
      },
    });

    expect(runHooks(context).decision).toBe("ask");
    expect(() => assertHooksAllowed(context)).toThrow(/ASK pendiente/i);
    const approval = grantApproval(context, { channel: "cli-tty" });
    expect(assertHooksAllowed({ ...context, approval: approval.nonce }).decision).toBe("allow");
    expect(() => assertHooksAllowed({ ...context, approval: approval.nonce })).toThrow(/consumida|ASK pendiente/i);
  });

  test("import no permite omitir preview aunque la politica general lo desactive", () => {
    const fixture = sandbox("hook-import");
    const missing = hookContext(fixture.home, {
      event: "memory.portable.import.apply",
      security: { destructive: { requirePreview: false } },
      confirmation: "IMPORT:AAAAAAAAAAAAAAAA",
      metadata: {},
    });
    expect(runHooks(missing).decision).toBe("deny");

    const valid = hookContext(fixture.home, {
      event: "memory.portable.import.apply",
      security: { destructive: { requirePreview: false } },
      confirmation: "IMPORT:AAAAAAAAAAAAAAAA",
      metadata: {
        previewToken: "a".repeat(64),
        packageHash: "b".repeat(64),
        destinationFingerprint: "c".repeat(64),
        mappingsFingerprint: "d".repeat(64),
        requiresConfirmation: "IMPORT:AAAAAAAAAAAAAAAA",
        backupRequired: true,
        revalidated: true,
      },
    });
    expect(runHooks(valid).decision).toBe("ask");
  });
});

describe("import sandbox", () => {
  test("converge a SQLite, conserva configuracion local y publica projects mapeado", () => {
    const source = sandbox("source");
    const sourceRoot = "/home/source/repo";
    const sourceDocs = "/mnt/c/source/docs";
    writeLegacy(source.legacy);
    writeProjects(source.projects, {
      alpha: {
        context: "memory+codegraph",
        roots: [sourceRoot],
        defaultRoot: sourceRoot,
        docs: { path: sourceDocs },
      },
    });
    const sourceMemory = capturePortableMemory(source.legacy);
    const sourceProjects = capturePortableProjects(source.projects);
    const payload = createPortablePayload(
      sourceMemory.snapshot,
      sourceProjects.snapshot,
      "2026-11-25T00:00:00.000Z",
    );

    const target = sandbox("target");
    const targetRoot = path.join(target.root, "repos", "alpha");
    const targetDocs = path.join(target.root, "vault", "alpha");
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.mkdirSync(targetDocs, { recursive: true });
    writeLegacy(target.legacy, { observations: [], sessions: [], nextId: 1 });
    writeProjects(target.projects, {});
    const config = path.join(target.home, "config.jsonc");
    const opencode = path.join(target.root, "opencode.jsonc");
    const configBytes = "{\n  // local target config\n  \"execution\": { \"intervention\": \"ejecutar\" }\n}\n";
    const opencodeBytes = "{\"provider\":\"local-only\"}\n";
    fs.writeFileSync(config, configBytes, { mode: 0o600 });
    fs.writeFileSync(opencode, opencodeBytes, { mode: 0o600 });
    const directives = parsePortableImportDirectives([
      `map:${sourceRoot}=${targetRoot}`,
      `map:${sourceDocs}=${targetDocs}`,
    ]);
    const packageHash = "e".repeat(64);
    const preview = previewPortableImport(payload, {
      packageSha256: packageHash,
      directives,
      projectsFile: target.projects,
      legacyMemoryFile: target.legacy,
      malahorHome: target.home,
    });
    expect(preview.canApply).toBe(true);

    const result = applyPortableImport({
      packageSha256: packageHash,
      payload,
      directives,
      projectsFile: target.projects,
      legacyMemoryFile: target.legacy,
      backupsDirectory: target.backups,
      malahorHome: target.home,
      expectedPreviewToken: preview.previewToken,
    });

    expect(result.applied).toBe(true);
    expect(memoryLocation(target.legacy).backend).toBe("sqlite");
    const restored = capturePortableMemory(target.legacy);
    expect(restored.snapshot.observations).toEqual(sourceMemory.snapshot.observations);
    expect(restored.snapshot.sessions).toEqual(sourceMemory.snapshot.sessions);
    expect(loadProjectsFile(target.projects).alpha).toEqual({
      context: "memory+codegraph",
      roots: [targetRoot],
      defaultRoot: targetRoot,
      docs: { path: targetDocs },
    });
    expect(fs.readFileSync(config, "utf8")).toBe(configBytes);
    expect(fs.readFileSync(opencode, "utf8")).toBe(opencodeBytes);
  });

  test("un fallo inyectado despues de memoria revierte proveedor y proyectos", () => {
    const source = sandbox("rollback-source");
    writeLegacy(source.legacy);
    writeProjects(source.projects, {});
    const sourceMemory = capturePortableMemory(source.legacy);
    const sourceProjects = capturePortableProjects(source.projects);
    const payload = createPortablePayload(
      sourceMemory.snapshot,
      sourceProjects.snapshot,
      "2026-11-25T00:00:00.000Z",
    );
    const target = sandbox("rollback-target");
    writeLegacy(target.legacy, { observations: [], sessions: [], nextId: 1 });
    writeProjects(target.projects, {});
    const originalProjects = fs.readFileSync(target.projects, "utf8");
    const directives = parsePortableImportDirectives([]);
    const packageHash = "f".repeat(64);
    const preview = previewPortableImport(payload, {
      packageSha256: packageHash,
      directives,
      projectsFile: target.projects,
      legacyMemoryFile: target.legacy,
      malahorHome: target.home,
    });

    expect(() => applyPortableImport({
      packageSha256: packageHash,
      payload,
      directives,
      projectsFile: target.projects,
      legacyMemoryFile: target.legacy,
      backupsDirectory: target.backups,
      malahorHome: target.home,
      expectedPreviewToken: preview.previewToken,
      failAfter: "memory",
    })).toThrow(/Fallo sintetico/i);
    expect(memoryLocation(target.legacy).backend).toBe("json");
    expect(fs.readFileSync(target.projects, "utf8")).toBe(originalProjects);
    expect(fs.existsSync(memoryV2Paths(target.legacy).database)).toBe(false);
  });
});

describe("dispatch de memory", () => {
  test("portable falla cerrado antes del seam Horiel", () => {
    let called = false;
    expect(() => runMemory({
      action: "portable",
      args: ["help"],
      all: false,
      confirm: undefined,
      dryRun: false,
      yes: false,
    }, {
      horiel: async () => {
        called = true;
        return "";
      },
    })).toThrow(/Horiel.*no tiene fallback/i);
    expect(called).toBe(false);
  });
});
