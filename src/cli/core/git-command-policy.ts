import { execFileSync } from "node:child_process";

export type GitOperation =
  | "stage"
  | "implicit-stage"
  | "commit"
  | "amend"
  | "reset"
  | "rebase"
  | "cherry-pick"
  | "merge"
  | "branch-create"
  | "branch-switch"
  | "branch-delete"
  | "discard"
  | "clean"
  | "remote"
  | "read"
  | "unknown";

export interface GitCommandPolicyOptions {
  aliases?: Readonly<Record<string, string>>;
  maxAliasDepth?: number;
}

export interface GitCommandClassification {
  hasGitCommand: boolean;
  remote: boolean;
  failClosed: boolean;
  operations: GitOperation[];
  destructive: boolean;
  targets: string[];
  remoteReasons: string[];
}

interface InvocationClassification {
  remote: boolean;
  failClosed: boolean;
  operations: GitOperation[];
  destructive: boolean;
  targets: string[];
  remoteReasons: string[];
}

const REMOTE_COMMANDS = new Set([
  "clone", "fetch", "fetch-pack", "http-fetch", "http-push", "ls-remote",
  "pull", "push", "remote-ext", "remote-fd", "remote-ftp", "remote-ftps",
  "remote-http", "remote-https", "send-pack",
]);

const READ_COMMANDS = new Set([
  "annotate", "blame", "cat-file", "count-objects", "describe", "diff",
  "diff-files", "diff-index", "diff-tree", "difftool", "for-each-ref",
  "fsck", "grep", "help", "log", "merge-base", "name-rev", "notes",
  "range-diff", "reflog", "rev-list", "rev-parse", "shortlog", "show",
  "show-branch", "show-ref", "status", "tag", "verify-commit", "verify-tag",
  "version", "whatchanged",
]);

const KNOWN_LOCAL_COMMANDS = new Set([
  ...READ_COMMANDS,
  "add", "am", "apply", "archive", "bisect", "branch", "bundle", "checkout",
  "cherry", "cherry-pick", "clean", "commit", "commit-tree", "config",
  "fast-export", "fast-import", "filter-branch", "format-patch", "gc", "hash-object",
  "index-pack", "init", "interpret-trailers", "maintenance", "merge", "merge-file",
  "merge-index", "merge-tree", "mergetool", "mktag", "mktree", "mv", "pack-objects",
  "prune", "prune-packed", "read-tree", "rebase", "replace", "reset", "restore",
  "revert", "rm", "show-index", "sparse-checkout", "stash", "stripspace", "submodule",
  "switch", "symbolic-ref", "unpack-file", "unpack-objects", "update-index", "update-ref",
  "var", "worktree", "write-tree",
]);

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C", "-c", "--config-env", "--exec-path", "--git-dir", "--namespace",
  "--super-prefix", "--work-tree",
]);

const POSIX_SHELL_EXECUTORS = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const WINDOWS_SHELL_EXECUTORS = new Set(["cmd", "cmd.exe"]);
const POWERSHELL_EXECUTORS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);

export function classifyGitCommand(
  command: string,
  options: GitCommandPolicyOptions = {},
): GitCommandClassification {
  const combined: GitCommandClassification = {
    hasGitCommand: false,
    remote: false,
    failClosed: false,
    operations: [],
    destructive: false,
    targets: [],
    remoteReasons: [],
  };

  for (const nestedCommand of commandSubstitutions(command)) {
    const nested = classifyGitCommand(nestedCommand, options);
    if (nested.hasGitCommand) nested.failClosed = true;
    mergeClassification(combined, nested);
  }

  for (const segment of splitShellSegments(command)) {
    const tokens = shellTokens(segment);
    const executableIndexes = shellExecutableIndexes(tokens);
    classifyNestedShell(tokens, executableIndexes, options, combined);

    for (const index of executableIndexes) {
      const executable = tokens[index] ?? "";
      const remoteHelper = remoteGitExecutableReason(executable);
      if (remoteHelper) {
        combined.hasGitCommand = true;
        mergeClassification(combined, remote(remoteHelper));
        continue;
      }
      if (!isGitExecutable(executable)) continue;
      combined.hasGitCommand = true;
      mergeClassification(combined, classifyInvocation(tokens, index, options, [], 0));
    }
  }

  return combined;
}

