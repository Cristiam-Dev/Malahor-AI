import { invalidInput } from "./errors";

export const HORIEL_GLOBAL_SCOPE = "@global";
export const MAX_SCOPE_SEGMENTS = 4;
export const MAX_SCOPE_SEGMENT_BYTES = 128;
export const MAX_SCOPE_BYTES = 512;

export type ScopeClass = "exact" | "ancestor" | "descendant" | "global";

export interface ScopeRank {
  scopeClass: ScopeClass;
  scopeDistance: number;
}

export function parseScopePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")
    || value.trim() !== value || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, "utf8") > MAX_SCOPE_BYTES) {
    return invalidInput("Scope path is not canonical.");
  }
  if (value === HORIEL_GLOBAL_SCOPE) return value;
  const segments = value.split("/");
  if (segments.length < 1 || segments.length > MAX_SCOPE_SEGMENTS) {
    return invalidInput("Scope path depth is outside the supported hierarchy.");
  }
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment === HORIEL_GLOBAL_SCOPE
      || segment.trim() !== segment || Buffer.byteLength(segment, "utf8") > MAX_SCOPE_SEGMENT_BYTES) {
      return invalidInput("Scope path contains an invalid segment.");
    }
  }
  return segments.join("/");
}

export function scopeSegments(scope: string): string[] {
  const canonical = parseScopePath(scope);
  return canonical === HORIEL_GLOBAL_SCOPE ? [] : canonical.split("/");
}

export function scopeAncestors(scope: string): string[] {
  const segments = scopeSegments(scope);
  const ancestors: string[] = [];
  for (let length = segments.length - 1; length >= 1; length -= 1) {
    ancestors.push(segments.slice(0, length).join("/"));
  }
  return ancestors;
}

export function isScopeWithin(scope: string, ancestor: string): boolean {
  const value = parseScopePath(scope);
  const parent = parseScopePath(ancestor);
  if (value === HORIEL_GLOBAL_SCOPE || parent === HORIEL_GLOBAL_SCOPE) return value === parent;
  const segments = value.split("/");
  const parentSegments = parent.split("/");
  return parentSegments.length <= segments.length
    && parentSegments.every((segment, index) => segments[index] === segment);
}

export function isStrictScopeAncestor(ancestor: string, scope: string): boolean {
  const parent = parseScopePath(ancestor);
  const value = parseScopePath(scope);
  return parent !== value && isScopeWithin(value, parent);
}

export function projectScope(scope: string): string {
  const segments = scopeSegments(scope);
  if (segments.length === 0) return invalidInput("Global scope has no project ancestor.");
  return segments[0]!;
}

export function sameProject(left: string, right: string): boolean {
  const leftSegments = scopeSegments(left);
  const rightSegments = scopeSegments(right);
  return leftSegments.length > 0 && rightSegments.length > 0 && leftSegments[0] === rightSegments[0];
}

export function classifyScope(
  candidate: string,
  requested: string,
  options: { includeAncestors: boolean; rollup: boolean; includeGlobal: boolean },
): ScopeRank | undefined {
  const value = parseScopePath(candidate);
  const target = parseScopePath(requested);
  if (value === HORIEL_GLOBAL_SCOPE) {
    return options.includeGlobal && target !== HORIEL_GLOBAL_SCOPE
      ? { scopeClass: "global", scopeDistance: 0 }
      : target === HORIEL_GLOBAL_SCOPE
        ? { scopeClass: "exact", scopeDistance: 0 }
        : undefined;
  }
  if (target === HORIEL_GLOBAL_SCOPE || !sameProject(value, target)) return undefined;
  if (value === target) return { scopeClass: "exact", scopeDistance: 0 };
  if (options.includeAncestors && isScopeWithin(target, value)) {
    return { scopeClass: "ancestor", scopeDistance: scopeSegments(target).length - scopeSegments(value).length };
  }
  if (options.rollup && isScopeWithin(value, target)) {
    return { scopeClass: "descendant", scopeDistance: scopeSegments(value).length - scopeSegments(target).length };
  }
  return undefined;
}
