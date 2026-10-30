import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { MalahorPaths } from "./paths";
import { codegraphEnabled, levelForProject } from "./context";
import { assertCodegraphHook } from "./codegraph-setup";
import {
  assertCodegraphProject,
  assertExternalIndex,
  CODEGRAPH_PROVIDER,
  CODEGRAPH_VERSION,
  codegraphEnvironment,
  codegraphIndex,
  codegraphRuntime,
  verifiedCodegraphBinary,
  writeManagedJson,
} from "./codegraph-runtime";

export function indexCodegraph(paths: MalahorPaths, project: string, root: string): string {
  assertCodegraphProject(paths, project, root);
  if (!codegraphEnabled(levelForProject(paths.projectsFile, project))) {
    throw new Error("CodeGraph inactivo: el nivel de contexto del proyecto no habilita el indexado.");
  }
  assertExternalIndex(paths, root);
  const binary = verifiedCodegraphBinary(paths);
  if (!binary) throw new Error("Instala primero symgraph con `malahor-ai codegraph setup`.");
  const index = codegraphIndex(paths, root);
  // Do not adopt an existing/foreign database. An interrupted run requires an
  // operator to inspect it; do not silently delete or overwrite their data.
  const existing = codegraphRuntime(paths, project, root);
  if ((entryExists(index.database) || entryExists(index.state)) && !existing) {
    throw new Error(`Indice existente sin propiedad Malahor: ${index.database}; revisalo manualmente.`);
  }
  assertCodegraphHook(paths, project, root, "codegraph.index.before", [index.database], { writesMalahorData: true });
  inspectSource(root);
  fs.mkdirSync(index.directory, { recursive: true, mode: 0o700 });
  // Invalidate the previously ready index before a provider writes to it.
  // An interrupted or failed refresh stays unavailable to MCP.
  if (existing) writeManagedJson(index.state, { provider: CODEGRAPH_PROVIDER, version: CODEGRAPH_VERSION, project, root, database: index.database, ready: false });
  const output = execFileSync(binary, ["index", root, "--db", index.database, "--format", "json"], {
    cwd: root, env: codegraphEnvironment(root, index.database), encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024,
  });
  if (!fs.existsSync(index.database)) throw new Error("El proveedor no genero la base de datos externa esperada.");
  const stats = JSON.parse(output) as { files?: unknown; errors?: unknown; parse_failures?: unknown };
  if (typeof stats.files !== "number" || stats.files === 0 || stats.errors !== 0 || stats.parse_failures !== 0) {
    throw new Error(`Indice incompleto (archivos=${String(stats.files)}, errores=${String(stats.errors)}); no se habilita MCP.`);
  }
  writeManagedJson(index.state, { provider: CODEGRAPH_PROVIDER, version: CODEGRAPH_VERSION, project, root, database: index.database, ready: true });
  return `Indexado: ${stats.files} archivo(s); base de datos externa: ${index.database}`;
}

function entryExists(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function statusCodegraph(paths: MalahorPaths, project: string, root: string): string {
  const runtime = codegraphRuntime(paths, project, root);
  if (!runtime) return `CodeGraph degradado: sin indice gestionado para ${root}. Ejecuta codegraph setup e index; memoria + lecturas puntuales disponibles.`;
  try {
    // symgraph status initializes schema too; always query a private SQLite snapshot.
    return execFileSync("node", [runtime.proxy, "--status", runtime.binary, runtime.root, runtime.database, project, paths.projectsFile, paths.malahorHome], {
      cwd: runtime.root, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { ...codegraphEnvironment(runtime.root, runtime.database), NODE_OPTIONS: "", NODE_PATH: "" },
    }).trim();
  } catch (error) {
    return `CodeGraph degradado: no se pudo consultar el indice (${(error as Error).message}).`;
  }
}

// Fail closed on suspicious source paths and on symlinks: upstream reads source
// through ignore::WalkBuilder and may follow file links. This is a preflight,
// not a guarantee against credentials embedded inside ordinary source files.
export function inspectSource(root: string): void {
  const pending = [root];
  let inspected = 0;
  // Do not trust the provider's ignore rules when deciding what is safe:
  // .git is provider-excluded and may contain huge object stores; other
  // ignored dirs are still inspected for links/secrets before we run it.
  const skipped = new Set([".git"]);
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++inspected > 100_000) throw new Error("Inspeccion de rutas excedio el limite; indice rechazado.");
      const name = entry.name.toLowerCase();
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink en el arbol de codigo: ${target}; indice rechazado.`);
      if (/(^\.env($|\.)|secret|credential|password|id_rsa|id_ed25519|\.(pem|key|p12|pfx|kdbx)$)/i.test(name) && ![".env.example", ".env.sample", ".env.template"].includes(name)) {
        throw new Error(`Ruta potencialmente sensible: ${target}; excluyela antes de indexar.`);
      }
      if (skipped.has(entry.name)) {
        // A Git worktree .git file may point to gitdir outside the project;
        // the provider's ignore walker must not open foreign Git metadata.
        if (!entry.isDirectory()) throw new Error(`Metadatos Git fuera del arbol: ${target}; indice rechazado.`);
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Entrada especial en el arbol de codigo: ${target}; indice rechazado.`);
    }
  }
}
