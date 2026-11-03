import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type { HookRemediation } from "./types";

export const SECRET_KINDS = [
  "private-key",
  "aws-access-key",
  "credential-assignment",
  "bearer-token",
  "env-file",
] as const;

export type SecretKind = typeof SECRET_KINDS[number];
export type SecretCounts = Partial<Record<SecretKind, number>>;

export interface SecretPatchFileSummary {
  path: string;
  operation: "add" | "update" | "delete";
  before: SecretCounts;
  after: SecretCounts;
}

export interface SecretPatchSummary {
  version: 1;
  evaluable: boolean;
  files: SecretPatchFileSummary[];
  failure?: SecretPatchDiagnostic;
}

export interface SecretPatchDiagnostic {
  code: "PATCH_NOT_EVALUABLE" | "SECRET_PRESENT" | "SECURITY_CONTROL_UNAVAILABLE";
  reason: "invalid-structure" | "unsupported-operation" | "invalid-path" | "duplicate-target"
    | "file-unavailable" | "context-mismatch" | "ambiguous-context" | "missing-evidence";
  operation?: SecretPatchFileSummary["operation"];
  /** Ruta relativa verificada; nunca una ruta proporcionada sin canonicalizar. */
  path?: string;
  hunk?: number;
}

export interface SecretPatchBinding {
  projectRoot: string;
  project?: string;
  policyHash?: string;
}

export interface SecretFileFinding {
  kind: SecretKind;
  path: string;
  line: number;
  remediation?: HookRemediation;
}

export interface SecretRedactionResult {
  value: string;
  kinds: SecretKind[];
}

interface SecretPattern {
  kind: SecretKind;
  source: string;
  flags?: string;
}

interface PatchSection {
  operation: SecretPatchFileSummary["operation"];
  path: string;
  added: string[];
  hunks: Array<{ before: string[]; after: string[] }>;
}

interface PatchEvidence {
  root: string;
  binding?: SecretPatchBinding;
  patchHash: string;
  summaryHash: string;
  prestate: Array<{ absolute: string; hash: string | null }>;
}

