import fs from "node:fs";
import path from "node:path";

import { classifyGitCommand, type GitCommandPolicyOptions } from "./git-command-policy";
import { COMMIT_TYPES } from "./git-commit-message";

export interface ReadOnlyShellClassification {
  readOnly: boolean;
  reason?: string;
}

export interface ReadOnlyShellOptions {
  workingDirectory?: string;
  git?: GitCommandPolicyOptions;
}

const SAFE_GIT_COMMANDS = new Set([
  "diff", "log", "ls-files", "rev-parse", "show", "status",
]);
const SAFE_GIT_GLOBAL_OPTIONS = new Set([
  "--no-pager", "--no-optional-locks", "--literal-pathspecs", "--glob-pathspecs",
  "--noglob-pathspecs", "--icase-pathspecs",
]);
const GIT_STATUS_FLAGS = new Set([
  "-s", "--short", "-b", "--branch", "--show-stash", "--long", "-v", "-vv",
  "-z", "--null", "--no-renames", "--renames", "--ahead-behind", "--no-ahead-behind",
]);
const GIT_DIFF_FLAGS = new Set([
  "-p", "--patch", "-s", "--no-patch", "--raw", "--patch-with-raw", "--stat",
  "--numstat", "--shortstat", "--compact-summary", "--summary", "--name-only",
  "--name-status", "--check", "--cached", "--staged", "--quiet", "--exit-code",
  "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--submodule",
  "--ignore-submodules", "--no-color",
]);
const GIT_HISTORY_FLAGS = new Set([
  "--oneline", "--stat", "--numstat", "--shortstat", "--summary", "--name-only",
  "--name-status", "--no-patch", "-s", "--patch", "-p", "--graph", "--decorate",
  "--no-decorate", "--first-parent", "--merges", "--no-merges", "--reverse",
  "--date-order", "--author-date-order", "--topo-order", "--full-history",
  "--simplify-merges", "--no-ext-diff", "--no-textconv", "--no-color",
]);
const GIT_LS_FILES_FLAGS = new Set([
  "-c", "--cached", "-d", "--deleted", "-m", "--modified", "-o", "--others",
  "-i", "--ignored", "-s", "--stage", "-u", "--unmerged", "-k", "--killed",
  "--directory", "--no-empty-directory", "--exclude-standard", "--full-name",
  "--recurse-submodules", "--error-unmatch", "--deduplicate", "-z", "--debug", "--eol",
]);
const GIT_REV_PARSE_FLAGS = new Set([
  "--verify", "--quiet", "-q", "--short", "--abbrev-ref", "--symbolic",
  "--symbolic-full-name", "--show-toplevel", "--show-prefix", "--show-cdup",
  "--show-superproject-working-tree", "--git-dir", "--absolute-git-dir",
  "--is-inside-git-dir", "--is-inside-work-tree", "--is-bare-repository",
  "--is-shallow-repository", "--show-object-format", "--sq", "--revs-only",
  "--no-revs", "--flags", "--no-flags", "--default",
]);
const GIT_FORMAT_OPTIONS = new Set([
  "--format", "--pretty", "--date", "--author", "--committer", "--grep",
]);
const GIT_NUMERIC_OPTIONS = new Set([
  "-n", "--max-count", "-U", "--unified", "--abbrev",
]);
const RG_FLAGS = new Set([
  "-n", "--line-number", "-i", "--ignore-case", "-S", "--smart-case", "-F",
  "--fixed-strings", "-l", "--files-with-matches", "--files", "--hidden",
  "--no-ignore", "--stats", "-c", "--count", "--count-matches", "--json",
  "--no-messages", "--pcre2",
]);
const RG_OPTIONS_WITH_VALUE = new Set([
  "-g", "--glob", "-t", "--type", "-T", "--type-not", "-m", "--max-count",
  "-A", "--after-context", "-B", "--before-context", "-C", "--context",
  "--max-depth",
]);
const TEST_PATH_OPERATORS = new Set([
  "-e", "-f", "-d", "-r", "-w", "-x", "-s", "-L", "-h", "-b", "-c",
  "-p", "-S",
]);
const COMMIT_MESSAGE_FLAGS = new Set(["--breaking", "--json"]);
const COMMIT_MESSAGE_OPTIONS = new Set(["--type", "--scope", "--icon", "--message", "--profile", "--project"]);
const COMMIT_MESSAGE_TYPES = new Set<string>(COMMIT_TYPES);

