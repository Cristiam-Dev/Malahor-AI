import fs from "node:fs";
import path from "node:path";

import {
  normalizePlanPreflight,
  type PlannedAction,
  type PlanVerificationV1,
} from "../cli/core/planning";

interface PlanningPreflightInput {
  root: string;
  directory: string;
  actions: PlannedAction[];
  verification?: unknown;
  preflight?: unknown;
}

export function validatePlanningPreflight(value: unknown): void {
  if (!isRecord(value)) throw new Error("Preflight del plan inválido: se espera un objeto.");
  const input = value as unknown as PlanningPreflightInput;
  if (typeof input.root !== "string" || !input.root.trim()
    || typeof input.directory !== "string" || !input.directory.trim()
    || !Array.isArray(input.actions)) {
    throw new Error("Preflight del plan inválido: falta la raíz, el directorio o las acciones.");
  }
  const normalized = normalizePlanPreflight(
    input.preflight,
    input.actions,
    input.verification as PlanVerificationV1 | undefined,
  );
  if (!normalized.preflight) {
    if (input.actions.some((action) => action.action === "edit")) {
      throw new Error("Preflight inválido: un plan con ediciones requiere preflight verificado.");
    }
    return;
  }
  const root = fs.realpathSync(input.root);
  const base = path.resolve(input.directory);
  const editActions = input.actions.filter((action) => action.action === "edit");
  const mayCreate = new Set<string>();
  for (const edit of normalized.preflight.edits) {
    const action = editActions.find((item) => item.key === edit.key);
    if (!action) throw new Error(`Preflight inválido: la edición ${edit.key} no tiene acción.`);
    const target = path.resolve(base, edit.path);
    if (target !== path.resolve(action.resource)) {
      throw new Error(`Preflight inválido: la edición ${edit.key} no coincide con el recurso de la acción.`);
    }
    assertInside(target, root, edit.path);
    if (edit.existence === "must-exist") {
      const stat = lstatRegular(target, edit.path);
      if (!stat.isFile()) throw new Error(`Preflight inválido: ${edit.path} no es un archivo regular.`);
      if (stat.size > 2 * 1024 * 1024) throw new Error(`Preflight inválido: ${edit.path} excede 2 MB.`);
      const content = fs.readFileSync(target, "utf8");
      const occurrences = content.split(edit.block!).length - 1;
      if (occurrences !== 1) {
        throw new Error(`Preflight inválido: el bloque de ${edit.key} aparece ${occurrences} veces en ${edit.path}; debe aparecer exactamente una vez.`);
      }
    } else {
      if (fs.existsSync(target)) throw new Error(`Preflight inválido: may-create exige que ${edit.path} no exista.`);
      mayCreate.add(target);
      const parent = path.dirname(target);
      assertInside(parent, root, edit.path);
      if (!lstatRegular(parent, edit.path).isDirectory()) {
        throw new Error(`Preflight inválido: el directorio padre de ${edit.path} no existe.`);
      }
    }
  }
  for (const edit of normalized.preflight.edits) {
    for (const [field, entries] of [["consumers", edit.consumers], ["tests", edit.tests]] as const) {
      for (const entry of entries) {
        const target = path.resolve(base, entry);
        assertInside(target, root, entry);
        if (!fs.existsSync(target)) {
          if (!mayCreate.has(target)) throw new Error(`Preflight inválido: ${field} ${entry} no existe.`);
          continue;
        }
        lstatRegular(target, entry);
      }
    }
  }
  if (normalized.preflight.edits.some((edit) => isCodePath(edit.path))
    && normalized.preflight.edits.every((edit) => edit.tests.length === 0)) {
    throw new Error("Preflight inválido: una edición de código requiere al menos un test declarado.");
  }
  const verification = normalized.verification;
  if (!verification) throw new Error("Preflight inválido: falta verification.");
  const cwd = path.resolve(base, verification.cwd);
  assertInside(cwd, root, "verification.cwd");
  if (!lstatRegular(cwd, "verification.cwd").isDirectory()) {
    throw new Error("Preflight inválido: verification.cwd no es un directorio.");
  }
  for (const test of verification.tests) {
    for (const target of test.targets) {
      const resolved = path.resolve(base, target);
      assertInside(resolved, root, target);
      if (!fs.existsSync(resolved)) {
        if (!mayCreate.has(resolved)) throw new Error(`Preflight inválido: el target ${target} no existe.`);
        continue;
      }
      lstatRegular(resolved, target);
    }
  }
}

function assertInside(target: string, root: string, label: string): void {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`Preflight inválido: ${label} queda fuera de la raíz del proyecto.`);
}

function lstatRegular(target: string, label: string): NonNullable<ReturnType<typeof fs.lstatSync>> {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`Preflight inválido: ${label} no puede ser un symlink.`);
  return stat;
}

function isCodePath(value: string): boolean {
  return /(^|\/)(src|tests|scripts)\//.test(value) || /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