const PRIVATE_KEY_SOURCE = ["-----BEGIN", "(RSA |OPENSSH |EC |DSA )?PRIVATE", "KEY-----"].join(" ");
const CREDENTIAL_NAME_SOURCE = "api[_-]?key|access[_-]?token|secret[_-]?key|password";
const CREDENTIAL_ASSIGNMENT_SOURCE = `(${CREDENTIAL_NAME_SOURCE})(\\s*[:=]\\s*)([\"'])([^\\r\\n\"']{16,})\\3`;
const FILE_PATTERNS: SecretPattern[] = [
  { kind: "private-key", source: PRIVATE_KEY_SOURCE },
  { kind: "aws-access-key", source: "\\b(AKIA|ASIA)[A-Z0-9]{16}\\b" },
  {
    kind: "credential-assignment",
    source: CREDENTIAL_ASSIGNMENT_SOURCE,
    flags: "i",
  },
  { kind: "bearer-token", source: "\\bBearer\\s+[A-Za-z0-9._~+/=-]{20,}" },
];
const PAYLOAD_PATTERNS: SecretPattern[] = FILE_PATTERNS;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g;
const PRIVATE_KEY_HEADER = /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g;
const CREDENTIAL_ASSIGNMENT = new RegExp(CREDENTIAL_ASSIGNMENT_SOURCE, "gi");
const SECRET_KIND_SET = new Set<string>(SECRET_KINDS);
const SECRET_PATCH_SUMMARY_BRAND = Symbol("malahor.secret-patch-summary");
const PATCH_EVIDENCE = new WeakMap<SecretPatchSummary, PatchEvidence>();
const MAX_SCANNED_FILE_BYTES = 512 * 1024;
const MAX_PATCH_FILES = 100;
const MAX_FINDINGS_PER_KIND = 1_000_000;
const MAX_EXPORTED_FINDINGS = 100;
const MAX_REMEDIATION_LINE_CHARS = 500;
const SYNTHETIC_VALUE_EXPRESSION = "[\"synthetic\", \"fixture\", \"credential\"].join(\"-\")";
const SYNTHETIC_VALUE_PATTERN = /^synthetic[-_][A-Za-z0-9._-]{8,80}$/i;
const DIRECT_SYNTHETIC_ASSIGNMENT = new RegExp(
  `^(\\s*(?:(?:export\\s+)?(?:const|let)\\s+)?)(${CREDENTIAL_NAME_SOURCE})(\\s*[:=]\\s*)([\"'])(synthetic[-_][A-Za-z0-9._-]{8,80})\\4([,;]?\\s*)$`,
  "i",
);
const SERIALIZED_DECLARATION = /^(\s*(?:(?:export\s+)?(?:const|let))\s+([A-Za-z_$][A-Za-z0-9_$]{0,127})\s*=\s*)(["'`])(.+)\3(;?\s*)$/;
const SERIALIZED_SYNTHETIC_ASSIGNMENT = new RegExp(
  `^(${CREDENTIAL_NAME_SOURCE})(\\s*[:=]\\s*)([\"'])(synthetic[-_][A-Za-z0-9._-]{8,80})\\3$`,
  "i",
);

export function detectFileSecretCounts(content: string, filePath?: string): SecretCounts {
  const counts = countPatterns(content, FILE_PATTERNS);
  if (filePath && /^\.env(\.|$)/.test(path.basename(filePath))) counts["env-file"] = 1;
  return counts;
}

export function detectFileSecretFindings(
  content: string,
  filePath: string,
  displayPath: string = path.basename(filePath),
): SecretFileFinding[] {
  const findings: SecretFileFinding[] = [];
  const lines = content.split(/\r?\n/);
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle;
    }
    return low;
  };
  const matched = FILE_PATTERNS.flatMap((pattern) => {
    const flags = pattern.flags?.includes("g") ? pattern.flags : `${pattern.flags ?? ""}g`;
    return [...content.matchAll(new RegExp(pattern.source, flags))]
      .map((match) => ({ pattern, match, startLine: lineAt(match.index ?? 0) }));
  }).sort((a, b) => (a.match.index ?? 0) - (b.match.index ?? 0));
  for (const item of matched.slice(0, MAX_EXPORTED_FINDINGS)) {
    const index = item.startLine;
    const line = lines[index] ?? "";
    const match = item.match;
    // Nunca crear una receta de sustitución desde una coincidencia multilinea.
    const onOneLine = !match[0].includes("\n") && !match[0].includes("\r");
    const localMatch = onOneLine ? Object.assign([...match] as unknown as RegExpMatchArray, {
      index: (match.index ?? 0) - starts[index]!, input: line,
    }) : undefined;
    const lineFindingCount = matched.filter((other) => other.startLine === index).length;
    const remediation = item.pattern.kind === "credential-assignment"
      ? localMatch && line.includes(match[0])
        ? buildSyntheticFixtureRemediation(line, filePath, displayPath, index + 1, localMatch, lineFindingCount)
        : removalRemediation(displayPath, index + 1, "unsupported-syntax")
      : undefined;
    findings.push({ kind: item.pattern.kind, path: displayPath, line: index + 1,
      ...(remediation ? { remediation } : {}),
    });
  }

  if (/^\.env(\.|$)/.test(path.basename(filePath))
    && !findings.some((finding) => finding.kind === "env-file")) {
    findings.push({ kind: "env-file", path: displayPath, line: 1 });
  }
  return findings;
}

export function detectPayloadSecretKinds(content: string): string[] {
  return secretKinds(countPatterns(content, PAYLOAD_PATTERNS));
}

