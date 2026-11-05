import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../cli/core/config";
import type { PlanLevel, PlannedAction } from "../cli/core/planning";
import type { PlanPresentationInput } from "../cli/core/plan-presentation";
import { resolveDocsProject } from "../docs/resolver";

interface ArchitectureContractModuleV1 {
  id: string;
  path: string;
  layer: string;
  allowedDependencies: string[];
}

interface ArchitectureContractForbiddenV1 {
  from: string;
  to: string;
}

export interface ArchitectureContractV1 {
  version: 1;
  modules: ArchitectureContractModuleV1[];
  forbidden: ArchitectureContractForbiddenV1[];
}

export interface PlanArchitectureModuleV1 {
  id: string;
  path: string;
  layer: string;
  reason: string;
}

export interface PlanArchitectureDependencyV1 {
  from: string;
  to: string;
}

export interface PlanArchitectureChangeV1 {
  rationale: string;
  alternatives: string[];
  impact: string;
  migration: string;
  rollback: string;
}

export interface PlanArchitectureV1 {
  mode: "respect" | "change";
  contractRef: string;
  contractHash: string;
  modules: PlanArchitectureModuleV1[];
  dependencies?: PlanArchitectureDependencyV1[];
  change?: PlanArchitectureChangeV1;
}

interface ArchitectureGateInput {
  architecture?: unknown;
  actions: PlannedAction[];
  level: PlanLevel;
  presentation: PlanPresentationInput;
  project: string;
  projectRoot: string;
  directory: string;
  env?: NodeJS.ProcessEnv;
}

export function validateArchitecturePlan(value: unknown): {
  architecture: PlanArchitectureV1;
  changeHash?: string;
} {
  if (!isRecord(value)) throw new Error("Arquitectura del plan inválida: se espera un objeto.");
  const input = value as unknown as ArchitectureGateInput;
  if (!Array.isArray(input.actions) || typeof input.project !== "string" || !input.project.trim()
    || typeof input.projectRoot !== "string" || !input.projectRoot.trim()
    || typeof input.directory !== "string" || !input.directory.trim()) {
    throw new Error("Arquitectura del plan inválida: falta el proyecto, la raíz o las acciones.");
  }
  const editActions = input.actions.filter((action) => action.action === "edit");
  const architecture = normalizeArchitecture(
    input.architecture,
    editActions,
    input.level,
    input.presentation,
  );
  if (!architecture) throw new Error("Un plan con ediciones requiere architecture: contrato, módulos y decisión respect/change.");
  const contract = readArchitectureContract(
    architecture.contractRef,
    architecture.contractHash,
    input.project,
    input.directory,
    input.env,
  );
  validateAgainstContract(architecture, contract, editActions, input.projectRoot);
  return architecture.mode === "change"
    ? { architecture, changeHash: sha256(JSON.stringify(architecture)) }
    : { architecture };
}

export function readArchitectureContract(
  contractRef: string,
  contractHash: string,
  project: string,
  directory: string,
  env: NodeJS.ProcessEnv | undefined,
): ArchitectureContractV1 {
  const config = loadConfig({ ...env ?? process.env, MALAHOR_OPENCODE_DETECT: "0" }, directory);
  const docs = resolveDocsProject(config.paths, config.projects.aliases, project);
  const segments = contractRef.trim().split("/");
  if (!docs.initialized || !contractRef.endsWith(".md") || contractRef.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("El contrato de arquitectura no pertenece a la documentación canónica inicializada.");
  }
  const docsRoot = fs.realpathSync(docs.projectRoot);
  const target = path.resolve(docsRoot, contractRef);
  if (!inside(target, docsRoot)) throw new Error("El contrato de arquitectura queda fuera de la documentación canónica.");
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024
    || !inside(fs.realpathSync(target), docsRoot)) {
    throw new Error("El contrato de arquitectura debe ser un Markdown regular y acotado.");
  }
  const content = fs.readFileSync(target);
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== contractHash) throw new Error("La versión SHA-256 del contrato de arquitectura ya no coincide.");
  const match = /```json\s*\r?\n([\s\S]*?)\r?\n```/i.exec(content.toString("utf8"));
  if (!match) throw new Error("El contrato de arquitectura no contiene un bloque JSON.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    throw new Error("El bloque JSON del contrato de arquitectura no es válido.");
  }
  return normalizeContract(parsed);
}

