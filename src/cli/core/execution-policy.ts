import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import type { MalahorExecutionPolicy, MalahorIntervention } from "./config";

// Parse publico para flags CLI como --policy-after.
export function parseExecutionLevel(value: string, fallback: MalahorIntervention): MalahorIntervention {
  return parseIntervention(value, fallback);
}

export async function promptExecutionPolicy(current: MalahorExecutionPolicy, yes: boolean): Promise<MalahorExecutionPolicy> {
  if (yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    return current;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    process.stdout.write("\nModo de Malahor (una sola politica de intervencion):\n");
    process.stdout.write("  1) ejecutar   Ejecutor: plan visible y aprobacion previa antes de ejecutar.\n");
    process.stdout.write("  2) guiar      Asistente: guia por pasos; revision del plan y segunda confirmacion antes de ejecutar.\n");
    process.stdout.write("  3) acompanar  Asesor: solo concepto, sin pasos ni ejecucion.\n");

    const answer = await rl.question(`Selecciona nivel [${current.intervention}]: `);
    const intervention = parseIntervention(answer, current.intervention);
    const verification = intervention === "acompanar" ? false : await promptVerification(rl, current.verification);

    return reviseExecutionPolicy(current, intervention, verification);
  } finally {
    rl.close();
  }
}

export function reviseExecutionPolicy(
  current: MalahorExecutionPolicy,
  intervention: MalahorIntervention,
  verification: boolean,
): MalahorExecutionPolicy {
  const effectiveVerification = intervention === "acompanar" ? false : verification;
  if (intervention === current.intervention && effectiveVerification === current.verification) return current;
  return { intervention, verification: effectiveVerification, revision: randomBytes(16).toString("hex") };
}

function parseIntervention(value: string, fallback: MalahorIntervention): MalahorIntervention {
  const normalized = value.trim().toLowerCase();

  if (!normalized) return fallback;
  if (normalized === "1" || normalized === "ejecutar") return "ejecutar";
  if (normalized === "2" || normalized === "guiar") return "guiar";
  if (normalized === "3" || normalized === "acompanar") return "acompanar";

  throw new Error('Nivel invalido. Usa "ejecutar", "guiar" o "acompanar".');
}

async function promptVerification(
  rl: ReturnType<typeof createInterface>,
  current: boolean,
): Promise<boolean> {
  const answer = await rl.question(`Permitir verificacion read-only? [${current ? "si" : "no"}]: `);
  const normalized = answer.trim().toLowerCase();

  if (!normalized) return current;
  if (normalized === "si" || normalized === "s" || normalized === "yes" || normalized === "y") return true;
  if (normalized === "no" || normalized === "n") return false;

  throw new Error('Verificacion invalida. Usa "si" o "no".');
}