/** Redacta valores detectables sin conservarlos en el resultado ni en metadata. */
export function redactPayloadSecrets(content: string): SecretRedactionResult {
  const kinds = new Set<SecretKind>();
  let value = content.replace(PRIVATE_KEY_BLOCK, () => {
    kinds.add("private-key");
    return "<redacted:private-key>";
  });
  value = value.replace(PRIVATE_KEY_HEADER, () => {
    kinds.add("private-key");
    return "<redacted:private-key>";
  });
  value = value.replace(AWS_ACCESS_KEY, () => {
    kinds.add("aws-access-key");
    return "<redacted:aws-access-key>";
  });
  value = value.replace(BEARER_TOKEN, () => {
    kinds.add("bearer-token");
    return "Bearer <redacted:bearer-token>";
  });
  value = value.replace(CREDENTIAL_ASSIGNMENT, (_match, name: string, operator: string, quote: string) => {
    kinds.add("credential-assignment");
    return `${name}${operator}${quote}<redacted:credential-assignment>${quote}`;
  });
  return { value, kinds: SECRET_KINDS.filter((kind) => kinds.has(kind)) };
}

export function isPotentialSecretPath(target: string): boolean {
  const normalized = target.replaceAll("\\", "/");
  const base = path.basename(normalized);
  if (base === ".env.example") return false;
  return /(^|\/)\.env(\.|$)/.test(normalized)
    || /(^|\/)\.ssh\//.test(normalized)
    || /(^|\/)(id_rsa|id_ed25519|credentials|secrets?)(\.|$)/i.test(normalized)
    || /\.(pem|p12|pfx|key)$/i.test(base);
}

export function secretKinds(counts: SecretCounts): SecretKind[] {
  return SECRET_KINDS.filter((kind) => (counts[kind] ?? 0) > 0);
}

export function buildSecretPatchSummary(
  patchText: string,
  cwd: string,
  binding?: SecretPatchBinding,
): SecretPatchSummary {
  const parsed = parsePatchSections(patchText);
  const root = path.resolve(cwd);
  const patchHash = digest(patchText);
  const fail = (reason: SecretPatchDiagnostic["reason"], code: SecretPatchDiagnostic["code"] = "PATCH_NOT_EVALUABLE",
    section?: PatchSection, safePath?: string, hunk?: number): SecretPatchSummary => {
    const failure: SecretPatchDiagnostic = { code, reason,
      ...(section ? { operation: section.operation } : {}),
      ...(safePath ? { path: safePath } : {}),
      ...(hunk ? { hunk } : {}),
    };
    return brandedSummary(false, [], { root, binding, patchHash, prestate: [] }, failure);
  };
  if (parsed.failure) return fail(parsed.failure,
    parsed.failure === "file-unavailable" ? "SECURITY_CONTROL_UNAVAILABLE" : "PATCH_NOT_EVALUABLE");
  if (parsed.sections.length === 0 || parsed.sections.length > MAX_PATCH_FILES) return fail("invalid-structure");

  const seen = new Set<string>();
  const files: SecretPatchFileSummary[] = [];
  const prestate: PatchEvidence["prestate"] = [];
  for (const section of parsed.sections) {
    const absolute = path.resolve(root, section.path);
    if (!section.path || path.isAbsolute(section.path) || /[\\\u0000-\u001f\u007f]/.test(section.path)
      || !isWithin(absolute, root) || absolute === root) return fail("invalid-path", "PATCH_NOT_EVALUABLE", section);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (seen.has(absolute)) return fail("duplicate-target", "PATCH_NOT_EVALUABLE", section, relative);
    seen.add(absolute);
    if (!pathComponentsAreRegular(root, absolute)) return fail("file-unavailable", "SECURITY_CONTROL_UNAVAILABLE", section, relative);
    if (section.operation === "add") {
      if (lstatIfExists(absolute) !== null) return fail("file-unavailable", "PATCH_NOT_EVALUABLE", section, relative);
      const added = section.added.join("\n");
      if (Buffer.byteLength(added) > MAX_SCANNED_FILE_BYTES) return fail("file-unavailable", "SECURITY_CONTROL_UNAVAILABLE", section, relative);
      files.push({
        path: relative,
        operation: section.operation,
        before: {},
        after: detectFileSecretCounts(added, absolute),
      });
      prestate.push({ absolute, hash: null });
      continue;
    }
    const current = readRegularTextFile(absolute);
    if (current === null) return fail("file-unavailable", "SECURITY_CONTROL_UNAVAILABLE", section, relative);
    const before = detectFileSecretCounts(current.content, absolute);
    let after: SecretCounts = {};
    if (section.operation === "update") {
      const simulated = simulateHunks(current.content, section.hunks);
      if (!simulated.ok) return fail(simulated.reason, "PATCH_NOT_EVALUABLE", section, relative, simulated.hunk);
      if (Buffer.byteLength(simulated.content) > MAX_SCANNED_FILE_BYTES) {
        return fail("file-unavailable", "SECURITY_CONTROL_UNAVAILABLE", section, relative);
      }
      after = detectFileSecretCounts(simulated.content, absolute);
    }
    files.push({ path: relative, operation: section.operation, before, after });
    prestate.push({ absolute, hash: current.hash });
  }
  return brandedSummary(true, files, { root, binding, patchHash, prestate });
}

