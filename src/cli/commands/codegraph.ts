import { createInterface } from "node:readline/promises";

import { loadConfig } from "../core/config";
import { codegraphEnabled, levelForProject } from "../core/context";
import { assertExternalIndex, codegraphRoot, codegraphIndex, CODEGRAPH_PROVIDER, CODEGRAPH_VERSION, verifiedCodegraphBinary, verifiedCodegraphProxy } from "../core/codegraph-runtime";
import { indexCodegraph, statusCodegraph } from "../core/codegraph-index";
import { archiveFor, setupCodegraph } from "../core/codegraph-setup";
import { resolveCanonicalProjectKey } from "../core/project";

export interface CodegraphOptions {
  action: string;
  project?: string;
  confirm?: string;
  dryRun: boolean;
}

export async function runCodegraph(options: CodegraphOptions): Promise<void> {
  if (options.action === "guide" || options.action === "help") {
    process.stdout.write(`CodeGraph: ${CODEGRAPH_PROVIDER} ${CODEGRAPH_VERSION} (Rust/tree-sitter).\n`);
    process.stdout.write("Proveedor sustituto aprobado: usa SYMGRAPH_DB fuera del repo; el CodeGraph nativo no admite indice externo.\n");
    process.stdout.write("codegraph status|setup|index|guide [--project <key>] [--dry-run] [--confirm <token>]\n");
    process.stdout.write("setup: descarga release fija con SHA-256 bajo MALAHOR_HOME; requiere --confirm INSTALL_SYMGRAPH.\n");
    process.stdout.write("index: inspecciona el arbol y escribe solo bajo MALAHOR_HOME; requiere --confirm INDEX_SYMGRAPH:<proyecto>.\n");
    process.stdout.write("Cargo fallback (manual y con version fijada): cargo install symgraph --version 2026.10.18 --locked; no se adopta automaticamente un binario ajeno.\n");
    process.stdout.write("El servidor MCP requiere nivel memory+codegraph*, indice gestionado y sesion nueva; niveles legacy no activan CodeGraph.\n");
    return;
  }
  if (!["status", "setup", "index"].includes(options.action)) throw new Error(`Accion desconocida: ${options.action}`);
  const config = loadConfig();
  const paths = config.paths;
  const key = options.project ? resolveCanonicalProjectKey(options.project, config.projects.aliases) : undefined;
  const target = codegraphRoot(paths, key);
  if (options.action !== "status" && !codegraphEnabled(levelForProject(paths.projectsFile, target.project))) {
    throw new Error("El nivel actual no habilita CodeGraph; cambia el nivel mediante la migracion asistida, no se indexa un proyecto legacy.");
  }
  if (options.action !== "status") assertExternalIndex(paths, target.root);
  const index = codegraphIndex(paths, target.root);
  if (options.action === "status") {
    process.stdout.write(`Proyecto: ${target.project}\nRaiz: ${target.root}\nBinario: ${verifiedCodegraphBinary(paths) ?? "no gestionado"}\n${statusCodegraph(paths, target.project, target.root)}\n`);
    return;
  }
  const archive = archiveFor();
  const action = options.action;
  const token = action === "setup" ? "INSTALL_SYMGRAPH" : `INDEX_SYMGRAPH:${target.project}`;
  process.stdout.write(`Proyecto: ${target.project}\nRaiz: ${target.root}\nProveedor: ${CODEGRAPH_PROVIDER} ${CODEGRAPH_VERSION}\n`);
  process.stdout.write(`Indice: ${index.database} (fuera del repo)\n`);
  if (action === "setup") process.stdout.write(`Release: ${archive?.name ?? "sin binario precompilado para esta plataforma"}\n`);
  if (options.dryRun) {
    process.stdout.write(`Preview: no se instalo ni indexo nada. Para aplicar: --confirm ${token}\n`);
    return;
  }
  if (options.confirm !== token) throw new Error(`Confirmacion especifica requerida: --confirm ${token}. --yes no autoriza esta operacion.`);
  const result = action === "setup"
    ? await setupCodegraph(paths, target.project, target.root)
    : indexCodegraph(paths, target.project, target.root);
  process.stdout.write(`${result}\n`);
}

/** Opt-in interactivo del instalador; nunca se activa con --yes/bootstrap. */
export async function offerCodegraphSetup(paths: ReturnType<typeof loadConfig>["paths"], project: string, root: string): Promise<void> {
  if (!codegraphEnabled(levelForProject(paths.projectsFile, project))) {
    process.stdout.write("CodeGraph inactivo para el nivel actual; no se ofrece instalacion para proyectos legacy.\n");
    return;
  }
  if (verifiedCodegraphBinary(paths) && verifiedCodegraphProxy(paths)) return;
  process.stdout.write("CodeGraph no instalado: memoria y lectura puntual siguen disponibles.\n");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("Para habilitarlo: `malahor-ai codegraph guide` y `codegraph setup`.\n");
    return;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question("¿Instalar symgraph verificado bajo MALAHOR_HOME ahora? [s/N] ")).trim().toLowerCase();
    if (answer !== "s" && answer !== "si" && answer !== "sí") return;
    try {
      process.stdout.write(`${await setupCodegraph(paths, project, root)}\n`);
      process.stdout.write(`Para indexar este proyecto, revisa primero \'malahor-ai codegraph index --dry-run\'.\n`);
    } catch (error) {
      process.stdout.write(`CodeGraph degradado: ${(error as Error).message}. La instalacion principal sigue operativa.\n`);
    }
  } finally {
    prompt.close();
  }
}
