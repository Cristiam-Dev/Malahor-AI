import fs from "node:fs";
import path from "node:path";

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
}

export interface SecretFileFinding {
  kind: SecretKind;
  path: string;
  line: number;
  remediation?: HookRemediation;
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
  removed: string[];
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
];
const PAYLOAD_PATTERNS: SecretPattern[] = [
  ...FILE_PATTERNS,
  { kind: "bearer-token", source: "\\bBearer\\s+[A-Za-z0-9._~+/=-]{20,}" },
];
const SECRET_KIND_SET = new Set<string>(SECRET_KINDS);
const SECRET_PATCH_SUMMARY_BRAND = Symbol("malahor.secret-patch-summary");
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

  for (let index = 0; index < lines.length && findings.length < MAX_EXPORTED_FINDINGS; index += 1) {
    const line = lines[index] ?? "";
    const matchesByPattern = FILE_PATTERNS.map((pattern) => {
      const flags = pattern.flags?.includes("g") ? pattern.flags : `${pattern.flags ?? ""}g`;
      return { pattern, matches: [...line.matchAll(new RegExp(pattern.source, flags))] };
    });
    const lineFindingCount = matchesByPattern.reduce((count, item) => count + item.matches.length, 0);

    for (const { pattern, matches } of matchesByPattern) {
      for (const match of matches) {
        const remediation = pattern.kind === "credential-assignment"
          ? buildSyntheticFixtureRemediation(line, filePath, displayPath, index + 1, match, lineFindingCount)
          : undefined;
        findings.push({
          kind: pattern.kind,
          path: displayPath,
          line: index + 1,
          ...(remediation ? { remediation } : {}),
        });
        if (findings.length >= MAX_EXPORTED_FINDINGS) break;
      }
      if (findings.length >= MAX_EXPORTED_FINDINGS) break;
    }
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

export function secretKinds(counts: SecretCounts): SecretKind[] {
  return SECRET_KINDS.filter((kind) => (counts[kind] ?? 0) > 0);
}

export function buildSecretPatchSummary(patchText: string, cwd: string): SecretPatchSummary {
  const parsed = parsePatchSections(patchText);
  if (!parsed.evaluable || parsed.sections.length === 0 || parsed.sections.length > MAX_PATCH_FILES) {
    return brandedSummary(false, []);
  }

  const root = path.resolve(cwd);
  const seen = new Set<string>();
  const files: SecretPatchFileSummary[] = [];
  for (const section of parsed.sections) {
    const absolute = path.resolve(root, section.path);
    if (!isWithin(absolute, root) || seen.has(absolute)) return brandedSummary(false, []);
    seen.add(absolute);

    if (section.operation === "delete") {
      files.push({ path: section.path, operation: section.operation, before: {}, after: {} });
      continue;
    }

    if (section.operation === "add") {
      if (fs.existsSync(absolute)) return brandedSummary(false, []);
      files.push({
        path: section.path,
        operation: section.operation,
        before: {},
        after: detectFileSecretCounts(section.added.join("\n"), absolute),
      });
      continue;
    }

    const current = readRegularTextFile(absolute);
    if (current === null || section.added.length + section.removed.length === 0
      || !removedLinesExist(current, section.removed)) {
      return brandedSummary(false, []);
    }
    const before = detectFileSecretCounts(current, absolute);
    const removed = detectFileSecretCounts(section.removed.join("\n"));
    const added = detectFileSecretCounts(section.added.join("\n"));
    const after = applySecretDelta(before, removed, added);
    if (!after) return brandedSummary(false, []);
    files.push({ path: section.path, operation: section.operation, before, after });
  }

  return brandedSummary(true, files);
}

export function parseSecretPatchSummary(value: unknown): SecretPatchSummary | null {
  if (typeof value !== "object" || value === null
    || (value as Record<PropertyKey, unknown>)[SECRET_PATCH_SUMMARY_BRAND] !== true) return null;
  const record = objectValue(value);
  if (!record || record.version !== 1 || typeof record.evaluable !== "boolean" || !Array.isArray(record.files)
    || record.files.length === 0 || record.files.length > MAX_PATCH_FILES) return null;

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

  return { version: 1, evaluable: record.evaluable, files };
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

function parsePatchSections(patchText: string): { evaluable: boolean; sections: PatchSection[] } {
  const sections: PatchSection[] = [];
  let current: PatchSection | undefined;
  let evaluable = true;
  const flush = () => {
    if (current) sections.push(current);
    current = undefined;
  };

  for (const line of patchText.split(/\r?\n/)) {
    let match = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (match) {
      flush();
      current = {
        operation: match[1]!.toLowerCase() as PatchSection["operation"],
        path: match[2]!.trim(),
        added: [],
        removed: [],
      };
      if (!current.path) evaluable = false;
      continue;
    }
    if (/^\*\*\* Move to: /.test(line)) {
      evaluable = false;
      continue;
    }
    if (line === "*** Begin Patch" || line === "*** End Patch" || line.startsWith("@@")) continue;
    if (!current) {
      if (line.trim()) evaluable = false;
      continue;
    }
    if (current.operation === "delete") {
      if (line.trim()) evaluable = false;
      continue;
    }
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
    else if (current.operation === "add" && line.trim()) evaluable = false;
  }
  flush();
  return { evaluable, sections };
}

function readRegularTextFile(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SCANNED_FILE_BYTES) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function removedLinesExist(content: string, removed: string[]): boolean {
  const available = new Map<string, number>();
  for (const line of content.split(/\r?\n/)) available.set(line, (available.get(line) ?? 0) + 1);
  for (const line of removed) {
    const count = available.get(line) ?? 0;
    if (count === 0) return false;
    available.set(line, count - 1);
  }
  return true;
}

function applySecretDelta(before: SecretCounts, removed: SecretCounts, added: SecretCounts): SecretCounts | null {
  const after: SecretCounts = {};
  for (const kind of SECRET_KINDS) {
    const existing = before[kind] ?? 0;
    const removedCount = removed[kind] ?? 0;
    if (removedCount > existing) return null;
    const remaining = existing - removedCount + (added[kind] ?? 0);
    if (remaining > 0) after[kind] = remaining;
  }
  return after;
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
    return replacementRemediation({
      path: displayPath,
      line: lineNumber,
      anchor: credentialName,
      before: `${prefix}${credentialName}${operator}${quote}[VALOR SINTETICO OCULTO]${quote}${suffix}`,
      replacement: `${prefix}${credentialName}${operator}${SYNTHETIC_VALUE_EXPRESSION}${suffix}`,
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

        return replacementRemediation({
          path: displayPath,
          line: lineNumber,
          anchor: variableName,
          before: `${prefix}${outerQuote}${credentialName}${operator}${innerQuote}[VALOR SINTETICO OCULTO]${innerQuote}${outerQuote}${suffix}`,
          replacement: `${prefix}[${replacementExpression}].join("")${suffix}`,
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
    || secretKinds(detectFileSecretCounts(replacement)).length > 0) return undefined;

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

function brandedSummary(evaluable: boolean, files: SecretPatchFileSummary[]): SecretPatchSummary {
  const summary: SecretPatchSummary = { version: 1, evaluable, files };
  Object.defineProperty(summary, SECRET_PATCH_SUMMARY_BRAND, { value: true, enumerable: false });
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
