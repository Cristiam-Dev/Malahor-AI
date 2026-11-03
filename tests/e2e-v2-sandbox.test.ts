import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  pluginReportFromEvidence,
  runV2SandboxE2E,
  type V2SandboxReport,
} from "./fixtures/e2e-v2-sandbox";

const TIMEOUT_MS = 15 * 60_000;
const COMMIT_MESSAGE = "🧪 test(e2e): valida sandbox v2";
const CRITICAL_CAPABILITIES = [
  "permission.evaluate",
  "shell.create.before",
  "tool.execute.before",
  "code-mode.read-only",
  "commit.workflow",
  "point-action.approval",
  "planning.v4",
  "session.prompt.before",
  "session.context.before",
  "session.compaction.before",
  "session.generate.before",
  "session.title.before",
  "session.model-request.before",
  "session.http-request.before",
] as const;

function isAtOrWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

test("AUTH-01 A4 rechaza estado persistido sano cuando el inventario vivo marca Malahor failed", () => {
  const report = pluginReportFromEvidence({
    data: [{
      id: "malahor",
      state: {
        status: "failed",
        error: { reference: "failure_synthetic", detail: "sensitive host stack must not escape" },
      },
    }],
  }, {
    host: "v2",
    criticalGaps: [],
    capabilities: { "code-mode.read-only": true, "planning.v4": true },
  });

  expect(report.loaded, "plugin-state.json no puede ocultar un fallo del inventario vivo").toBe(false);
  expect(report.live).toEqual({ present: true, status: "failed", failureReference: true });
  expect(report.persisted).toEqual({
    host: "v2",
    criticalGaps: [],
    capabilities: { "code-mode.read-only": true, "planning.v4": true },
  });
  expect(JSON.stringify(report)).not.toContain("sensitive host stack must not escape");
});

