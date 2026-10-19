// Entrada ESM directa: el main del paquete apunta al build UMD y Bun deja sus
// require() internos fuera del bundle, rompiendo dist/index.js en runtime.
import { createScanner, parseTree, SyntaxKind, type Node, type ParseError } from "jsonc-parser/lib/esm/main.js";

export interface ConfigDocument {
  text: string;
  bom: string;
  root: Node;
}

export function readDocument(raw: string): ConfigDocument {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = raw.slice(bom.length);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || root?.type !== "object") throw new Error("JSONC invalido: se requiere un objeto sin errores.");
  validateKeys(root);
  return { text, bom, root };
}

function validateKeys(node: Node): void {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as string;
      if (keys.has(key)) throw new Error("JSONC invalido: contiene claves duplicadas.");
      keys.add(key);
    }
  }
  for (const child of node.children ?? []) validateKeys(child);
}

export function nodeValue(node: Node): unknown {
  if (node.type === "object") {
    const value: Record<string, unknown> = Object.create(null);
    for (const property of node.children ?? []) {
      const [key, child] = property.children ?? [];
      if (key && child) value[String(key.value)] = nodeValue(child);
    }
    return value;
  }
  if (node.type === "array") return (node.children ?? []).map(nodeValue);
  return node.value as string | number | boolean | null;
}

export function properties(node: Node): Map<string, Node> {
  return new Map((node.children ?? []).map((property) => [String(property.children?.[0]?.value), property.children![1]]));
}

export function comments(text: string): Array<{ offset: number; length: number; text: string }> {
  const scanner = createScanner(text, false);
  const result: Array<{ offset: number; length: number; text: string }> = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token !== SyntaxKind.LineCommentTrivia && token !== SyntaxKind.BlockCommentTrivia) continue;
    const offset = scanner.getTokenOffset();
    const length = scanner.getTokenLength();
    result.push({ offset, length, text: text.slice(offset, offset + length) });
  }
  return result;
}