export function classifyReadOnlyShellCommand(
  command: string,
  projectRoot: string,
  options: ReadOnlyShellOptions = {},
): ReadOnlyShellClassification {
  const workingDirectory = options.workingDirectory ?? projectRoot;
  if (!safeProjectDirectory(workingDirectory, projectRoot)) return denied("directorio-fuera-del-proyecto");
  const segments = splitReadOnlySegments(command);
  if (!segments) return denied("sintaxis-shell-no-admitida");
  for (const segment of segments) {
    const tokens = shellTokens(segment);
    if (!tokens || tokens.length === 0
      || !segmentIsReadOnly(tokens, segment, projectRoot, workingDirectory, options.git ?? {})) {
      return denied("segmento-no-verificable");
    }
  }
  return { readOnly: true };
}

function segmentIsReadOnly(
  tokens: string[],
  segment: string,
  projectRoot: string,
  workingDirectory: string,
  gitOptions: GitCommandPolicyOptions,
): boolean {
  const executable = tokens[0] ?? "";
  if (!/^[A-Za-z0-9_+.[\]-]+$/.test(executable)) return false;
  switch (executable.toLowerCase()) {
    case "git":
    case "git.exe":
      return gitIsReadOnly(tokens, segment, projectRoot, workingDirectory, gitOptions);
    case "sha256sum":
      return hashIsReadOnly(tokens.slice(1), projectRoot, workingDirectory);
    case "cmp":
      return cmpIsReadOnly(tokens.slice(1), projectRoot, workingDirectory);
    case "rg":
      return ripgrepIsReadOnly(tokens.slice(1), projectRoot, workingDirectory);
    case "test":
      return testIsReadOnly(tokens.slice(1), projectRoot, workingDirectory);
    case "pwd":
      return tokens.slice(1).every((token) => token === "-L" || token === "-P");
    case "malahor-ai":
    case "malahor-ai.exe":
      return malahorCommitMessageIsReadOnly(tokens.slice(1));
    default:
      return false;
  }
}

function malahorCommitMessageIsReadOnly(args: string[]): boolean {
  if (args[0] !== "git" || args[1] !== "commit-message") return false;
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (COMMIT_MESSAGE_FLAGS.has(arg)) {
      if (seen.has(arg)) return false;
      seen.add(arg);
      continue;
    }
    if (COMMIT_MESSAGE_OPTIONS.has(arg)) {
      if (seen.has(arg)) return false;
      const value = args[index + 1];
      if (!value || value.startsWith("--") || value.includes("\0")) return false;
      if (arg === "--type" && !COMMIT_MESSAGE_TYPES.has(value)) return false;
      seen.add(arg);
      index += 1;
      continue;
    }
    if (!arg || arg.startsWith("-") || arg.includes("\0")) return false;
  }
  return true;
}

function gitIsReadOnly(
  tokens: string[],
  segment: string,
  projectRoot: string,
  workingDirectory: string,
  options: GitCommandPolicyOptions,
): boolean {
  let index = 1;
  while (index < tokens.length && tokens[index]?.startsWith("-")) {
    const option = tokens[index] ?? "";
    if (!SAFE_GIT_GLOBAL_OPTIONS.has(option)) return false;
    index += 1;
  }
  const subcommand = tokens[index]?.toLowerCase();
  if (!subcommand || !SAFE_GIT_COMMANDS.has(subcommand)) return false;
  if (!closedGitArguments(subcommand, tokens.slice(index + 1), projectRoot, workingDirectory)) return false;
  const classification = classifyGitCommand(segment, options);
  return classification.hasGitCommand && !classification.remote && !classification.failClosed
    && !classification.destructive && classification.operations.length > 0
    && classification.operations.every((operation) => operation === "read");
}