export function parseSecretPatchSummary(value: unknown): SecretPatchSummary | null {
  if (typeof value !== "object" || value === null || !PATCH_EVIDENCE.has(value as SecretPatchSummary)
    || (value as Record<PropertyKey, unknown>)[SECRET_PATCH_SUMMARY_BRAND] !== true) return null;
  const record = objectValue(value);
  const evidence = PATCH_EVIDENCE.get(value as SecretPatchSummary);
  if (!evidence || digest(JSON.stringify(value)) !== evidence.summaryHash) return null;
  if (!record || record.version !== 1 || typeof record.evaluable !== "boolean" || !Array.isArray(record.files)
    || record.files.length > MAX_PATCH_FILES || (record.evaluable && record.files.length === 0)) return null;

  const seen = new Set<string>();
  const files: SecretPatchFileSummary[] = [];
  for (const item of record.files) {
    const file = objectValue(item);
    if (!file || typeof file.path !== "string" || !file.path.trim() || file.path.length > 4096
      || !["add", "update", "delete"].includes(String(file.operation))) return null;
    if (seen.has(file.path)) return null;
    seen.add(file.path);
    const before = parseSecretCounts(file.before);
    const after = parseSecretCounts(file.after);
    if (!before || !after) return null;
    files.push({
      path: file.path,
      operation: file.operation as SecretPatchFileSummary["operation"],
      before,
      after,
    });
  }

  const failure = objectValue(record.failure);
  return { version: 1, evaluable: record.evaluable, files,
    ...(failure && typeof failure.code === "string" && typeof failure.reason === "string"
      ? { failure: failure as unknown as SecretPatchDiagnostic } : {}),
  };
}

/** Evidencia privada: nunca confiar en un resumen suministrado por el caller. */
export function revalidateSecretPatchSummary(
  value: unknown,
  cwd: string,
  binding?: SecretPatchBinding,
): boolean {
  const summary = parseSecretPatchSummary(value);
  const evidence = PATCH_EVIDENCE.get(value as SecretPatchSummary);
  if (!summary?.evaluable || !evidence || evidence.root !== path.resolve(cwd)) return false;
  if (JSON.stringify(evidence.binding ?? null) !== JSON.stringify(binding ?? null)) return false;
  for (const item of evidence.prestate) {
    if (!pathComponentsAreRegular(evidence.root, item.absolute)) return false;
    if (item.hash === null) {
      if (lstatIfExists(item.absolute) !== null) return false;
    } else if (readRegularTextFile(item.absolute)?.hash !== item.hash) return false;
  }
  return true;
}

function countPatterns(content: string, patterns: SecretPattern[]): SecretCounts {
  const counts: SecretCounts = {};
  for (const pattern of patterns) {
    const flags = pattern.flags?.includes("g") ? pattern.flags : `${pattern.flags ?? ""}g`;
    const count = [...content.matchAll(new RegExp(pattern.source, flags))].length;
    if (count > 0) counts[pattern.kind] = count;
  }
  return counts;
}