export function loadGitAliases(cwd: string): Record<string, string> {
  try {
    const output = execFileSync("git", ["config", "--get-regexp", "^alias\\."], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const aliases: Record<string, string> = {};
    for (const line of output.split("\n")) {
      const match = /^alias\.([^\s]+)\s+([\s\S]+)$/.exec(line.trim());
      if (match?.[1] && match[2] !== undefined) aliases[match[1]] = match[2];
    }
    return aliases;
  } catch {
    return {};
  }
}

function classifyNestedShell(
  tokens: string[],
  executableIndexes: number[],
  options: GitCommandPolicyOptions,
  combined: GitCommandClassification,
): void {
  for (const index of executableIndexes) {
    const executable = executableName(tokens[index] ?? "");
    let commandIndex = -1;
    if (POSIX_SHELL_EXECUTORS.has(executable)) {
      commandIndex = tokens.findIndex((token, candidate) => (
        candidate > index && (token === "--command" || /^-[^-]*c[^-]*$/.test(token))
      ));
    } else if (WINDOWS_SHELL_EXECUTORS.has(executable)) {
      commandIndex = tokens.findIndex((token, candidate) => (
        candidate > index && ["/c", "/k"].includes(token.toLowerCase())
      ));
    } else if (POWERSHELL_EXECUTORS.has(executable)) {
      commandIndex = tokens.findIndex((token, candidate) => (
        candidate > index && ["-c", "-command", "-encodedcommand"].includes(token.toLowerCase())
      ));
    }
    const nested = commandIndex >= 0 ? tokens[commandIndex + 1] : undefined;
    if (nested) mergeClassification(combined, classifyGitCommand(nested, options));
  }
}

function classifyInvocation(
  tokens: string[],
  gitIndex: number,
  options: GitCommandPolicyOptions,
  aliasStack: string[],
  depth: number,
): InvocationClassification {
  const inlineAliases: Record<string, string> = {};
  let index = gitIndex + 1;

  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;

    if (token === "-c") {
      const value = tokens[index + 1] ?? "";
      recordInlineAlias(value, inlineAliases);
      index += 2;
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      recordInlineAlias(token.slice(2), inlineAliases);
      index += 1;
      continue;
    }
    if (GLOBAL_OPTIONS_WITH_VALUE.has(token) && token !== "-c") {
      index += 2;
      continue;
    }
    index += 1;
  }

  const subcommand = tokens[index]?.toLowerCase();
  if (!subcommand) return local(["unknown"], false, [], false);
  const args = tokens.slice(index + 1);
  const aliases = { ...(options.aliases ?? {}), ...inlineAliases };
  const alias = aliases[subcommand];
  const maxDepth = options.maxAliasDepth ?? 8;

  if (alias !== undefined && !KNOWN_LOCAL_COMMANDS.has(subcommand) && !REMOTE_COMMANDS.has(subcommand)) {
    if (aliasStack.includes(subcommand) || depth >= maxDepth) {
      return remote("alias-recursivo-o-profundo", true);
    }
    if (alias.trimStart().startsWith("!")) {
      return remote(`alias-shell:${subcommand}`, true);
    }
    const expanded = shellTokens(`git ${alias} ${args.join(" ")}`);
    return classifyInvocation(expanded, 0, options, [...aliasStack, subcommand], depth + 1);
  }

  if (REMOTE_COMMANDS.has(subcommand)) return remote(`git-${subcommand}`);
  if (subcommand === "archive" && args.some((arg) => arg === "--remote" || arg.startsWith("--remote="))) {
    return remote("git-archive-remote");
  }
  if (subcommand === "remote") return classifyRemoteCommand(args);
  if (subcommand === "submodule") return classifySubmoduleCommand(args);
  if (subcommand === "svn" || subcommand === "p4") return remote(`git-${subcommand}`, true);

  switch (subcommand) {
    case "add":
      return local(["stage"], false, pathArguments(args));
    case "commit":
      return classifyCommit(args);
    case "reset":
      return local(["reset"], true, targetArguments(args, ["--pathspec-from-file"]));
    case "rebase":
      return local(["rebase"], true, targetArguments(args, ["--onto", "--exec", "-x"]));
    case "cherry-pick":
      return local(["cherry-pick"], args.some(isConflictStateFlag), targetArguments(args));
    case "merge":
      return local(["merge"], args.some(isConflictStateFlag), targetArguments(args, ["-m", "--message", "-S", "--gpg-sign"]));
    case "branch":
      return classifyBranch(args);
    case "switch":
      return classifySwitch(args);
    case "checkout":
      return classifyCheckout(args);
    case "clean":
      return local(["clean"], true, pathArguments(args));
    case "restore":
      return local(["discard"], true, pathArguments(args));
    case "tag":
      return classifyTagCommand(args);
    case "notes":
      return classifyNotesCommand(args);
    case "reflog":
      return classifyReflogCommand(args);
    default:
      if (READ_COMMANDS.has(subcommand)) return local(["read"], false, []);
      if (KNOWN_LOCAL_COMMANDS.has(subcommand)) return unsupportedLocalMutation(args);
      return remote(`comando-o-alias-no-resuelto:${subcommand}`, true);
  }
}

