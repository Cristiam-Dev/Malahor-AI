import { createInterface } from "node:readline/promises";
import path from "node:path";

import { normalizeDocsRootInput } from "../../docs/client";
import {
  resolveDocsProjectForRegistration,
  type DocsResolution,
} from "../../docs/resolver";
import {
  loadProjectsFile,
  setProjectDocsPath,
} from "./context";
import type { MalahorPaths } from "./paths";
import type { ProjectAliases } from "./project";

export interface ProjectDocsOnboardingOptions {
  paths: MalahorPaths;
  aliases: ProjectAliases;
  project: string;
  codeRoots: string[];
  explicitPath?: string;
  yes: boolean;
  dryRun: boolean;
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
}

export interface ProjectDocsOnboarding {
  resolution: DocsResolution;
  isNewProject: boolean;
  prompted: boolean;
  overridePath?: string;
}

export async function prepareProjectDocsOnboarding(
  options: ProjectDocsOnboardingOptions,
): Promise<ProjectDocsOnboarding> {
  const projects = loadProjectsFile(options.paths.projectsFile);
  const existing = projects[options.project];
  const registered = Boolean(existing?.roots?.length);

  if (registered) {
    const current = resolveDocsProjectForRegistration(
      options.paths,
      options.aliases,
      options.project,
      options.codeRoots,
    );
    if (options.explicitPath) {
      const normalized = normalizeDocsRootInput(options.explicitPath);
      const requested = resolveDocsProjectForRegistration(
        options.paths,
        options.aliases,
        options.project,
        options.codeRoots,
        normalized,
      );
      if (!samePath(current.projectRoot, requested.projectRoot)) {
        throw new Error(
          `El proyecto ${options.project} ya tiene raiz documental. Reconfigurarla requiere preview y migracion; no se cambia durante el alta.`,
        );
      }
    }
    return { resolution: current, isNewProject: false, prompted: false };
  }

  const interactive = !options.yes
    && (options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  let selectedPath = options.explicitPath;
  let prompted = false;
  if (!selectedPath && interactive) {
    selectedPath = await promptDocsPath(options, defaultProjectRoot(options.paths, options.project));
    prompted = true;
  }

  const normalized = selectedPath ? normalizeDocsRootInput(selectedPath) : undefined;
  const resolution = resolveDocsProjectForRegistration(
    options.paths,
    options.aliases,
    options.project,
    options.codeRoots,
    normalized,
  );
  return {
    resolution,
    isNewProject: true,
    prompted,
    ...(resolution.source === "override" ? { overridePath: resolution.projectRoot } : {}),
  };
}

export function persistProjectDocsOnboarding(
  paths: MalahorPaths,
  choice: ProjectDocsOnboarding,
  dryRun: boolean,
): void {
  if (!choice.isNewProject || dryRun) return;
  setProjectDocsPath(paths.projectsFile, choice.resolution.project, choice.overridePath, false);
}

export function describeProjectDocsOnboarding(choice: ProjectDocsOnboarding, dryRun: boolean): string {
  const mode = choice.resolution.source === "default" ? "vault gestionado" : "carpeta externa";
  const prefix = dryRun ? "would use" : "using";
  return `${prefix} ${mode}: ${choice.resolution.projectRoot}`;
}

async function promptDocsPath(options: ProjectDocsOnboardingOptions, defaultRoot: string): Promise<string | undefined> {
  if (options.ask) return promptWith(options.ask, defaultRoot);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await promptWith((question) => prompt.question(question), defaultRoot);
  } finally {
    prompt.close();
  }
}

async function promptWith(ask: (question: string) => Promise<string>, defaultRoot: string): Promise<string | undefined> {
  const selection = (await ask([
    "Documentacion del proyecto:",
    `  1. Vault gestionado por Malahor (recomendado): ${defaultRoot}`,
    "  2. Carpeta externa personalizada",
    "Seleccion [1]: ",
  ].join("\n"))).trim().toLowerCase();
  if (!selection || ["1", "default", "predeterminado"].includes(selection)) return undefined;
  if (!["2", "custom", "personalizada"].includes(selection)) {
    throw new Error("Seleccion documental invalida; usa 1 para el vault gestionado o 2 para una carpeta externa.");
  }
  const custom = (await ask("Ruta absoluta de la carpeta documental: ")).trim();
  if (!custom) throw new Error("La carpeta documental personalizada no puede estar vacia.");
  return custom;
}

function defaultProjectRoot(paths: MalahorPaths, project: string): string {
  return path.join(paths.vaultDir, "projects", project);
}

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}
