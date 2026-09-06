import { createInterface } from "node:readline/promises";
import type { MalahorExecutionPolicy, MalahorIntervention } from "./config";

export async function promptExecutionPolicy(current: MalahorExecutionPolicy, yes: boolean): Promise<MalahorExecutionPolicy> {
  if (yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    return current;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    process.stdout.write("\nNivel de intervencion en ejecucion:\n");
    process.stdout.write("  1) ejecutar   Aplica cambios y puede verificar leyendo archivos.\n");
    process.stdout.write("  2) guiar      Indica pasos concretos, archivos o lineas a tocar.\n");
    process.stdout.write("  3) acompanar  Solo da la solucion, sin rutas, archivos ni verificacion.\n");

    const answer = await rl.question(`Selecciona nivel [${current.intervention}]: `);
    const intervention = parseIntervention(answer, current.intervention);
    const verification = intervention === "acompanar" ? false : await promptVerification(rl, current.verification);

    return { intervention, verification };
  } finally {
    rl.close();
  }
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
