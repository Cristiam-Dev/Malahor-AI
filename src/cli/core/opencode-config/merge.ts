// Entrada ESM directa de jsonc-parser: ver la nota en jsonc.ts (el UMD rompe el bundle).
import { applyEdits, findNodeAtLocation, modify, type Node } from "jsonc-parser/lib/esm/main.js";
import { comments, nodeValue, properties, readDocument } from "./jsonc";
import type { ConfigConflict, ConfigMerge } from "./types";

const SECURITY_KEYS = new Set(["permission", "permissions", "policies", "tools", "enabled_providers", "disabled_providers"]);
const ALIASES = [["agent", "agents", "mode"], ["provider", "providers"], ["command", "commands"], ["permission", "permissions", "tools"], ["plugin", "plugins"], ["reference", "references"], ["snapshot", "snapshots"], ["attachment", "media"], ["autoupdate", "update"]];
interface Addition { path: string[]; node: Node }

export function mergeConfigText(target: string, source: string): ConfigMerge {
  const left = readDocument(target);
  const right = readDocument(source);
  const additions: Addition[] = [];
  const conflicts: ConfigConflict[] = [];
  collect(left.root, right.root, [], additions, conflicts);
  semanticConflicts(left.root, right.root, conflicts);
  if (conflicts.length) return { text: target, additions: [], conflicts };
  let text = left.text;
  for (const addition of additions) {
    text = applyEdits(text, modify(text, addition.path, nodeValue(addition.node), {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
    }));
    const node = findNodeAtLocation(readDocument(text).root, addition.path);
    if (!node) throw new Error("No se pudo verificar una insercion JSONC.");
    const raw = right.text.slice(addition.node.offset, addition.node.offset + addition.node.length);
    text = text.slice(0, node.offset) + raw + text.slice(node.offset + node.length);
  }
  const retained = comments(right.text).filter((comment) => !additions.some(({ node }) => comment.offset >= node.offset && comment.offset + comment.length <= node.offset + node.length));
  if (retained.length) {
    const header = retained.map((comment) => `// opencode.json, linea ${right.text.slice(0, comment.offset).split("\n").length}\n${comment.text}\n`).join("");
    text = `// Comentarios conservados del archivo de origen.\n${header}\n${text}`;
  }
  verifyComments(left.text, right.text, text);
  readDocument(text);
  return { text: left.bom + text, additions: additions.map(({ path }) => pointer(path)), conflicts };
}

function collect(target: Node, source: Node, at: string[], additions: Addition[], conflicts: ConfigConflict[]): void {
  const existing = properties(target);
  for (const [key, value] of properties(source)) {
    const location = [...at, key];
    const current = existing.get(key);
    if (current && JSON.stringify(nodeValue(current)) === JSON.stringify(nodeValue(value))) continue;
    if (SECURITY_KEYS.has(key) || (!current && containsSecurity(value))) {
      conflicts.push({ path: pointer(location), reason: "security-review" });
      continue;
    }
    if (!current) {
      additions.push({ path: location, node: value });
      continue;
    }
    if (current.type === "object" && value.type === "object") collect(current, value, location, additions, conflicts);
    else conflicts.push({ path: pointer(location), reason: "value" });
  }
}

function containsSecurity(node: Node): boolean {
  if (node.type === "object" && [...properties(node).keys()].some((key) => SECURITY_KEYS.has(key))) return true;
  return (node.children ?? []).some(containsSecurity);
}

function semanticConflicts(target: Node, source: Node, conflicts: ConfigConflict[]): void {
  const left = properties(target);
  const right = properties(source);
  for (const aliases of ALIASES) {
    const keys = aliases.filter((key) => left.has(key) || right.has(key));
    if (keys.length > 1 && keys.some((key) => left.has(key) !== right.has(key))) {
      conflicts.push({ path: pointer(keys), reason: "semantic-alias" });
    }
  }
  const leftMcp = left.get("mcp");
  const rightMcp = right.get("mcp");
  if (leftMcp?.type === "object" && rightMcp?.type === "object") {
    const merged = new Map([...properties(leftMcp), ...properties(rightMcp)]);
    const native = merged.get("servers");
    if (native?.type === "object") {
      for (const key of properties(native).keys()) {
        if (merged.has(key) && key !== "servers" && key !== "timeout") conflicts.push({ path: pointer(["mcp", key]), reason: "semantic-alias" });
      }
    }
  }
  const compactions = [left.get("compaction"), right.get("compaction")].filter((node): node is Node => node?.type === "object");
  const compactionKeys = new Set(compactions.flatMap((node) => [...properties(node).keys()]));
  for (const pair of [["preserve_recent_tokens", "keep"], ["reserved", "buffer"]]) {
    if (pair.every((key) => compactionKeys.has(key))) conflicts.push({ path: pointer(["compaction", ...pair]), reason: "semantic-alias" });
  }
}

function verifyComments(target: string, source: string, merged: string): void {
  const counts = new Map<string, number>();
  for (const comment of [...comments(target), ...comments(source)]) counts.set(comment.text, (counts.get(comment.text) ?? 0) + 1);
  for (const comment of comments(merged)) counts.set(comment.text, (counts.get(comment.text) ?? 0) - 1);
  if ([...counts.values()].some((count) => count > 0)) throw new Error("La consolidacion perderia comentarios; operacion bloqueada.");
}

function pointer(parts: string[]): string {
  return `/${parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}