function classifyRemoteCommand(args: string[]): InvocationClassification {
  const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  if (!subcommand) return local(["read"], false, []);
  if (["update", "prune"].includes(subcommand)) return remote(`git-remote-${subcommand}`);
  if (subcommand === "show" && !args.includes("-n") && !args.includes("--no-query")) {
    return remote("git-remote-show");
  }
  if (subcommand === "set-head" && (args.includes("-a") || args.includes("--auto"))) {
    return remote("git-remote-set-head-auto");
  }
  if (["add", "remove", "rename", "set-branches", "set-head", "set-url"].includes(subcommand)) {
    return unsupportedLocalMutation(args);
  }
  return local(["read"], false, targetArguments(args));
}

function classifySubmoduleCommand(args: string[]): InvocationClassification {
  const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  if (["add", "update", "foreach"].includes(subcommand ?? "")) {
    return remote(`git-submodule-${subcommand}`, true);
  }
  if (["absorbgitdirs", "deinit", "init", "set-branch", "set-url", "sync"].includes(subcommand ?? "")) {
    return unsupportedLocalMutation(args);
  }
  return local(["read"], false, targetArguments(args));
}

function classifyTagCommand(args: string[]): InvocationClassification {
  const mutatingFlag = args.some((arg) => (
    arg === "-d"
    || arg === "--delete"
    || arg === "-f"
    || arg === "--force"
    || arg === "-a"
    || arg === "--annotate"
    || arg === "-s"
    || arg === "--sign"
    || arg === "-u"
    || arg === "--local-user"
    || arg === "--create-reflog"
    || arg.startsWith("--local-user=")
  ));
  const readMode = args.some((arg) => (
    arg === "-l"
    || arg === "--list"
    || arg === "-v"
    || arg === "--verify"
    || arg.startsWith("--contains")
    || arg.startsWith("--no-contains")
    || arg.startsWith("--points-at")
    || arg.startsWith("--merged")
    || arg.startsWith("--no-merged")
  ));
  const positionals = targetArguments(args, [
    "-m", "--message", "-F", "--file", "-u", "--local-user", "--format", "--sort",
    "--color", "--column", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged",
  ]);
  if (mutatingFlag || (!readMode && positionals.length > 0)) return unsupportedLocalMutation(args);
  return local(["read"], false, []);
}

function classifyNotesCommand(args: string[]): InvocationClassification {
  if (args.some((arg) => ["add", "append", "copy", "edit", "merge", "prune", "remove"].includes(arg.toLowerCase()))) {
    return unsupportedLocalMutation(args);
  }
  return local(["read"], false, []);
}

function classifyReflogCommand(args: string[]): InvocationClassification {
  if (args.some((arg) => ["delete", "expire", "write"].includes(arg.toLowerCase()))) {
    return unsupportedLocalMutation(args);
  }
  return local(["read"], false, []);
}

function unsupportedLocalMutation(args: string[]): InvocationClassification {
  return local(["unknown"], true, targetArguments(args), true);
}

