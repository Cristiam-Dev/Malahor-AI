import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { DocsResolution } from "./resolver";

export const DOCS_CLIENTS = ["system", "vscode", "obsidian"] as const;
export type DocsClient = typeof DOCS_CLIENTS[number];

export type DocsCommandRunner = (command: string, args: readonly string[], captureOutput: boolean) => string;

export interface DocsClientHost {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: DocsCommandRunner;
}

export interface DocsOpenOptions extends DocsClientHost {
  path?: string;
  app?: string;
  configuredClient?: DocsClient;
  dryRun?: boolean;
}

export interface DocsOpenResult {
  project: string;
  path: string;
  target: string;
  requestedClient: DocsClient;
  client: DocsClient;
  command: string;
  args: string[];
  dryRun: boolean;
  fallback?: {
    from: DocsClient;
    reason: string;
  };
}

interface OpenCommand {
  command: string;
  args: string[];
}

interface ResolvedHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run: DocsCommandRunner;
}

export function parseDocsClient(value: unknown, key = "cliente documental"): DocsClient {
  if (typeof value === "string" && DOCS_CLIENTS.includes(value.toLowerCase() as DocsClient)) {
    return value.toLowerCase() as DocsClient;
  }
  throw new Error(`${key} debe ser system, vscode u obsidian.`);
}

export function normalizeDocsRootInput(value: string, options: DocsClientHost = {}): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error("La ruta documental debe ser absoluta y no vacia.");
  }
  const input = value.trim();
  const host = resolveHost(options);

  if (host.platform === "win32") {
    if (!path.win32.isAbsolute(input)) throw new Error("La ruta documental debe ser absoluta.");
    return path.win32.normalize(input);
  }

  if (isWindowsAbsolute(input)) {
    if (!isWslHost(host)) {
      throw new Error("Las rutas Windows solo se aceptan en Windows o WSL.");
    }
    const converted = runPathConversion(host, ["-u", input], "Windows a WSL");
    if (!path.posix.isAbsolute(converted)) throw new Error("wslpath no devolvio una ruta WSL absoluta.");
    return path.posix.normalize(converted);
  }

  if (!path.posix.isAbsolute(input)) throw new Error("La ruta documental debe ser absoluta.");
  return path.resolve(input);
}

export function windowsPathForClient(target: string, options: DocsClientHost = {}): string {
  const host = resolveHost(options);
  if (host.platform === "win32") return path.win32.normalize(target);
  if (!isWslHost(host)) return target;
  const converted = runPathConversion(host, ["-w", target], "WSL a Windows");
  if (!isWindowsAbsolute(converted)) throw new Error("wslpath no devolvio una ruta Windows absoluta.");
  return path.win32.normalize(converted);
}

export function isWslHost(options: DocsClientHost = {}): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

export function resolveDocsOpenTarget(resolution: DocsResolution, relativePath = ""): { path: string; target: string } {
  const normalized = normalizeOpenPath(relativePath);
  const root = path.resolve(resolution.projectRoot);
  if (!fs.existsSync(root)) throw new Error("La raiz documental no esta inicializada.");
  assertRealPath(root, "La raiz documental");

  const target = normalized ? path.resolve(root, ...normalized.split("/")) : root;
  if (!isWithin(target, root)) throw new Error("La ruta escapa de la raiz documental.");
  if (!fs.existsSync(target)) throw new Error(`No existe el destino documental: ${normalized || "."}`);
  assertPathWithoutSymlinks(root, target);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error("El destino documental debe ser un archivo regular o directorio real.");
  }
  if (stat.isFile() && path.extname(target).toLowerCase() !== ".md") {
    throw new Error("Solo se pueden abrir archivos Markdown o directorios del proyecto.");
  }
  return { path: normalized || ".", target };
}

export function planDocsOpen(resolution: DocsResolution, options: DocsOpenOptions = {}): DocsOpenResult {
  const host = resolveHost(options);
  const selected = parseDocsClient(options.app ?? options.configuredClient ?? "system");
  const target = resolveDocsOpenTarget(resolution, options.path);
  const command = clientCommands(selected, target.target, host)[0];
  if (!command) throw new Error(`No hay launcher disponible para ${selected}.`);
  return resultFor(resolution, target, selected, selected, command, Boolean(options.dryRun));
}