function parsePatchSections(patchText: string): { sections: PatchSection[]; failure?: SecretPatchDiagnostic["reason"] } {
  const sections: PatchSection[] = [];
  if (Buffer.byteLength(patchText) > MAX_SCANNED_FILE_BYTES) return { sections, failure: "file-unavailable" };
  const lines = patchText.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
    return { sections, failure: "invalid-structure" };
  }
  let current: PatchSection | undefined;
  let hunk: PatchSection["hunks"][number] | undefined;
  for (const line of lines) {
    let match = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (match) {
      if (current) sections.push(current);
      current = {
        operation: match[1]!.toLowerCase() as PatchSection["operation"],
        path: match[2]!.trim(),
        added: [],
        hunks: [],
      };
      hunk = undefined;
      if (!current.path) return { sections, failure: "invalid-structure" };
      continue;
    }
    if (!current) return { sections, failure: "invalid-structure" };
    if (line.startsWith("***")) return { sections, failure: "unsupported-operation" };
    if (current.operation === "delete") return { sections, failure: "invalid-structure" };
    if (current.operation === "add") {
      if (!line.startsWith("+")) return { sections, failure: "invalid-structure" };
      current.added.push(line.slice(1));
      continue;
    }
    if (line === "@@" || line.startsWith("@@ ")) {
      hunk = { before: [], after: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) return { sections, failure: "invalid-structure" };
    if (line.startsWith("+")) hunk.after.push(line.slice(1));
    else if (line.startsWith("-")) hunk.before.push(line.slice(1));
    else if (line.startsWith(" ")) {
      hunk.before.push(line.slice(1));
      hunk.after.push(line.slice(1));
    } else return { sections, failure: "invalid-structure" };
  }
  if (current) sections.push(current);
  if (sections.some((section) => section.operation === "update" && (
    section.hunks.length === 0 || section.hunks.some((item) => item.before.length === 0)))) {
    return { sections, failure: "invalid-structure" };
  }
  return { sections };
}

function readRegularTextFile(filePath: string): { content: string; hash: string } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_SCANNED_FILE_BYTES) return null;
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const byPath = fs.lstatSync(filePath);
    if (!byPath.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeMs !== after.mtimeMs || before.size !== after.size
      || before.dev !== byPath.dev || before.ino !== byPath.ino || bytes.length > MAX_SCANNED_FILE_BYTES) return null;
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.includes("\u0000") || content.includes("\r")) return null;
    return { content, hash: digest(bytes) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function simulateHunks(content: string, hunks: PatchSection["hunks"]):
  | { ok: true; content: string }
  | { ok: false; reason: "context-mismatch" | "ambiguous-context"; hunk: number } {
  const lines = content.split("\n");
  let cursor = 0;
  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index]!;
    const matches: number[] = [];
    for (let offset = cursor; offset <= lines.length - hunk.before.length; offset += 1) {
      if (hunk.before.every((line, position) => lines[offset + position] === line)) matches.push(offset);
      if (matches.length > 1) break;
    }
    if (matches.length !== 1) return { ok: false, reason: matches.length ? "ambiguous-context" : "context-mismatch", hunk: index + 1 };
    const at = matches[0]!;
    lines.splice(at, hunk.before.length, ...hunk.after);
    cursor = at + hunk.after.length;
  }
  return { ok: true, content: lines.join("\n") };
}

function pathComponentsAreRegular(root: string, target: string): boolean {
  try {
    if (!fs.lstatSync(root).isDirectory()) return false;
    if (fs.realpathSync(root) !== root) return false;
    let directory = root;
    const components = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
    for (const component of components) {
      directory = path.join(directory, component);
      if (!fs.lstatSync(directory).isDirectory()) return false;
    }
    const targetStat = lstatIfExists(target);
    return targetStat === null || targetStat.isFile();
  } catch {
    return false;
  }
}