function classifyBranch(args: string[]): InvocationClassification {
  if (args.some((arg) => arg === "--delete" || arg.startsWith("--delete="))
    || hasShortOption(args, "d") || hasShortOption(args, "D")) {
    return local(["branch-delete"], true, [
      ...targetArguments(args),
      ...attachedOptionValues(args, ["d", "D"], ["delete"]),
    ]);
  }
  const targets = [...new Set([
    ...targetArguments(args, ["-m", "-M", "--move", "-c", "-C", "--copy"]),
    ...attachedOptionValues(args, ["m", "M", "c", "C"], ["move", "copy"]),
  ])];
  const destructive = hasShortOption(args, "f") || hasShortOption(args, "M")
    || hasShortOption(args, "C") || args.includes("--force");
  return targets.length > 0 ? local(["branch-create"], destructive, targets) : local(["read"], false, []);
}

function classifySwitch(args: string[]): InvocationClassification {
  const create = hasShortOption(args, "c") || hasShortOption(args, "C")
    || args.some((arg) => arg === "--create" || arg.startsWith("--create=") || arg === "--force-create" || arg.startsWith("--force-create="));
  const destructive = hasShortOption(args, "C") || hasShortOption(args, "f")
    || args.some((arg) => ["--force", "--force-create", "--discard-changes"].includes(arg) || arg.startsWith("--force-create="));
  const targets = [...new Set([
    ...targetArguments(args, ["-c", "-C", "--create", "--force-create"]),
    ...attachedOptionValues(args, ["c", "C"], ["create", "force-create"]),
  ])];
  return local(create ? ["branch-create", "branch-switch"] : ["branch-switch"], destructive, targets);
}

function classifyCheckout(args: string[]): InvocationClassification {
  const create = hasShortOption(args, "b") || hasShortOption(args, "B") || args.some((arg) => arg === "--orphan" || arg.startsWith("--orphan="));
  const discard = args.includes("--") || args.some((arg) => arg === "." || arg === "--patch") || hasShortOption(args, "p");
  if (discard) return local(["discard"], true, pathArguments(args));
  const destructive = hasShortOption(args, "B") || hasShortOption(args, "f") || args.includes("--force");
  const targets = [...new Set([
    ...targetArguments(args, ["-b", "-B", "--orphan"]),
    ...attachedOptionValues(args, ["b", "B"], ["orphan"]),
  ])];
  return local(create ? ["branch-create", "branch-switch"] : ["branch-switch"], destructive, targets);
}

const COMMIT_IMPLICIT_LONG_OPTIONS = new Set([
  "--all", "--include", "--interactive", "--only", "--patch", "--pathspec-from-file",
]);
const COMMIT_IMPLICIT_SHORT_OPTIONS = new Set(["a", "i", "o", "p"]);
const COMMIT_LONG_OPTIONS_WITH_VALUE = new Set([
  "--message", "--file", "--reuse-message", "--reedit-message", "--template",
  "--author", "--date", "--cleanup", "--fixup", "--squash", "--trailer",
  "--pathspec-from-file",
]);
const COMMIT_SHORT_OPTIONS_WITH_VALUE = new Set(["m", "F", "C", "c", "t"]);
const COMMIT_SHORT_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUE = new Set(["S", "u"]);

function classifyCommit(args: string[]): InvocationClassification {
  const amend = args.includes("--amend");
  const parsed = parseCommitArguments(args);
  const operations: GitOperation[] = [
    ...(parsed.implicitStage ? ["implicit-stage" as const] : []),
    amend ? "amend" : "commit",
  ];
  return local(operations, amend, amend ? ["HEAD", ...parsed.targets] : parsed.targets);
}

function parseCommitArguments(args: string[]): { implicitStage: boolean; targets: string[] } {
  let implicitStage = false;
  const targets: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      targets.push(...args.slice(index + 1));
      implicitStage ||= targets.length > 0;
      break;
    }

    if (COMMIT_IMPLICIT_LONG_OPTIONS.has(arg)
      || [...COMMIT_IMPLICIT_LONG_OPTIONS].some((option) => arg.startsWith(`${option}=`))) {
      implicitStage = true;
    }

    if (COMMIT_LONG_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if ([...COMMIT_LONG_OPTIONS_WITH_VALUE].some((option) => arg.startsWith(`${option}=`))) continue;

    if (/^-[^-]/.test(arg)) {
      const short = parseCommitShortOptions(arg);
      implicitStage ||= short.implicitStage;
      if (short.consumesNext) index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;

    targets.push(arg);
    implicitStage = true;
  }

  return { implicitStage, targets };
}

