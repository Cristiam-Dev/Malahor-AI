import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MnemoDb } from "../src/mnemo/db";

export interface TestEnvSnapshot {
  root: string;
  previousMalahorHome: string | undefined;
  previousMalahorConfig: string | undefined;
}

export function setupTestEnv(): TestEnvSnapshot {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "malahor-mnemo-scopes-"));
  const previousMalahorHome = process.env.MALAHOR_HOME;
  const previousMalahorConfig = process.env.MALAHOR_CONFIG;
  process.env.MALAHOR_HOME = path.join(root, ".malahor");
  process.env.MALAHOR_CONFIG = path.join(root, "config.jsonc");
  fs.writeFileSync(process.env.MALAHOR_CONFIG, "{}\n", "utf8");
  return { root, previousMalahorHome, previousMalahorConfig };
}

export function cleanupTestEnv(snapshot: TestEnvSnapshot): void {
  if (snapshot.previousMalahorHome === undefined) delete process.env.MALAHOR_HOME;
  else process.env.MALAHOR_HOME = snapshot.previousMalahorHome;
  if (snapshot.previousMalahorConfig === undefined) delete process.env.MALAHOR_CONFIG;
  else process.env.MALAHOR_CONFIG = snapshot.previousMalahorConfig;
  fs.rmSync(snapshot.root, { recursive: true, force: true });
}

export function fixtureDb(): MnemoDb {
  return {
    observations: [
      observation(1, "global", "Preferencia general", "Respuestas concretas", "preferencia,global"),
      observation(2, "acme", "Politica de empresa", "No guardar secretos", "seguridad,empresa"),
      observation(3, "acme/store", "Arquitectura ecommerce", "Backend y frontend comparten contratos", "arquitectura,contratos"),
      observation(4, "acme/store/checkout/payments", "Validacion de pagos", "Validar la orden antes de iniciar la transaccion", "pagos,validacion,orden"),
      observation(5, "acme/store/checkout/coupons", "Nueva feature cupones", "Aplicar descuentos despues de validar elegibilidad", "cupones,checkout"),
    ],
    sessions: [
      { project: "acme/store", summary: "Sesion sobre arquitectura", created_at: "2026-10-08T10:00:00.000Z" },
    ],
    nextId: 6,
  };
}

function observation(id: number, project: string, title: string, content: string, tags: string) {
  return {
    id,
    project,
    type: "general" as const,
    title,
    content,
    tags,
    created_at: `2026-10-0${id}T10:00:00.000Z`,
  };
}