function normalizeContract(value: unknown): ArchitectureContractV1 {
  if (!isRecord(value)) throw new Error("El contrato de arquitectura debe ser un objeto JSON.");
  assertExactKeys(value, ["version", "modules", "forbidden"], "Contrato de arquitectura");
  if (value.version !== 1) throw new Error("El contrato de arquitectura requiere version 1.");
  if (!Array.isArray(value.modules) || value.modules.length === 0 || value.modules.length > 64) {
    throw new Error("El contrato de arquitectura requiere entre 1 y 64 módulos.");
  }
  const modules: ArchitectureContractModuleV1[] = [];
  const ids = new Set<string>();
  for (const raw of value.modules) {
    if (!isRecord(raw)) throw new Error("Cada módulo del contrato debe ser un objeto.");
    assertExactKeys(raw, ["id", "path", "layer", "allowedDependencies"], "Módulo del contrato");
    const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) || ids.has(id)) {
      throw new Error("El contrato contiene un módulo no evaluable o duplicado.");
    }
    ids.add(id);
    const modulePath = normalizeContractPath(raw.path, "modules.path");
    const layer = typeof raw.layer === "string" ? raw.layer.trim() : "";
    if (!layer || layer.length > 128) throw new Error("El contrato contiene una capa inválida.");
    if (!Array.isArray(raw.allowedDependencies)
      || raw.allowedDependencies.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error("El contrato contiene dependencias permitidas inválidas.");
    }
    modules.push({
      id,
      path: modulePath,
      layer,
      allowedDependencies: raw.allowedDependencies.map((entry) => (entry as string).trim().toLowerCase()),
    });
  }
  for (const module of modules) {
    for (const dependency of module.allowedDependencies) {
      if (!ids.has(dependency) || dependency === module.id) {
        throw new Error(`El contrato referencia una dependencia permitida inexistente: ${module.id} -> ${dependency}.`);
      }
    }
  }
  if (!Array.isArray(value.forbidden)) throw new Error("El contrato requiere la lista forbidden.");
  const forbidden: ArchitectureContractForbiddenV1[] = [];
  for (const raw of value.forbidden) {
    if (!isRecord(raw)) throw new Error("Cada arista prohibida debe ser un objeto.");
    assertExactKeys(raw, ["from", "to"], "Arista prohibida");
    const from = typeof raw.from === "string" ? raw.from.trim().toLowerCase() : "";
    const to = typeof raw.to === "string" ? raw.to.trim().toLowerCase() : "";
    if (!ids.has(from) || !ids.has(to) || from === to) {
      throw new Error("El contrato contiene una arista prohibida inválida.");
    }
    forbidden.push({ from, to });
  }
  return { version: 1, modules, forbidden };
}