test("T-5.5.2 valida Malahor completo en un host OpenCode V2 real y aislado", async () => {
  const rootOverride = process.env.MALAHOR_E2E_ROOT?.trim();
  const commitRequested = process.env.MALAHOR_E2E_COMMIT === "1";
  const keepRequested = process.env.MALAHOR_E2E_KEEP === "1";
  const options: NonNullable<Parameters<typeof runV2SandboxE2E>[0]> = {
    ...(rootOverride ? { root: rootOverride } : {}),
    ...(commitRequested ? { commit: true } : {}),
    ...(keepRequested ? { keep: true } : {}),
  };

  const report: V2SandboxReport = await runV2SandboxE2E(options);
  const tempBase = path.resolve("/tmp/opencode");
  const sandboxRoot = path.resolve(report.sandbox.root);
  const workspace = path.resolve(report.sandbox.workspace);

  expect(sandboxRoot, "el helper debe informar una raíz sandbox distinta del directorio temporal base").not.toBe(tempBase);
  expect(isAtOrWithin(tempBase, sandboxRoot), `raíz fuera de /tmp/opencode: ${sandboxRoot}`).toBe(true);
  if (rootOverride) {
    expect(sandboxRoot, "MALAHOR_E2E_ROOT debe llegar a la opción root del helper").toBe(path.resolve(rootOverride));
  }
  expect(isAtOrWithin(sandboxRoot, workspace), `workspace fuera del sandbox: ${workspace}`).toBe(true);
  expect(report.sandbox.realDataTouched, "el E2E tocó datos reales fuera del sandbox").toBe(false);
  expect(report.sandbox.networkDownloads, "el E2E no debe descargar nada de la red").toBe(0);
  expect(report.sandbox.persistedCredentials, "el E2E dejó credenciales persistidas").toEqual([]);
  expect(report.sandbox.nodeModules.before, "falta fingerprint inicial de node_modules").toMatch(/^[a-f0-9]{64}$/);
  expect(report.sandbox.nodeModules.after, "falta fingerprint final de node_modules").toBe(report.sandbox.nodeModules.before);
  expect(report.sandbox.nodeModules.unchanged, "build/tests escribieron bajo node_modules").toBe(true);

  expect(report.host.real, "se requiere un proceso OpenCode real, no un host simulado").toBe(true);
  expect(report.host.kind, `host OpenCode inesperado: ${report.host.kind}`).toBe("v2");
  expect(report.host.version, "el host real debe informar una versión semántica").toMatch(/^2\.[0-9]+\.[0-9]+/);
  expect(
    report.plugin.loaded,
    `el host V2 real no cargó el plugin Malahor; inventario=${JSON.stringify(report.plugin.inventory)}`,
  ).toBe(true);
  expect(report.plugin.live, "el inventario vivo no mantuvo Malahor activo tras reconciliar tools").toEqual({
    present: true,
    status: "active",
    failureReference: false,
  });
  expect(report.plugin.persisted.host, "el diagnóstico persistido no corresponde a V2").toBe("v2");
  expect(
    report.plugin.persisted.criticalGaps,
    `capacidades críticas ausentes: ${report.plugin.persisted.criticalGaps.join(", ")}`,
  ).toEqual([]);
  for (const capability of CRITICAL_CAPABILITIES) {
    expect(report.plugin.persisted.capabilities[capability], `capacidad crítica inactiva: ${capability}`).toBe(true);
  }

  expect(report.agents.primary, "contrato runtime del agente primario inválido").toMatchObject({
    id: "malahor",
    mode: "primary",
    visible: true,
    subagent: { denyAll: true, allowPatterns: ["malahor-*"] },
  });
  expect(
    report.agents.specialists.map(({ id, mode }) => ({ id, mode })).sort((left, right) => left.id.localeCompare(right.id)),
    "deben estar instalados exactamente los dos especialistas runtime",
  ).toEqual([
    { id: "malahor-diagnostico", mode: "subagent" },
    { id: "malahor-testing", mode: "subagent" },
  ]);
  for (const specialist of report.agents.specialists) {
    expect(specialist.subagentDenied, `${specialist.id} todavía puede delegar a otro subagente`).toBe(true);
  }
  expect(report.agents.testingPermission.fixture, "malahor-testing no conserva deny→allow para fixtures de test").toEqual({
    resource: "tests/fixtures/e2e-probe.ts",
    matchedEffects: ["deny", "allow"],
    effect: "allow",
  });
  expect(report.agents.testingPermission.production, "malahor-testing permite editar código de producción").toEqual({
    resource: "src/e2e-probe.ts",
    matchedEffects: ["deny"],
    effect: "deny",
  });

  expect(report.memory.preview.wrote, "el preview de migración escribió en disco").toBe(false);
  expect(report.memory.migration, "la migración no activó el backend SQLite").toMatchObject({
    state: "active",
    backend: "sqlite",
  });
  expect(report.memory.migration.jsonHashBefore, "falta hash SHA-256 del JSON legado").toMatch(/^[a-f0-9]{64}$/);
  expect(report.memory.migration.jsonHashAfter, "la migración modificó el JSON legado").toBe(
    report.memory.migration.jsonHashBefore,
  );
  expect(report.memory.before.observations, "el fixture de memoria debe contener observaciones").toBeGreaterThan(0);
  expect(report.memory.before.ids, "cada observación inicial debe conservar su ID").toHaveLength(
    report.memory.before.observations,
  );
  expect(report.memory.before.sessions.length, "el fixture de memoria debe contener sesiones").toBeGreaterThan(0);
  expect(report.memory.after, "conteos, IDs o sesiones cambiaron durante la migración").toEqual(report.memory.before);
  expect(report.memory.checks, "alguna superficie de memoria V2 no pasó").toEqual({
    cli: true,
    context: true,
    mcp: true,
    fts: true,
  });
  expect(report.memory.retry, "el reintento de migración debe ser un no-op sin escrituras").toEqual({
    action: "no-op",
    wrote: false,
  });
  expect(report.memory.postMigrationWrite, "la escritura posterior o el bloqueo de rollback automático falló").toEqual({
    persisted: true,
    automaticRollbackBlocked: true,
  });

  expect(report.codegraph.setupManaged, "CodeGraph no quedó instalado como recurso gestionado").toBe(true);
  expect(report.codegraph.indexManaged, "CodeGraph no produjo un índice gestionado").toBe(true);
  expect(isAtOrWithin(sandboxRoot, report.codegraph.indexPath), "el índice CodeGraph escapó del sandbox").toBe(true);
  expect(isAtOrWithin(workspace, report.codegraph.indexPath), "el índice CodeGraph quedó dentro del workspace").toBe(false);
  expect(report.codegraph.symbol, "el símbolo sintético no fue encontrado por MCP").toMatchObject({
    synthetic: true,
    found: true,
    via: "mcp",
  });
  expect(report.codegraph.symbol.name.length, "el reporte no identifica el símbolo sintético encontrado").toBeGreaterThan(0);
  expect(report.codegraph.mcp, "el MCP de CodeGraph debe ser read-only y no reindexar").toEqual({
    readOnly: true,
    reindexWrites: 0,
  });

  expect(report.codeMode.result, "el recorrido A4 no produjo el resultado equivalente").toEqual({
    fileCount: 1,
    matchCount: 1,
    hasSymbol: true,
  });
  expect(report.codeMode.internalCalls, "A4 debe auditar exactamente glob, grep y read internos").toEqual([
    { tool: "repo.glob", status: "completed" },
    { tool: "repo.grep", status: "completed" },
    { tool: "repo.read", status: "completed" },
  ]);
  expect(report.codeMode.permissionCalls, "cada llamada interna debe cruzar permission.assert").toBe(3);
  expect(report.codeMode.permissionsPersisted, "A4 no puede guardar permisos con save").toBe(false);
  expect(report.codeMode.auditedCalls, "faltan auditorías call.after para llamadas internas").toBeGreaterThanOrEqual(3);

  expect(report.economy.baseline.modelRounds).toBe(3);
  expect(report.economy.baseline.outerCalls).toBe(3);
  expect(report.economy.codeMode.modelRounds).toBeLessThanOrEqual(2);
  expect(report.economy.codeMode.outerCalls).toBeLessThanOrEqual(2);
  expect(report.economy.intermediateReductionPercent, "A4 no redujo al menos 30 % de bytes intermedios").toBeGreaterThanOrEqual(30);
  expect(report.economy.codeMode.estimatedTokens, "la estimación reproducible de A4 supera el baseline").toBeLessThanOrEqual(
    report.economy.baseline.estimatedTokens,
  );
  expect(report.economy.equivalentResult, "baseline y A4 no son funcionalmente equivalentes").toBe(true);
  expect(report.economy.realTokens, "no deben inventarse tokens reales cuando el host no los reporta").toEqual({
    available: false,
    baseline: null,
    codeMode: null,
    savingsClaimed: false,
  });

  expect(report.git.performed, "el modo de commit del reporte no coincide con MALAHOR_E2E_COMMIT").toBe(commitRequested);
  expect(isAtOrWithin(sandboxRoot, report.git.repository), "Git operó fuera del repositorio sandbox").toBe(true);
  expect(report.git.pushes, "el E2E nunca debe ejecutar push").toBe(0);
  if (commitRequested) {
    expect(report.git.message, "mensaje del commit E2E inesperado").toBe(COMMIT_MESSAGE);
    expect(report.git.head, "el commit real debe dejar un HEAD válido").toMatch(/^[a-f0-9]{40,64}$/);
    expect(report.git.clean, "el commit real debe dejar limpio el árbol sandbox").toBe(true);
  }

  expect(report.doctor, "doctor debe terminar listo, sin fallos ni advertencias").toEqual({
    ready: true,
    fails: 0,
    warnings: 0,
  });

  expect(fs.existsSync(report.reportPath), `no existe el reporte E2E: ${report.reportPath}`).toBe(true);
  const persistedReport = fs.readFileSync(report.reportPath, "utf8");
  expect(persistedReport.length, "el reporte E2E persistido está vacío").toBeGreaterThan(0);
  expect(persistedReport, "el reporte E2E contiene credenciales o payloads secretos").not.toMatch(
    /password|authorization|bearer|synthetic-secret/i,
  );

  expect(report.cleanup.processesRemaining, "quedaron procesos del host o MCP vivos").toBe(0);
  expect(report.cleanup.environmentRestored, "el helper no restauró el entorno del proceso").toBe(true);
  expect(report.cleanup.rootPreserved, "la raíz solo debe conservarse con MALAHOR_E2E_KEEP=1").toBe(keepRequested);
  expect(fs.existsSync(sandboxRoot), "la presencia final de la raíz no coincide con la opción keep").toBe(keepRequested);
}, TIMEOUT_MS);
