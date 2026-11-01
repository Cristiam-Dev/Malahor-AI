import path from "node:path";

import {
  HOOK_RESOURCE_KINDS,
  type HookContext,
  type HookResourceKind,
} from "./types";

export interface HookResourceIssue {
  code: "kind";
  message: string;
}

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
  if (effectiveResourceKind(context)) return [];
  return [{
    code: "kind",
    message: `Tipo de recurso no reconocido: ${String(rawKind)}. Solo se admiten rutas filesystem.`,
  }];
}

export function normalizeHookResource(context: Pick<HookContext, "cwd" | "resourceKind">, target: string): string {
  if (!effectiveResourceKind(context)) throw new Error(`tipo de recurso no reconocido: ${String(context.resourceKind)}`);
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
