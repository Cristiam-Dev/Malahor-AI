export type CommitType = "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert";

export const COMMIT_TYPES: CommitType[] = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];

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
};

export function composeCommitMessage(input: {
  summary?: string;
  type?: string;
  scope?: string;
  icon?: string;
  paths?: string[];
}): string {
  const type = parseCommitType(input.type) ?? inferCommitType(input.paths ?? []);
  const scope = normalizeScope(input.scope) ?? inferCommitScope(input.paths ?? []);
  const icon = input.icon?.trim() || ICONS[type];
  const prefix = `${icon} ${type}${scope ? `(${scope})` : ""}: `;
  const summary = normalizeSummary(input.summary) || inferCommitSummary(type, scope);

  return `${prefix}${fitSummary(prefix, summary)}`;
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

function inferCommitScope(paths: string[]): string {
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
  return `agrega mejoras de ${scope}`;
}

function normalizeScope(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || undefined;
}

function normalizeSummary(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .replace(/^./, (char) => char.toLowerCase());
}

function fitSummary(prefix: string, summary: string): string {
  const maxSubject = 82;
  const maxSummary = Math.max(24, maxSubject - [...prefix].length);
  if ([...summary].length <= maxSummary) return summary;
  return `${[...summary].slice(0, maxSummary - 1).join("").trimEnd()}…`;
}