function parseCommitShortOptions(arg: string): { implicitStage: boolean; consumesNext: boolean } {
  let implicitStage = false;
  for (let index = 1; index < arg.length; index += 1) {
    const option = arg[index] ?? "";
    if (COMMIT_IMPLICIT_SHORT_OPTIONS.has(option)) implicitStage = true;
    if (COMMIT_SHORT_OPTIONS_WITH_VALUE.has(option)) {
      return { implicitStage, consumesNext: index === arg.length - 1 };
    }
    if (COMMIT_SHORT_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUE.has(option)) {
      return { implicitStage, consumesNext: false };
    }
  }
  return { implicitStage, consumesNext: false };
}

function targetArguments(args: string[], valueFlags: string[] = []): string[] {
  const values: string[] = [];
  const consumes = new Set(valueFlags);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      values.push(...args.slice(index + 1));
      break;
    }
    if (consumes.has(arg)) {
      index += 1;
      const value = args[index];
      if (value) values.push(value);
      continue;
    }
    if (!arg.startsWith("-")) values.push(arg);
  }
  return values;
}

function hasShortOption(args: string[], option: string): boolean {
  return args.some((arg) => /^-[^-]/.test(arg) && arg.slice(1).includes(option));
}

function attachedOptionValues(args: string[], short: string[], long: string[]): string[] {
  const values: string[] = [];
  for (const arg of args) {
    if (/^-[^-]/.test(arg)) {
      for (const option of short) {
        const index = arg.indexOf(option, 1);
        if (index >= 1 && index < arg.length - 1) {
          values.push(arg.slice(index + 1));
          break;
        }
      }
    }
    for (const option of long) {
      const prefix = `--${option}=`;
      if (arg.startsWith(prefix) && arg.length > prefix.length) values.push(arg.slice(prefix.length));
    }
  }
  return values;
}

function pathArguments(args: string[]): string[] {
  const separator = args.indexOf("--");
  if (separator >= 0) return args.slice(separator + 1);
  return args.filter((arg) => !arg.startsWith("-"));
}

function isConflictStateFlag(value: string): boolean {
  return ["--abort", "--continue", "--quit", "--skip"].includes(value);
}

function local(
  operations: GitOperation[],
  destructive: boolean,
  targets: string[],
  failClosed = false,
): InvocationClassification {
  return { remote: false, failClosed, operations, destructive, targets, remoteReasons: [] };
}

function remote(reason: string, failClosed = false): InvocationClassification {
  return {
    remote: true,
    failClosed,
    operations: ["remote"],
    destructive: false,
    targets: [],
    remoteReasons: [reason],
  };
}

function mergeClassification(
  combined: GitCommandClassification,
  current: InvocationClassification | GitCommandClassification,
): void {
  if ("hasGitCommand" in current && current.hasGitCommand) combined.hasGitCommand = true;
  combined.remote ||= current.remote;
  combined.failClosed ||= current.failClosed;
  combined.destructive ||= current.destructive;
  appendUnique(combined.operations, current.operations);
  appendUnique(combined.targets, current.targets);
  appendUnique(combined.remoteReasons, current.remoteReasons);
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function recordInlineAlias(value: string, aliases: Record<string, string>): void {
  const match = /^alias\.([^=]+)=([\s\S]*)$/i.exec(value);
  if (match?.[1] && match[2] !== undefined) aliases[match[1].toLowerCase()] = match[2];
}

function isGitExecutable(value: string): boolean {
  const executable = executableName(value);
  return executable === "git" || executable === "git.exe";
}

function remoteGitExecutableReason(value: string): string | undefined {
  const executable = executableName(value).replace(/\.exe$/, "");
  if (/^git-remote-.+/.test(executable)) return `helper-${executable}`;
  if (["git-fetch-pack", "git-http-fetch", "git-http-push", "git-ls-remote", "git-send-pack"].includes(executable)) {
    return `helper-${executable}`;
  }
  return undefined;
}

function executableName(value: string): string {
  return value.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function shellExecutableIndexes(tokens: string[]): number[] {
  const indexes = new Set<number>();
  const primary = unwrapCommandIndex(tokens, 0);
  if (primary >= 0) indexes.add(primary);

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "-exec" && tokens[index] !== "-execdir") continue;
    const nested = unwrapCommandIndex(tokens, index + 1);
    if (nested >= 0) indexes.add(nested);
  }

  return [...indexes].sort((left, right) => left - right);
}