function closedGitArguments(
  subcommand: string,
  args: string[],
  projectRoot: string,
  workingDirectory: string,
): boolean {
  switch (subcommand) {
    case "status":
      return parseGitArguments(args, GIT_STATUS_FLAGS, new Set(), projectRoot, workingDirectory, "paths", [
        /^--porcelain(?:=v[12])?$/,
        /^--untracked-files(?:=(?:no|normal|all))?$/,
        /^--ignored(?:=(?:traditional|matching|no))?$/,
        /^--ignore-submodules(?:=(?:none|untracked|dirty|all))?$/,
        /^--column(?:=[a-z,]+)?$/,
        /^--find-renames(?:=\d+%?)?$/,
      ]);
    case "diff":
      return parseGitArguments(args, GIT_DIFF_FLAGS, GIT_NUMERIC_OPTIONS, projectRoot, workingDirectory, "refs", [
        /^-U\d+$/,
        /^--unified=\d+$/,
        /^--abbrev=\d+$/,
        /^--color(?:=(?:always|never|auto))?$/,
        /^--word-diff(?:=(?:plain|color|porcelain|none))?$/,
        /^--find-renames(?:=\d+%?)?$/,
        /^--diff-filter=[ACDMRTUXB*]+$/i,
      ]);
    case "log":
    case "show":
      return parseGitArguments(args, GIT_HISTORY_FLAGS, new Set([...GIT_FORMAT_OPTIONS, ...GIT_NUMERIC_OPTIONS]), projectRoot, workingDirectory, "refs", [
        /^-\d+$/,
        /^--max-count=\d+$/,
        /^--abbrev=\d+$/,
        /^--color(?:=(?:always|never|auto))?$/,
        /^--format=.+$/,
        /^--pretty=.+$/,
        /^--date=.+$/,
        /^--author=.+$/,
        /^--committer=.+$/,
        /^--grep=.+$/,
      ]);
    case "ls-files":
      return parseGitArguments(args, GIT_LS_FILES_FLAGS, new Set(["--format", "--with-tree"]), projectRoot, workingDirectory, "paths", [
        /^--format=.+$/,
        /^--with-tree=.+$/,
      ]);
    case "rev-parse":
      return parseGitArguments(args, GIT_REV_PARSE_FLAGS, new Set(), projectRoot, workingDirectory, "refs", [
        /^--short=\d+$/,
        /^--abbrev-ref=(?:strict|loose)$/,
        /^--path-format=(?:absolute|relative)$/,
        /^--show-object-format(?:=(?:storage|input|output))?$/,
      ]);
    default:
      return false;
  }
}

function parseGitArguments(
  args: string[],
  flags: ReadonlySet<string>,
  optionsWithValue: ReadonlySet<string>,
  projectRoot: string,
  workingDirectory: string,
  positionals: "paths" | "refs",
  optionPatterns: RegExp[],
): boolean {
  let pathsOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      pathsOnly = true;
      continue;
    }
    if (!pathsOnly && flags.has(arg)) continue;
    if (!pathsOnly && optionPatterns.some((pattern) => pattern.test(arg))) continue;
    if (!pathsOnly && optionsWithValue.has(arg)) {
      const value = args[index + 1];
      if (!value || value === "--" || !safeGitOptionValue(arg, value)) return false;
      index += 1;
      continue;
    }
    if (!pathsOnly && arg.startsWith("-")) return false;
    if (pathsOnly || positionals === "paths") {
      if (!safeProjectPath(arg, projectRoot, workingDirectory, false, true)) return false;
      continue;
    }
    if (!safeGitOperand(arg)) return false;
  }
  return true;
}

function safeGitOptionValue(option: string, value: string): boolean {
  if (GIT_NUMERIC_OPTIONS.has(option)) return /^\d+$/.test(value);
  return !value.includes("\0");
}

function safeGitOperand(value: string): boolean {
  return value.length > 0
    && !value.includes("\0")
    && !path.isAbsolute(value)
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.startsWith("~")
    && !/(^|[\\/:])\.\.(?:[\\/:]|$)/.test(value);
}

function hashIsReadOnly(args: string[], projectRoot: string, workingDirectory: string): boolean {
  const paths: string[] = [];
  for (const arg of args) {
    if (["-b", "--binary", "-t", "--text", "--tag", "-z", "--zero", "--"].includes(arg)) continue;
    if (arg.startsWith("-")) return false;
    paths.push(arg);
  }
  return paths.every((value) => safeProjectPath(value, projectRoot, workingDirectory, true));
}

function cmpIsReadOnly(args: string[], projectRoot: string, workingDirectory: string): boolean {
  const paths: string[] = [];
  for (const arg of args) {
    if (["-s", "--silent", "--quiet", "-l", "--verbose", "--"].includes(arg)) continue;
    if (arg.startsWith("-")) return false;
    paths.push(arg);
  }
  return paths.length === 2
    && paths.every((value) => safeProjectPath(value, projectRoot, workingDirectory, true));
}

