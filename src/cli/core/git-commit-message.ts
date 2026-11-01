export const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
  "security",
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

export const MAX_COMMIT_SUBJECT_LENGTH = 82;

const ICONS: Record<CommitType, string> = {
  feat: "✨",
  fix: "🐛",
  docs: "📝",
  style: "🎨",
  refactor: "♻️",
  perf: "⚡",
  test: "✅",
  build: "📦",
  ci: "👷",
  chore: "🔧",
  revert: "⏪",
  security: "🛡️",
};

const COMMIT_TYPE_PATTERN = COMMIT_TYPES.join("|");
const SCOPE_SEGMENT = String.raw`[\p{L}\p{N}][\p{L}\p{M}\p{N}]*`;
const COMMIT_SUBJECT_PATTERN = new RegExp(
  String.raw`^(\S+) (${COMMIT_TYPE_PATTERN})(?:\((${SCOPE_SEGMENT}(?:-${SCOPE_SEGMENT})*)\))?(!)?: (\S(?:.*\S)?)$`,
  "u",
);
const GRAPHEME_SEGMENTER = new Intl.Segmenter("es", { granularity: "grapheme" });

export interface ComposeCommitMessageInput {
  summary?: string;
  type?: string;
  scope?: string;
  icon?: string;
  paths?: string[];
  breaking?: boolean;
}

export function composeCommitMessage(input: ComposeCommitMessageInput): string {
  const type = parseCommitType(input.type) ?? inferCommitType(input.paths ?? []);
  const scope = normalizeScope(input.scope) ?? inferCommitScope(input.paths ?? []);
  const icon = input.icon?.trim() || ICONS[type];
  if (!isEmojiGrapheme(icon)) {
    throw new Error(`Icono de commit invalido: ${icon || "<vacio>"}. Usa un unico emoji.`);
  }

  const prefix = `${icon} ${type}${scope ? `(${scope})` : ""}${input.breaking ? "!" : ""}: `;
  const summary = normalizeSummary(input.summary) || inferCommitSummary(type, scope ?? "malahor");
  const message = `${prefix}${fitSummary(prefix, summary)}`;
  if (!isValidCommitSubject(message)) {
    throw new Error("No se pudo generar un subject que cumpla el contrato de commit de Malahor.");
  }
  return message;
}

export function isValidCommitSubject(subject: string): boolean {
  if (!subject || subject.includes("\n") || subject.includes("\r")) return false;
  if ([...subject].length > MAX_COMMIT_SUBJECT_LENGTH) return false;
  const match = COMMIT_SUBJECT_PATTERN.exec(subject);
  if (!match) return false;
  return isEmojiGrapheme(match[1] ?? "");
}

export function isEmojiGrapheme(value: string): boolean {
  if (!value || /\s/u.test(value)) return false;
  const graphemes = [...GRAPHEME_SEGMENTER.segment(value)];
  if (graphemes.length !== 1 || graphemes[0]?.segment !== value) return false;
  return /\p{Extended_Pictographic}/u.test(value)
    || /^(?:\p{Regional_Indicator}){2}$/u.test(value)
    || /^[#*0-9]\uFE0F?\u20E3$/u.test(value);
}

function parseCommitType(value: string | undefined): CommitType | undefined {
  if (!value) return undefined;
  if (COMMIT_TYPES.includes(value as CommitType)) return value as CommitType;
  throw new Error(`Tipo de commit invalido: ${value}. Usa ${COMMIT_TYPES.join(", ")}.`);
}

function inferCommitType(paths: string[]): CommitType {
  if (paths.length > 0 && paths.every((file) => /(^|\/)(README|CHANGELOG|docs?|assets\/opencode\/OPENCODE)\b|\.md$/i.test(file))) return "docs";
  if (paths.some((file) => /(^|\/)(tests?|__tests__|spec)\//.test(file) || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file))) return "test";
  if (paths.some((file) => /(^|\/)(package\.json|bun\.lockb?|tsconfig\.json)$/.test(file))) return "build";
  return "feat";
}

function inferCommitScope(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  if (paths.length > 0 && paths.every((file) => file.endsWith(".md"))) return "docs";
  if (paths.some((file) => file.includes("/hooks/") || file.includes("commands/hooks"))) return "hooks";
  if (paths.some((file) => file.startsWith("src/mnemo/"))) return "mnemo";
  if (paths.some((file) => file.startsWith("src/cli/"))) return "cli";
  if (paths.some((file) => file.startsWith("assets/opencode/"))) return "opencode";
  if (paths.some((file) => file.startsWith("tests/"))) return "tests";
  return "malahor";
}

function inferCommitSummary(type: CommitType, scope: string): string {
  if (type === "docs") return `actualiza documentacion de ${scope}`;
  if (type === "test") return `agrega cobertura para ${scope}`;
  if (type === "fix") return `corrige ${scope}`;
  if (type === "security") return `protege ${scope}`;
  return `agrega mejoras de ${scope}`;
}

function normalizeScope(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return value
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("es")
    .replace(/[^\p{L}\p{M}\p{N}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || undefined;
}

function normalizeSummary(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/gu, "")
    .replace(/^./u, (character) => character.toLocaleLowerCase("es"));
}

function fitSummary(prefix: string, summary: string): string {
  const maxSummary = MAX_COMMIT_SUBJECT_LENGTH - [...prefix].length;
  if (maxSummary < 1) {
    throw new Error(`Tipo, scope e icono exceden el limite de ${MAX_COMMIT_SUBJECT_LENGTH} caracteres.`);
  }
  if ([...summary].length <= maxSummary) return summary;
  if (maxSummary === 1) return "…";
  return `${[...summary].slice(0, maxSummary - 1).join("").trimEnd()}…`;
}
