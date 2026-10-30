import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertHooksAllowed } from "./hooks/engine";
import { loadHookPolicy } from "./hooks/policy-loader";
import type { MalahorPaths } from "./paths";
import { resolvePackagePaths } from "./package";
import {
  assertCodegraphProject,
  assertExternalIndex,
  CODEGRAPH_ARCHIVES,
  CODEGRAPH_BINARIES,
  CODEGRAPH_PROVIDER,
  CODEGRAPH_RELEASE,
  CODEGRAPH_VERSION,
  codegraphBinary,
  codegraphDirectory,
  codegraphProxy,
  CODEGRAPH_PROXY_SHA256,
  verifiedCodegraphBinary,
  verifiedCodegraphProxy,
  writeManagedJson,
} from "./codegraph-runtime";

export function archiveFor(platform = process.platform, arch = process.arch): { name: string; sha256: string } | undefined {
  return CODEGRAPH_ARCHIVES[`${platform}:${arch}`];
}

export async function setupCodegraph(paths: MalahorPaths, project: string, root: string): Promise<string> {
  assertCodegraphProject(paths, project, root);
  assertExternalIndex(paths, root);
  const existing = verifiedCodegraphBinary(paths);
  const managedProxy = verifiedCodegraphProxy(paths);
  if (existing && managedProxy) return `symgraph ${CODEGRAPH_VERSION} y puente MCP verificados en ${existing}`;

  const target = codegraphBinary(paths);
  const proxy = codegraphProxy(paths);
  if (pathEntryExists(target) && !existing) throw new Error(`Binario CodeGraph no gestionado o alterado: ${target}; no se sobrescribe.`);
  if (pathEntryExists(proxy) && !managedProxy) throw new Error(`Puente MCP no gestionado o alterado: ${proxy}; no se sobrescribe.`);
  const archive = archiveFor();
  if (!archive) throw new Error(`Sin release verificada para ${process.platform}/${process.arch}. Consulta codegraph guide (cargo fallback manual).`);
  assertCodegraphHook(paths, project, root, "install.beforePolicy", [target, proxy], { appliesPolicyBeforeValidation: false, bashDenyTotal: false, writesMalahorData: true });

  const asset = path.join(resolvePackagePaths(path.dirname(fileURLToPath(import.meta.url))).assetsDir, "codegraph", "mcp-proxy.mjs");
  const proxyBytes = fs.readFileSync(asset);
  if (createHash("sha256").update(proxyBytes).digest("hex") !== CODEGRAPH_PROXY_SHA256) {
    throw new Error("Asset MCP alterado o no generado para esta version; no se instala.");
  }

  if (existing) {
    fs.writeFileSync(proxy, proxyBytes, { mode: 0o600, flag: "wx" });
    return `symgraph ${CODEGRAPH_VERSION} y puente MCP verificados en ${target}`;
  }

  const url = `https://github.com/grahambrooks/symgraph/releases/download/${CODEGRAPH_RELEASE}/${archive.name}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Descarga de symgraph fallida (HTTP ${response.status}).`);
  const size = Number(response.headers.get("content-length"));
  if (size > 32_000_000) throw new Error("Archivo de release demasiado grande.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.length;
    if (total > 32_000_000) throw new Error("Archivo de release demasiado grande.");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256) {
    throw new Error("SHA-256 de la release no coincide con el pin verificado; no se ejecuta.");
  }

  const binDir = path.dirname(target);
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const tempArchive = path.join(binDir, `.symgraph.${process.pid}.${Date.now()}.archive`);
  const tempBinary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempArchive, bytes, { mode: 0o600, flag: "wx" });
    // Extract only the named binary to stdout, never unpack arbitrary paths.
    const binary = execFileSync("tar", [process.platform === "win32" ? "-xOf" : "-xOzf", tempArchive, process.platform === "win32" ? "symgraph.exe" : "symgraph"], {
      encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
    });
    if (createHash("sha256").update(binary).digest("hex") !== CODEGRAPH_BINARIES[`${process.platform}:${process.arch}`]) {
      throw new Error("SHA-256 del ejecutable extraido no coincide con el pin verificado; no se ejecuta.");
    }
    fs.writeFileSync(tempBinary, binary, { mode: 0o700, flag: "wx" });
    const version = execFileSync(tempBinary, ["--version"], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH ?? "", HOME: paths.malahorHome } });
    if (!version.includes(`symgraph ${CODEGRAPH_VERSION}`)) throw new Error(`Version inesperada: ${version.trim()}`);
    // COPYFILE_EXCL enforces no-overwrite atomically, unlike check + rename.
    fs.copyFileSync(tempBinary, target, fs.constants.COPYFILE_EXCL);
    writeManagedJson(path.join(binDir, "managed.json"), {
      provider: CODEGRAPH_PROVIDER, version: CODEGRAPH_VERSION, sha256: createHash("sha256").update(binary).digest("hex"),
    });
    if (!managedProxy) fs.writeFileSync(proxy, proxyBytes, { mode: 0o600, flag: "wx" });
  } finally {
    fs.rmSync(tempArchive, { force: true });
    fs.rmSync(tempBinary, { force: true });
  }
  return `symgraph ${CODEGRAPH_VERSION} y puente MCP instalados y verificados en ${target}`;
}

function pathEntryExists(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function assertCodegraphHook(
  paths: MalahorPaths,
  project: string,
  root: string,
  event: "install.beforePolicy" | "codegraph.index.before",
  targets: string[],
  metadata: Record<string, unknown>,
): void {
  const policy = loadHookPolicy(paths, project);
  assertHooksAllowed({
    event,
    harness: "cli",
    profile: policy.policy.profile,
    cwd: root,
    projectRoot: root,
    malahorHome: paths.malahorHome,
    project,
    targetPaths: targets,
    resourceKind: "filesystem",
    policy: policy.policy,
    security: policy.security,
    policyMeta: policy.policyMeta,
    metadata,
  });
}