function lstatIfExists(target: string): fs.Stats | null {
  try { return fs.lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseSecretCounts(value: unknown): SecretCounts | null {
  const record = objectValue(value);
  if (!record) return null;
  const counts: SecretCounts = {};
  for (const [kind, count] of Object.entries(record)) {
    if (!SECRET_KIND_SET.has(kind) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0
      || count > MAX_FINDINGS_PER_KIND) return null;
    if (count > 0) counts[kind as SecretKind] = count;
  }
  return counts;
}

/** El marcador es una referencia saneada, no un segundo valor de credencial. */
function containsOtherPayloadSecret(before: string, replacement: string): boolean {
  const withoutMarker = before.replaceAll("[VALOR SINTETICO OCULTO]", "x");
  return detectPayloadSecretKinds(withoutMarker).length > 0
    || detectPayloadSecretKinds(replacement).length > 0;
}

function buildSyntheticFixtureRemediation(
  line: string,
  filePath: string,
  displayPath: string,
  lineNumber: number,
  match: RegExpMatchArray,
  lineFindingCount: number,
): HookRemediation {
  if (!isSyntheticFixturePath(filePath)) {
    return removalRemediation(displayPath, lineNumber, "unsupported-file-type");
  }
  if (line.length > MAX_REMEDIATION_LINE_CHARS) {
    return removalRemediation(displayPath, lineNumber, "line-too-long");
  }
  if (lineFindingCount !== 1) {
    return removalRemediation(displayPath, lineNumber, "multiple-findings");
  }

  const detectedValue = match[4];
  if (typeof detectedValue !== "string" || !SYNTHETIC_VALUE_PATTERN.test(detectedValue)) {
    return removalRemediation(displayPath, lineNumber, "value-not-demonstrably-synthetic");
  }

  const direct = DIRECT_SYNTHETIC_ASSIGNMENT.exec(line);
  if (direct) {
    const [, prefix = "", credentialName = "", operator = "", quote = "", , suffix = ""] = direct;
    const before = `${prefix}${credentialName}${operator}${quote}[VALOR SINTETICO OCULTO]${quote}${suffix}`;
    const replacement = `${prefix}${credentialName}${operator}${SYNTHETIC_VALUE_EXPRESSION}${suffix}`;
    if (containsOtherPayloadSecret(before, replacement)) {
      return removalRemediation(displayPath, lineNumber, "multiple-findings");
    }
    return replacementRemediation({
      path: displayPath,
      line: lineNumber,
      anchor: credentialName,
      before,
      replacement,
    });
  }

  const declaration = SERIALIZED_DECLARATION.exec(line);
  if (declaration) {
    const [, prefix = "", variableName = "", outerQuote = "", serialized = "", suffix = ""] = declaration;
    const assignment = SERIALIZED_SYNTHETIC_ASSIGNMENT.exec(serialized);
    if (assignment) {
      const [, credentialName = "", operator = "", innerQuote = ""] = assignment;
      const credentialExpression = credentialNameExpression(credentialName);
      if (credentialExpression) {
        const replacementExpression = [
          credentialExpression,
          JSON.stringify(`${operator}${innerQuote}`),
          SYNTHETIC_VALUE_EXPRESSION,
          JSON.stringify(innerQuote),
        ].join(", ");

        const before = `${prefix}${outerQuote}${credentialName}${operator}${innerQuote}[VALOR SINTETICO OCULTO]${innerQuote}${outerQuote}${suffix}`;
        const replacement = `${prefix}[${replacementExpression}].join("")${suffix}`;
        if (containsOtherPayloadSecret(before, replacement)) {
          return removalRemediation(displayPath, lineNumber, "multiple-findings");
        }
        return replacementRemediation({
          path: displayPath,
          line: lineNumber,
          anchor: variableName,
          before,
          replacement,
        });
      }
    }
  }

  return buildComplexStringRemediation(line, filePath, displayPath, lineNumber, match)
    ?? removalRemediation(displayPath, lineNumber, "unsupported-syntax");
}

interface SourceStringLiteral {
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
  quote: "\"" | "'" | "`";
  interpolated: boolean;
}

function buildComplexStringRemediation(
  line: string,
  filePath: string,
  displayPath: string,
  lineNumber: number,
  match: RegExpMatchArray,
): Extract<HookRemediation, { kind: "replace-block" }> | undefined {
  if (/\.[cm]?[jt]sx$/i.test(path.basename(filePath))) return undefined;
  const matchStart = match.index;
  const credentialName = match[1];
  const operator = match[2];
  const innerQuote = match[3];
  const detectedValue = match[4];
  if (matchStart === undefined || !credentialName || operator === undefined || !innerQuote || !detectedValue) {
    return undefined;
  }
  const matchEnd = matchStart + match[0].length;
  const literal = scanSourceStringLiterals(line)
    .find((item) => item.contentStart <= matchStart && item.contentEnd >= matchEnd);
  if (!literal || literal.interpolated || !isExpressionStringContext(line, literal)) return undefined;

  const leading = decodeStringFragment(line.slice(literal.contentStart, matchStart), literal.quote);
  const trailing = decodeStringFragment(line.slice(matchEnd, literal.contentEnd), literal.quote);
  const credentialExpression = credentialNameExpression(credentialName);
  const before = sanitizedLineReference(line, match, detectedValue);
  if (leading === undefined || trailing === undefined || !credentialExpression || !before) return undefined;

  const expression = [
    JSON.stringify(leading),
    credentialExpression,
    JSON.stringify(`${operator}${innerQuote}`),
    SYNTHETIC_VALUE_EXPRESSION,
    JSON.stringify(`${innerQuote}${trailing}`),
  ].join(", ");
  const replacement = `${line.slice(0, literal.start)}[${expression}].join("")${line.slice(literal.end)}`;
  if (before.includes(detectedValue) || replacement.includes(detectedValue)
    || containsOtherPayloadSecret(before, replacement)) return undefined;

  return replacementRemediation({
    path: displayPath,
    line: lineNumber,
    anchor: sourceAnchor(line.slice(0, literal.start), credentialName),
    before,
    replacement,
  });
}

function scanSourceStringLiterals(line: string): SourceStringLiteral[] {
  const literals: SourceStringLiteral[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === "/" && line[index + 1] === "/") break;
    const quote = line[index];
    if (quote !== "\"" && quote !== "'" && quote !== "`") {
      index += 1;
      continue;
    }

    const start = index;
    let interpolated = false;
    index += 1;
    while (index < line.length) {
      const current = line[index];
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (quote === "`" && current === "$" && line[index + 1] === "{") interpolated = true;
      if (current === quote) {
        literals.push({
          start,
          contentStart: start + 1,
          contentEnd: index,
          end: index + 1,
          quote,
          interpolated,
        });
        index += 1;
        break;
      }
      index += 1;
    }
    if (index >= line.length && line[index - 1] !== quote) return [];
  }
  return literals;
}

function isExpressionStringContext(line: string, literal: SourceStringLiteral): boolean {
  const before = line.slice(0, literal.start).trimEnd();
  const after = line.slice(literal.end).trimStart();
  if (!before || /^(?:\/\/|\/\*|\*)/.test(before.trimStart())) return false;
  if (/\b(?:import|interface|enum|type)\b/.test(before)) return false;
  if (after.startsWith(":")) return false;
  return ["=", "(", "[", ",", ":"].includes(before.at(-1) ?? "");
}

function decodeStringFragment(raw: string, quote: SourceStringLiteral["quote"]): string | undefined {
  let output = "";
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index] ?? "";
    if (quote === "`" && current === "$" && raw[index + 1] === "{") return undefined;
    if (current !== "\\") {
      if (current === quote) return undefined;
      output += current;
      continue;
    }

    const escaped = raw[++index];
    if (escaped === undefined) return undefined;
    const simple: Record<string, string> = {
      "\\": "\\",
      "\"": "\"",
      "'": "'",
      "`": "`",
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
      0: "\0",
    };
    if (escaped in simple) {
      output += simple[escaped];
      continue;
    }
    if (escaped === "x") {
      const value = decodeHexEscape(raw.slice(index + 1, index + 3), 2);
      if (value === undefined) return undefined;
      output += value;
      index += 2;
      continue;
    }
    if (escaped === "u") {
      const value = decodeUnicodeEscape(raw, index + 1);
      if (!value) return undefined;
      output += value.character;
      index = value.end;
      continue;
    }
    return undefined;
  }
  return output;
}