export function openDocsClient(resolution: DocsResolution, options: DocsOpenOptions = {}): DocsOpenResult {
  const host = resolveHost(options);
  const planned = planDocsOpen(resolution, { ...options, platform: host.platform, env: host.env, run: host.run });
  if (planned.dryRun) return planned;

  const failures: string[] = [];
  const target = { path: planned.path, target: planned.target };
  for (const command of clientCommands(planned.requestedClient, planned.target, host)) {
    try {
      host.run(command.command, command.args, false);
      return resultFor(resolution, target, planned.requestedClient, planned.requestedClient, command, false);
    } catch (error) {
      failures.push(commandFailure(command, error));
    }
  }

  if (planned.requestedClient === "system") {
    throw new Error(`No se pudo abrir la documentacion con el cliente del sistema: ${failures.join("; ")}`);
  }

  const reason = failures.join("; ") || `cliente ${planned.requestedClient} no disponible`;
  for (const command of clientCommands("system", planned.target, host)) {
    try {
      host.run(command.command, command.args, false);
      return {
        ...resultFor(resolution, target, planned.requestedClient, "system", command, false),
        fallback: { from: planned.requestedClient, reason },
      };
    } catch (error) {
      failures.push(commandFailure(command, error));
    }
  }
  throw new Error(`No se pudo abrir la documentacion ni degradar a system: ${failures.join("; ")}`);
}

export function formatDocsOpenCommand(result: Pick<DocsOpenResult, "command" | "args">): string {
  return [result.command, ...result.args.map((value) => JSON.stringify(value))].join(" ");
}

function resolveHost(options: DocsClientHost): ResolvedHost {
  return {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    run: options.run ?? defaultRunner,
  };
}

const defaultRunner: DocsCommandRunner = (command, args, captureOutput) => {
  if (captureOutput) {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  }
  execFileSync(command, [...args], { stdio: "ignore", windowsHide: true });
  return "";
};

function clientCommands(client: DocsClient, target: string, host: ResolvedHost): OpenCommand[] {
  if (client === "system") return [systemCommand(target, host)];
  if (client === "obsidian") {
    const openPath = isWslHost(host) ? windowsPathForClient(target, host) : target;
    return [systemCommand(`obsidian://open?path=${encodeURIComponent(openPath)}`, host)];
  }
  if (isWslHost(host)) {
    return [
      { command: "code", args: [target] },
      { command: "code.exe", args: [windowsPathForClient(target, host)] },
    ];
  }
  return [{ command: "code", args: [target] }];
}

function systemCommand(target: string, host: ResolvedHost): OpenCommand {
  if (host.platform === "win32") return { command: "explorer.exe", args: [target] };
  if (isWslHost(host)) {
    return {
      command: "explorer.exe",
      args: [target.startsWith("obsidian:") ? target : windowsPathForClient(target, host)],
    };
  }
  if (host.platform === "darwin") return { command: "open", args: [target] };
  return { command: "xdg-open", args: [target] };
}

function resultFor(
  resolution: DocsResolution,
  target: { path: string; target: string },
  requestedClient: DocsClient,
  client: DocsClient,
  command: OpenCommand,
  dryRun: boolean,
): DocsOpenResult {
  return {
    project: resolution.project,
    path: target.path,
    target: target.target,
    requestedClient,
    client,
    command: command.command,
    args: command.args,
    dryRun,
  };
}

function normalizeOpenPath(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Ruta documental invalida.");
  if (!value) return "";
  if (value.trim() !== value || value.includes("\\") || value.startsWith("/")
    || /^[A-Za-z]:/.test(value) || value.startsWith("//") || value.endsWith("/") || value.includes("//")) {
    throw new Error("La ruta debe ser relativa, canonica y usar separadores '/'.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) throw new Error("Traversal no permitido.");
  for (const segment of segments) validatePortableSegment(segment);
  return segments.join("/");
}

function validatePortableSegment(segment: string): void {
  if (!segment || /[\u0000-\u001f\u007f<>:"\\|?*]/u.test(segment) || /[ .]$/.test(segment)) {
    throw new Error(`Segmento de ruta no portable: ${JSON.stringify(segment)}.`);
  }
  const base = segment.split(".", 1)[0] ?? "";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
    throw new Error(`Nombre reservado de Windows: ${segment}.`);
  }
}

function assertRealPath(target: string, label: string): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(fs.realpathSync(target), target)) {
    throw new Error(`${label} debe ser un directorio real, no un symlink.`);
  }
}

function assertPathWithoutSymlinks(root: string, target: string): void {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink no permitido: ${current}`);
  }
}

function runPathConversion(host: ResolvedHost, args: string[], direction: string): string {
  let converted: string;
  try {
    converted = host.run("wslpath", args, true).trim();
  } catch (error) {
    throw new Error(`No se pudo convertir la ruta ${direction} con wslpath: ${errorMessage(error)}`);
  }
  if (!converted || converted.includes("\0") || converted.includes("\n") || converted.includes("\r")) {
    throw new Error(`wslpath devolvio una ruta invalida al convertir ${direction}.`);
  }
  return converted;
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
    || /^\/\/(?:wsl\$|wsl\.localhost)\//i.test(value);
}

function commandFailure(command: OpenCommand, error: unknown): string {
  return `${command.command}: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(value: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}