function normalizeArchitecture(
  value: unknown,
  editActions: PlannedAction[],
  level: PlanLevel,
  presentation: PlanPresentationInput,
): PlanArchitectureV1 | undefined {
  if (value === undefined) {
    if (editActions.length > 0) {
      throw new Error("Un plan con ediciones requiere architecture: contrato, módulos y decisión respect/change.");
    }
    return undefined;
  }
  if (editActions.length === 0) throw new Error("La arquitectura no aplica a un plan sin ediciones.");
  if (!isRecord(value)) throw new Error("Arquitectura del plan inválida: se espera un objeto.");
  assertExactKeys(value, ["mode", "contractRef", "contractHash", "modules", "dependencies", "change"], "Arquitectura del plan");
  const mode = value.mode;
  if (mode !== "respect" && mode !== "change") {
    throw new Error("Arquitectura del plan inválida: mode debe ser respect o change.");
  }
  const contractRef = normalizeDocsRef(value.contractRef, "contractRef");
  const contractHash = value.contractHash;
  if (typeof contractHash !== "string" || !/^[a-f0-9]{64}$/.test(contractHash)) {
    throw new Error("Arquitectura del plan inválida: contractHash no evaluable.");
  }
  if (!Array.isArray(value.modules) || value.modules.length === 0 || value.modules.length > 20) {
    throw new Error("Arquitectura del plan inválida: modules debe declarar entre 1 y 20 módulos.");
  }
  const modules: PlanArchitectureModuleV1[] = [];
  const moduleIds = new Set<string>();
  for (const raw of value.modules) {
    if (!isRecord(raw)) throw new Error("Arquitectura del plan inválida: cada módulo debe ser un objeto.");
    assertExactKeys(raw, ["id", "path", "layer", "reason"], "Módulo del plan");
    const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) || moduleIds.has(id)) {
      throw new Error("Arquitectura del plan inválida: módulo no evaluable o duplicado.");
    }
    moduleIds.add(id);
    const modulePath = normalizeContractPath(raw.path, "modules.path");
    const layer = typeof raw.layer === "string" ? raw.layer.trim() : "";
    const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (!layer || layer.length > 128 || !reason || reason.length > 2_000) {
      throw new Error("Arquitectura del plan inválida: layer o reason inválidos.");
    }
    modules.push({ id, path: modulePath, layer, reason });
  }
  const dependencies = normalizeDependencies(value.dependencies, moduleIds);
  if (mode === "respect") {
    if (value.change !== undefined) throw new Error("Arquitectura del plan inválida: respect no declara change.");
    const architecture: PlanArchitectureV1 = {
      mode, contractRef, contractHash, modules,
      ...(dependencies.length > 0 ? { dependencies } : {}),
    };
    assertArchitectureSize(architecture);
    return architecture;
  }
  if (level !== 2) throw new Error("Un cambio de arquitectura requiere nivel 2.");
  if (!presentation.risk.categories.includes("architecture")) {
    throw new Error("Un cambio de arquitectura requiere la categoría crítica architecture.");
  }
  const change = normalizeChange(value.change);
  const architecture: PlanArchitectureV1 = {
    mode, contractRef, contractHash, modules,
    ...(dependencies.length > 0 ? { dependencies } : {}),
    change,
  };
  assertArchitectureSize(architecture);
  return architecture;
}

function validateAgainstContract(
  architecture: PlanArchitectureV1,
  contract: ArchitectureContractV1,
  editActions: PlannedAction[],
  projectRoot: string,
): void {
  const contractById = new Map(contract.modules.map((module) => [module.id, module]));
  const planById = new Map(architecture.modules.map((module) => [module.id, module]));
  for (const module of architecture.modules) {
    const declared = contractById.get(module.id);
    if (architecture.mode === "respect") {
      if (!declared) throw new Error(`El módulo ${module.id} no existe en el contrato; usa mode change.`);
      if (path.resolve(projectRoot, module.path) !== path.resolve(projectRoot, declared.path)) {
        throw new Error(`El módulo ${module.id} no coincide con la ruta del contrato.`);
      }
    } else if (declared && path.resolve(projectRoot, module.path) !== path.resolve(projectRoot, declared.path)) {
      throw new Error(`El módulo existente ${module.id} cambia de ruta; el cambio debe declararlo explícitamente.`);
    }
  }
  const modulePaths = architecture.modules.map((module) => path.resolve(projectRoot, module.path));
  for (const action of editActions) {
    const target = path.resolve(action.resource);
    if (!modulePaths.some((modulePath) => inside(target, modulePath))) {
      throw new Error(`La edición ${action.resource} no pertenece a un módulo declarado; usa mode change.`);
    }
  }
  for (const dependency of architecture.dependencies ?? []) {
    const from = contractById.get(dependency.from);
    const to = contractById.get(dependency.to);
    if (architecture.mode === "respect") {
      if (!from || !to) throw new Error(`La dependencia ${dependency.from} -> ${dependency.to} no existe en el contrato.`);
      if (!from.allowedDependencies.includes(dependency.to)) {
        throw new Error(`La dependencia ${dependency.from} -> ${dependency.to} no está permitida por el contrato.`);
      }
      if (contract.forbidden.some((edge) => edge.from === dependency.from && edge.to === dependency.to)) {
        throw new Error(`La dependencia ${dependency.from} -> ${dependency.to} está prohibida por el contrato.`);
      }
    } else if (!planById.has(dependency.from) && !from) {
      throw new Error(`La dependencia ${dependency.from} -> ${dependency.to} referencia un módulo desconocido.`);
    } else if (!planById.has(dependency.to) && !to) {
      throw new Error(`La dependencia ${dependency.from} -> ${dependency.to} referencia un módulo desconocido.`);
    }
  }
}