function decodeHexEscape(raw: string, length: number): string | undefined {
  if (raw.length !== length || !new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(raw)) return undefined;
  return String.fromCodePoint(Number.parseInt(raw, 16));
}

function decodeUnicodeEscape(raw: string, start: number): { character: string; end: number } | undefined {
  if (raw[start] === "{") {
    const close = raw.indexOf("}", start + 1);
    if (close < 0) return undefined;
    const digits = raw.slice(start + 1, close);
    if (!/^[0-9A-Fa-f]{1,6}$/.test(digits)) return undefined;
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff) return undefined;
    return { character: String.fromCodePoint(codePoint), end: close };
  }
  const digits = raw.slice(start, start + 4);
  const character = decodeHexEscape(digits, 4);
  return character === undefined ? undefined : { character, end: start + 3 };
}

function sanitizedLineReference(
  line: string,
  match: RegExpMatchArray,
  detectedValue: string,
): string | undefined {
  const matchStart = match.index;
  const credentialName = match[1];
  const operator = match[2];
  const innerQuote = match[3];
  if (matchStart === undefined || !credentialName || operator === undefined || !innerQuote) return undefined;
  const valueStart = matchStart + credentialName.length + operator.length + innerQuote.length;
  const valueEnd = valueStart + detectedValue.length;
  if (line.slice(valueStart, valueEnd) !== detectedValue) return undefined;
  return `${line.slice(0, valueStart)}[VALOR SINTETICO OCULTO]${line.slice(valueEnd)}`;
}