function unwrapCommandIndex(tokens: string[], start: number): number {
  let index = skipCommandAssignments(tokens, start);
  const visited = new Set<number>();

  while (index >= 0 && index < tokens.length && !visited.has(index)) {
    visited.add(index);
    const executable = executableName(tokens[index] ?? "");
    const nested = wrappedCommandIndex(executable, tokens, index);
    if (nested === undefined) return index;
    if (nested < 0) return -1;
    index = skipCommandAssignments(tokens, nested);
  }

  return -1;
}

function wrappedCommandIndex(executable: string, tokens: string[], index: number): number | undefined {
  switch (executable) {
    case "env":
      return firstWrapperOperand(tokens, index + 1, new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]), true);
    case "command":
      return commandBuiltinTarget(tokens, index + 1);
    case "exec":
      return firstWrapperOperand(tokens, index + 1, new Set(["-a"]));
    case "nohup":
      return firstWrapperOperand(tokens, index + 1, new Set());
    case "sudo":
    case "sudo.exe":
      return firstWrapperOperand(tokens, index + 1, new Set([
        "-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host",
        "-p", "--prompt", "-R", "--chroot", "-r", "--role", "-T", "--command-timeout",
        "-t", "--type", "-U", "--other-user", "-u", "--user",
      ]));
    case "xargs":
      return firstWrapperOperand(tokens, index + 1, new Set([
        "-a", "--arg-file", "-d", "--delimiter", "-E", "-e", "--eof", "-I", "--replace",
        "-L", "-l", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars",
      ]));
    case "timeout": {
      const duration = firstWrapperOperand(tokens, index + 1, new Set(["-k", "--kill-after", "-s", "--signal"]));
      return duration >= 0 ? duration + 1 : -1;
    }
    default:
      return undefined;
  }
}

function commandBuiltinTarget(tokens: string[], start: number): number {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return index + 1 < tokens.length ? index + 1 : -1;
    if (token === "-v" || token === "-V") return -1;
    if (token === "-p") continue;
    return index;
  }
  return -1;
}

function firstWrapperOperand(
  tokens: string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
  skipAssignments = false,
): number {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return index + 1 < tokens.length ? index + 1 : -1;
    if (skipAssignments && isEnvironmentAssignment(token)) continue;
    if (!token.startsWith("-") || token === "-") return index;
    if (optionsWithValue.has(token)) index += 1;
  }
  return -1;
}

function skipCommandAssignments(tokens: string[], start: number): number {
  let index = start;
  while (index < tokens.length && isEnvironmentAssignment(tokens[index] ?? "")) index += 1;
  return index;
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function commandSubstitutions(command: string): string[] {
  const substitutions: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === "'" && quote === undefined) {
      quote = "'";
      continue;
    }
    if (character === '"') {
      if (quote === '"') quote = undefined;
      else if (quote === undefined) quote = '"';
      continue;
    }
    if (character === "$" && command[index + 1] === "(") {
      const nested = readParenthesizedSubstitution(command, index + 2);
      if (nested) {
        substitutions.push(nested.command);
        index = nested.end;
      }
      continue;
    }
    if (character === "`") {
      const nested = readBacktickSubstitution(command, index + 1);
      if (nested) {
        substitutions.push(nested.command);
        index = nested.end;
      }
    }
  }

  return substitutions;
}

function readParenthesizedSubstitution(
  source: string,
  start: number,
): { command: string; end: number } | undefined {
  let depth = 1;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character !== ")") continue;
    depth -= 1;
    if (depth === 0) return { command: source.slice(start, index), end: index };
  }
  return undefined;
}

function readBacktickSubstitution(
  source: string,
  start: number,
): { command: string; end: number } | undefined {
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "`") return { command: source.slice(start, index), end: index };
  }
  return undefined;
}

function splitShellSegments(command: string): string[] {
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
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "\n" || character === ";" || character === "|" || character === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((character === "|" || character === "&") && command[index + 1] === character) index += 1;
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}
