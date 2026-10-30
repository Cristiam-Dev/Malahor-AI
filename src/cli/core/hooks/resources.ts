import path from "node:path";

import {
  HOOK_RESOURCE_KINDS,
  type HookContext,
  type HookResourceKind,
} from "./types";

export interface HookResourceIssue {
  code: "kind" | "missing" | "vault-path";
  message: string;
}

const OBSIDIAN_VAULT_EVENT = "obsidian.write.before";

export function effectiveResourceKind(context: Pick<HookContext, "resourceKind">): HookResourceKind | undefined {
  const value: unknown = context.resourceKind;
  if (value === undefined) return "filesystem";
  return HOOK_RESOURCE_KINDS.includes(value as HookResourceKind) ? value as HookResourceKind : undefined;
}

export function usesFilesystemResources(resourceKind: HookResourceKind | undefined): boolean {
  return resourceKind === undefined || resourceKind === "filesystem";
}

export function filesystemTargetPaths(context: Pick<HookContext, "resourceKind" | "targetPaths">): string[] {
  return effectiveResourceKind(context) === "filesystem" ? context.targetPaths ?? [] : [];
}

export function hookResourceIssues(context: HookContext): HookResourceIssue[] {
  const rawKind: unknown = context.resourceKind;
  const kind = effectiveResourceKind(context);
  if (!kind) {
    return [{
      code: "kind",
      message: `Tipo de recurso no reconocido: ${String(rawKind)}.`,
    }];
  }

  const obsidianEvent = context.event === OBSIDIAN_VAULT_EVENT;
  if (obsidianEvent && kind !== "obsidian-vault") {
    return [{
      code: "kind",
      message: `${OBSIDIAN_VAULT_EVENT} requiere recursos tipados como obsidian-vault.`,
    }];
  }
  if (!obsidianEvent && kind === "obsidian-vault") {
    return [{
      code: "kind",
      message: `El tipo obsidian-vault solo es valido para ${OBSIDIAN_VAULT_EVENT}; se recibio ${context.event}.`,
    }];
  }

  if (!obsidianEvent) return [];
  if (!context.targetPaths || context.targetPaths.length === 0) {
    return [{
      code: "missing",
      message: `${OBSIDIAN_VAULT_EVENT} requiere al menos una ruta relativa al vault.`,
    }];
  }

  return context.targetPaths.flatMap((target) => {
    try {
      normalizeVaultRelativePath(target);
      return [];
    } catch (error) {
      return [{
        code: "vault-path" as const,
        message: `Ruta de vault invalida (${JSON.stringify(target)}): ${error instanceof Error ? error.message : String(error)}`,
      }];
    }
  });
}

export function normalizeHookResource(context: Pick<HookContext, "cwd" | "resourceKind">, target: string): string {
  const kind = effectiveResourceKind(context);
  if (!kind) throw new Error(`tipo de recurso no reconocido: ${String(context.resourceKind)}`);
  if (kind === "obsidian-vault") return `obsidian-vault:${normalizeVaultRelativePath(target)}`;
  return path.normalize(path.resolve(context.cwd, target));
}

export function hookResourceAuditIdentity(context: Pick<HookContext, "cwd" | "resourceKind">, target: string): string {
  try {
    return normalizeHookResource(context, target);
  } catch {
    const kind = typeof context.resourceKind === "string" ? context.resourceKind : "filesystem";
    return `invalid:${kind}:${target}`;
  }
}

export function normalizeVaultRelativePath(target: string): string {
  if (!target || target.trim() !== target) {
    throw new Error("debe ser una ruta no vacia y sin espacios exteriores");
  }
  if (/[\u0000-\u001f\u007f]/u.test(target)) {
    throw new Error("contiene caracteres de control");
  }
  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
    throw new Error("debe ser relativa; no se aceptan rutas POSIX, Windows ni UNC absolutas");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(target)) {
    throw new Error("debe ser una ruta del vault, no una URL");
  }
  if (target.includes("\\")) {
    throw new Error("debe usar separadores POSIX '/' dentro del vault");
  }

  const segments = target.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error("no puede contener separadores repetidos ni terminar en '/'");
  }
  for (const segment of segments) {
    if (segment === "." || segment === ".." || decodedSegmentEscapes(segment)) {
      throw new Error("no puede contener segmentos de traversal '.' o '..', ni separadores codificados");
    }
  }
  if (path.posix.normalize(target) !== target) {
    throw new Error("debe estar en forma POSIX canonica");
  }
  return target;
}

function decodedSegmentEscapes(segment: string): boolean {
  let decoded = segment;
  for (let pass = 0; pass < 4; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (next === decoded) return false;
    if (next === "." || next === ".." || next.includes("/") || next.includes("\\")) return true;
    decoded = next;
  }
  return false;
}