function sourceAnchor(prefix: string, fallback: string): string {
  return prefix.match(/([A-Za-z_$][A-Za-z0-9_$]{0,127})\s*[:=]?\s*$/)?.[1] ?? fallback;
}

function removalRemediation(
  displayPath: string,
  lineNumber: number,
  reason: Extract<HookRemediation, { kind: "remove-secret" }>["reason"],
): Extract<HookRemediation, { kind: "remove-secret" }> {
  return {
    version: 1,
    kind: "remove-secret",
    reason,
    path: displayPath,
    startLine: lineNumber,
    endLine: lineNumber,
    finding: "credential-assignment",
    revalidate: true,
  };
}

function replacementRemediation(input: {
  path: string;
  line: number;
  anchor: string;
  before: string;
  replacement: string;
}): Extract<HookRemediation, { kind: "replace-block" }> {
  return {
    version: 1,
    kind: "replace-block",
    reason: "synthetic-test-fixture",
    path: input.path,
    startLine: input.line,
    endLine: input.line,
    anchor: input.anchor,
    before: [input.before],
    replacement: [input.replacement],
    revalidate: true,
  };
}

function credentialNameExpression(value: string): string | undefined {
  const separator = value.includes("_") ? "_" : value.includes("-") ? "-" : "";
  let parts = separator ? value.split(separator) : credentialCamelParts(value);
  parts = parts.filter(Boolean);
  if (parts.length < 2 || parts.join(separator) !== value) return undefined;
  return `[${parts.map((part) => JSON.stringify(part)).join(", ")}].join(${JSON.stringify(separator)})`;
}

function credentialCamelParts(value: string): string[] {
  const normalized = value.toLowerCase();
  if (normalized === "apikey") return [value.slice(0, 3), value.slice(3)];
  if (normalized === "accesstoken") return [value.slice(0, 6), value.slice(6)];
  if (normalized === "secretkey") return [value.slice(0, 6), value.slice(6)];
  if (normalized === "password") return [value.slice(0, 4), value.slice(4)];
  return [];
}

function isSyntheticFixturePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const basename = path.basename(normalized);
  if (!/\.[cm]?[jt]sx?$/i.test(basename)) return false;
  return /\/(?:tests?|__tests__|fixtures?)(?:\/|$)/i.test(normalized)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(basename);
}

function brandedSummary(
  evaluable: boolean,
  files: SecretPatchFileSummary[],
  evidence: Omit<PatchEvidence, "summaryHash">,
  failure?: SecretPatchDiagnostic,
): SecretPatchSummary {
  const summary: SecretPatchSummary = { version: 1, evaluable, files, ...(failure ? { failure } : {}) };
  Object.defineProperty(summary, SECRET_PATCH_SUMMARY_BRAND, { value: true, enumerable: false });
  PATCH_EVIDENCE.set(summary, { ...evidence, summaryHash: digest(JSON.stringify(summary)) });
  return summary;
}

function isWithin(value: string, root: string): boolean {
  const relative = path.relative(root, value);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