function ripgrepIsReadOnly(args: string[], projectRoot: string, workingDirectory: string): boolean {
  const positionals: string[] = [];
  let patternFromOption = false;
  let filesMode = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-e" || arg === "--regexp") {
      if (!args[index + 1]) return false;
      patternFromOption = true;
      index += 1;
      continue;
    }
    if (RG_OPTIONS_WITH_VALUE.has(arg)) {
      if (!args[index + 1]) return false;
      index += 1;
      continue;
    }
    if (RG_FLAGS.has(arg)) {
      filesMode ||= arg === "--files";
      continue;
    }
    if (arg.startsWith("-")) return false;
    positionals.push(arg);
  }
  if (filesMode) return positionals.every((value) => safeProjectPath(value, projectRoot, workingDirectory, false));
  if (!patternFromOption && positionals.length === 0) return false;
  const paths = patternFromOption ? positionals : positionals.slice(1);
  return paths.every((value) => safeProjectPath(value, projectRoot, workingDirectory, false));
}

function testIsReadOnly(args: string[], projectRoot: string, workingDirectory: string): boolean {
  const normalized = args[0] === "!" ? args.slice(1) : args;
  if (normalized.length === 2 && TEST_PATH_OPERATORS.has(normalized[0] ?? "")) {
    return safeProjectPath(normalized[1] ?? "", projectRoot, workingDirectory, false);
  }
  if (normalized.length === 3 && ["-ef", "-nt", "-ot"].includes(normalized[1] ?? "")) {
    return safeProjectPath(normalized[0] ?? "", projectRoot, workingDirectory, true)
      && safeProjectPath(normalized[2] ?? "", projectRoot, workingDirectory, true);
  }
  return false;
}

function safeProjectPath(
  value: string,
  projectRoot: string,
  workingDirectory: string,
  mustExist: boolean,
  allowGitPathspec = false,
): boolean {
  if (!value || value === "-" || value.startsWith("~") || value.includes("\0")) return false;
  if (!allowGitPathspec && /[*?[\]{}]/.test(value)) return false;
  try {
    const root = fs.realpathSync(path.resolve(projectRoot));
    const directory = fs.realpathSync(path.resolve(workingDirectory));
    if (!inside(directory, root)) return false;
    const target = path.resolve(directory, value);
    if (!inside(target, root)) return false;
    if (fs.existsSync(target)) return inside(fs.realpathSync(target), root);
    if (mustExist) return false;
    let parent = path.dirname(target);
    while (!fs.existsSync(parent)) {
      const next = path.dirname(parent);
      if (next === parent) return false;
      parent = next;
    }
    return inside(fs.realpathSync(parent), root);
  } catch {
    return false;
  }
}

function safeProjectDirectory(value: string, projectRoot: string): boolean {
  try {
    const root = fs.realpathSync(path.resolve(projectRoot));
    const directory = fs.realpathSync(path.resolve(value));
    return fs.statSync(directory).isDirectory() && inside(directory, root);
  } catch {
    return false;
  }
}

function inside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function splitReadOnlySegments(command: string): string[] | undefined {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (quote === '"' && (character === "$" || character === "`")) return undefined;
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (["$", "`", ">", "<", ";", "\n", "\r", "(", ")", "{", "}"].includes(character)) return undefined;
    if (character === "&" || character === "|") {
      const doubled = command[index + 1] === character;
      if (character === "&" && !doubled) return undefined;
      if (!current.trim()) return undefined;
      segments.push(current.trim());
      current = "";
      if (doubled) index += 1;
      continue;
    }
    current += character;
  }
  if (escaped || quote || !current.trim()) return undefined;
  segments.push(current.trim());
  return segments;
}

function shellTokens(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      tokenStarted = true;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      tokenStarted = true;
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) tokens.push(current);
      current = "";
      tokenStarted = false;
      continue;
    }
    current += character;
    tokenStarted = true;
  }
  if (escaped || quote) return undefined;
  if (tokenStarted) tokens.push(current);
  return tokens;
}

function denied(reason: string): ReadOnlyShellClassification {
  return { readOnly: false, reason };
}
