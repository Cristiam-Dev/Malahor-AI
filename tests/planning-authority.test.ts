import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  createPlanningAuthority,
  loadPlanningAuthority,
  planningKeyPath,
} from "../src/cli/core/planning-authority";
import { proposePlan, validState } from "../src/cli/core/planning";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-planning-authority-"));
  roots.push(root);
  return path.join(root, "secrets");
}

describe("autoridad persistente de planning", () => {
  test("crea una clave privada y verifica recibos tras recargarla", () => {
    const directory = fixture();
    const first = loadPlanningAuthority(directory);
    const proof = first.sign("plan-v3");
    const second = loadPlanningAuthority(directory);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.verify("plan-v3", proof)).toBe(true);
    expect(second.verify("otro", proof)).toBe(false);
    const state = proposePlan({
      sessionID: "ses_authority_restart", project: "demo", mode: "executor", policyRevision: "1".repeat(32),
    }, {
      summary: "persistente",
      steps: ["validar"],
      presentation: {
        objective: "Validar la autoridad persistente del plan.",
        outcome: "La firma sigue siendo verificable después de recargar la clave.",
        steps: [{
          title: "Validar la firma",
          description: "Recargar la autoridad y verificar el estado firmado.",
        }],
        impact: [{ area: "Autoridad", description: "El fixture conserva continuidad entre reinicios." }],
        risk: {
          level: "low",
          categories: [],
          summary: "La prueba usa una clave privada aislada.",
          details: "No se leen ni modifican claves externas.",
        },
        exclusions: ["No se modifican claves externas"],
        completionCriteria: ["La segunda autoridad verifica el estado firmado por la primera"],
      },
      actions: [{ action: "shell", resource: "echo ok" }],
    },
    Date.now(), "msg-authority", undefined, first);
    expect(validState(state, second)).toBe(true);

    for (const field of ["outcome", "impact", "risk"] as const) {
      const tampered = structuredClone(state) as unknown as {
        plan: { presentation: Record<string, unknown> };
      };
      tampered.plan.presentation[field] = field === "outcome"
        ? "Resultado adulterado."
        : field === "impact"
          ? [{ area: "Datos", description: "Impacto adulterado." }]
          : {
            level: "high", categories: ["security"],
            summary: "Riesgo adulterado.", details: "No pertenece a la revisión firmada.",
          };
      expect(validState(tampered, second)).toBe(false);
    }
    expect(fs.lstatSync(planningKeyPath(directory)).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(planningKeyPath(directory)).mode & 0o777).toBe(0o600);
    }
  });

  test("rechaza claves de tamaño incorrecto, symlinks y permisos amplios", () => {
    expect(() => createPlanningAuthority(new Uint8Array(31))).toThrow(/32 bytes/);
    const directory = fixture();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const external = path.join(path.dirname(directory), "external.key");
    fs.writeFileSync(external, `${"a".repeat(64)}\n`, { mode: 0o600 });
    fs.symlinkSync(external, planningKeyPath(directory));
    expect(() => loadPlanningAuthority(directory)).toThrow(/regular privado/);

    fs.unlinkSync(planningKeyPath(directory));
    fs.writeFileSync(planningKeyPath(directory), `${"b".repeat(64)}\n`, { mode: 0o666 });
    if (process.platform !== "win32") expect(() => loadPlanningAuthority(directory)).toThrow(/permisos privados/);
  });
});
