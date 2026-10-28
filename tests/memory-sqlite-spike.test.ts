import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface ProbeResult {
  driver: string;
  status: string;
  checks?: string[];
  schemaSha256?: string;
  sandbox: string;
}

interface SpikeReport {
  passed: boolean;
  directory: string;
  results: ProbeResult[];
  interoperability: Array<{ from: string; via: string; write: { status: string }; read: { status: string } }>;
}

let report: SpikeReport;

beforeAll(() => {
  const result = spawnSync("node", [path.resolve(import.meta.dir, "../scripts/spikes/memory-sqlite/run.mjs")], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  report = JSON.parse(result.stdout) as SpikeReport;
}, 60_000);

describe("T-5.3.1 SQLite spike aislado", () => {
  test("Node y Bun ejecutan el mismo DDL y contrato", () => {
    expect(report.passed).toBe(true);
    for (const driver of ["node", "bun"]) {
      const result = report.results.find((r) => r.driver === driver);
      expect(result?.status).toBe("passed");
      expect(result?.checks).toHaveLength(16);
    }
    expect(report.results[0].schemaSha256).toBe(report.results[1].schemaSha256);
  });

  test("preserva campos, IDs, sesiones repetidas y nextId", () => {
    for (const result of report.results.filter((r) => r.status === "passed")) {
      expect(result.checks).toContain("legacy-fields-order-and-id-gaps");
      expect(result.checks).toContain("sessions-preserve-duplicates-and-order");
      expect(result.checks).toContain("next-id-is-not-max-id-plus-one");
    }
  });

  test("verifica FTS, fronteras de scope y rollback", () => {
    for (const result of report.results.filter((r) => r.status === "passed")) {
      expect(result.checks).toContain("fts-update-and-delete-triggers");
      expect(result.checks).toContain("exact-subtree-and-neighbor-boundaries");
      expect(result.checks).toContain("transaction-rolls-back-data-and-fts");
      expect(result.checks).toContain("sqlite-foreign-key-and-fts-integrity");
    }
  });

  test("Node y Bun intercambian escrituras e indice en ambos sentidos", () => {
    expect(report.interoperability).toHaveLength(2);
    for (const result of report.interoperability) {
      expect(result.write.status).toBe("passed");
      expect(result.read.status).toBe("passed");
    }
  });

  test("solo deja artefactos privados en su sandbox", () => {
    expect(path.basename(report.directory)).toStartWith("malahor-memory-sqlite-");
    expect(fs.existsSync(path.join(report.directory, "report.json"))).toBe(true);
    for (const result of report.results.filter((r) => r.status === "passed")) {
      expect(path.dirname(result.sandbox)).toBe(report.directory);
      expect(fs.existsSync(path.join(result.sandbox, "backup.sqlite"))).toBe(true);
      expect(result.checks).toContain("readonly-open-rejects-writes");
      expect(result.checks).toContain("consistent-backup-with-live-wal");
    }
  });

  test("rechaza usar la raiz del repo como destino de una base", () => {
    const root = path.resolve(import.meta.dir, "..");
    const result = spawnSync("node", [path.join(root, "scripts/spikes/memory-sqlite/worker.mjs"), "node", "probe", root], {
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sandbox generado");
  });
});
