import path from "node:path";

export type DocumentationOperationKind = "add" | "update" | "delete" | "move-in" | "move-out" | "write";

export interface DocumentationOperation {
  kind: DocumentationOperationKind;
  path: string;
}

export interface DocumentationClassification {
  protected: boolean;
  relativePath?: string;
  reason?: string;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".adoc", ".rst"]);
const ALLOWED_TOP_LEVEL_DIRECTORIES = new Set([
  "assets", "examples", "example", "fixtures", "fixture", "test", "tests", "__tests__", ".github",
]);
const ALLOWED_NESTED_DIRECTORIES = new Set([
  "fixtures", "fixture", "__fixtures__", "examples", "example", "__examples__", "__tests__", "__snapshots__",
]);
const PUBLIC_DOCUMENT_STEMS = /^(?:readme|license|licence|notice|changelog|contributing|security|support|governance|code[-_]of[-_]conduct|third[-_]party[-_]notices|agents|claude)(?:[._-][a-z0-9-]+)*$/i;

export function classifyDocumentationPath(
  projectRoot: string,
  targetPath: string,
): DocumentationClassification {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, targetPath);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return { protected: false };
  const portable = relative.split(path.sep).join("/");
  const segments = portable.split("/");
  const basename = segments.at(-1) ?? "";
  const extension = path.extname(basename).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(extension)) return { protected: false, relativePath: portable };
  const stem = basename.slice(0, -extension.length);
  if (PUBLIC_DOCUMENT_STEMS.test(stem)) {
    return { protected: false, relativePath: portable, reason: "README/licencia/gobernanza publica permitida" };
  }
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  if (ALLOWED_TOP_LEVEL_DIRECTORIES.has(directories[0] ?? "")
    || directories.some((segment) => ALLOWED_NESTED_DIRECTORIES.has(segment))) {
    return { protected: false, relativePath: portable, reason: "asset gestionado, ejemplo o fixture permitido" };
  }
  return { protected: true, relativePath: portable, reason: "Markdown bloqueado por defecto fuera de la allowlist publica" };
}

export function isProtectedDocumentationPath(projectRoot: string, targetPath: string): boolean {
  return classifyDocumentationPath(projectRoot, targetPath).protected;
}

export function parsePatchOperations(patchText: string): DocumentationOperation[] {
  const operations: DocumentationOperation[] = [];
  let pendingUpdate: string | undefined;
  const flushUpdate = () => {
    if (pendingUpdate) operations.push({ kind: "update", path: pendingUpdate });
    pendingUpdate = undefined;
  };
  for (const line of patchText.split(/\r?\n/)) {
    let match = line.match(/^\*\*\* Add File: (.+)$/);
    if (match) {
      flushUpdate();
      operations.push({ kind: "add", path: match[1]!.trim() });
      continue;
    }
    match = line.match(/^\*\*\* Delete File: (.+)$/);
    if (match) {
      flushUpdate();
      operations.push({ kind: "delete", path: match[1]!.trim() });
      continue;
    }
    match = line.match(/^\*\*\* Update File: (.+)$/);
    if (match) {
      flushUpdate();
      pendingUpdate = match[1]!.trim();
      continue;
    }
    match = line.match(/^\*\*\* Move to: (.+)$/);
    if (match && pendingUpdate) {
      operations.push({ kind: "move-out", path: pendingUpdate });
      operations.push({ kind: "move-in", path: match[1]!.trim() });
      pendingUpdate = undefined;
    }
  }
  flushUpdate();
  return operations;
}

export function isRemovalOperation(kind: DocumentationOperationKind): boolean {
  return kind === "delete" || kind === "move-out";
}