function normalizeDependencies(
  value: unknown,
  moduleIds: Set<string>,
): PlanArchitectureDependencyV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error("Arquitectura del plan inválida: dependencies inválidas.");
  const result: PlanArchitectureDependencyV1[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) throw new Error("Arquitectura del plan inválida: cada dependencia debe ser un objeto.");
    assertExactKeys(raw, ["from", "to"], "Dependencia del plan");
    const from = typeof raw.from === "string" ? raw.from.trim().toLowerCase() : "";
    const to = typeof raw.to === "string" ? raw.to.trim().toLowerCase() : "";
    if (!moduleIds.has(from) || !moduleIds.has(to) || from === to) {
      throw new Error("Arquitectura del plan inválida: dependencia entre módulos no declarados.");
    }
    const identity = `${from}\0${to}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({ from, to });
  }
  return result;
}

function normalizeChange(value: unknown): PlanArchitectureChangeV1 {
  if (!isRecord(value)) throw new Error("Un cambio de arquitectura requiere el manifiesto change.");
  assertExactKeys(value, ["rationale", "alternatives", "impact", "migration", "rollback"], "Cambio de arquitectura");
  const text = (key: string): string => {
    const entry = value[key];
    if (typeof entry !== "string" || !entry.trim() || entry.length > 4_000) {
      throw new Error(`Cambio de arquitectura inválido: ${key}.`);
    }
    return entry.trim();
  };
  if (!Array.isArray(value.alternatives) || value.alternatives.length === 0 || value.alternatives.length > 10
    || value.alternatives.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 2_000)) {
    throw new Error("Cambio de arquitectura inválido: alternatives.");
  }
  return {
    rationale: text("rationale"),
    alternatives: value.alternatives.map((entry) => (entry as string).trim()),
    impact: text("impact"),
    migration: text("migration"),
    rollback: text("rollback"),
  };
}

function assertArchitectureSize(architecture: PlanArchitectureV1): void {
  if (JSON.stringify(architecture).length > 16_000) {
    throw new Error("La arquitectura del plan es demasiado grande para una revisión firmada.");
  }
}

function normalizeDocsRef(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`Arquitectura del plan inválida: ${field} no evaluable.`);
  }
  const normalized = value.trim();
  const segments = normalized.split("/");
  if (!normalized.endsWith(".md") || normalized.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Arquitectura del plan inválida: ${field} debe ser un Markdown relativo.`);
  }
  return normalized;
}

function normalizeContractPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`Arquitectura inválida: ${field} no evaluable.`);
  }
  const normalized = value.trim().replace(/\\/g, "/");
  if (normalized === ".") return normalized;
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Arquitectura inválida: ${field} debe ser una ruta relativa sin traversal.`);
  }
  return normalized;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) throw new Error(`${label}: campo no admitido.`);
}

function inside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
