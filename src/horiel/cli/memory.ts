import { HorielError, type HorielCore } from "../core";

export interface HorielMemoryOptions {
  action: string;
  args: string[];
  all: boolean;
  confirm: string | undefined;
  dryRun: boolean;
  yes: boolean;
  apply?: boolean;
  approval?: string;
  subtree?: boolean;
  project?: string;
  type?: string;
  limit?: string;
}

export type HorielMemoryCliResult = string | string[] | { lines: string[] } | { output: string };

export interface HorielMemoryCli {
  (options: HorielMemoryOptions): Promise<HorielMemoryCliResult>;
  run(options: HorielMemoryOptions): Promise<HorielMemoryCliResult>;
  execute(options: HorielMemoryOptions): Promise<HorielMemoryCliResult>;
}

export function createHorielMemoryCli(input: { core: HorielCore }): HorielMemoryCli {
  if (!input?.core) throw new TypeError("Horiel memory CLI requires the Core facade.");
  const execute = async (options: HorielMemoryOptions): Promise<HorielMemoryCliResult> => {
    const action = options.action || "list";
    let result: unknown;
    switch (action) {
      case "list":
        assertArgs(options.args, 0, 0);
        result = await input.core.listTree();
        break;
      case "tree":
        assertArgs(options.args, 0, 1);
        result = await input.core.listTree(options.args[0] ? { prefix: options.args[0] } : {});
        break;
      case "search": {
        assertArgs(options.args, 1, Number.MAX_SAFE_INTEGER);
        const scope = required(options.project, "Search scope");
        const limit = parseLimit(options.limit);
        result = await input.core.searchMemory({
          scope,
          query: options.args.join(" ").trim(),
          rollup: options.subtree === true,
          ...(options.type ? { types: [options.type as never] } : {}),
          ...(limit ? { limit } : {}),
        });
        break;
      }
      case "get":
        assertArgs(options.args, 1, 1);
        result = await input.core.getMemory({ id: options.args[0]! });
        break;
      case "inspect":
        assertArgs(options.args, 1, 1);
        result = await input.core.inspectScope({ scope: options.args[0]! });
        break;
      case "backup":
        assertArgs(options.args, 0, 0);
        result = await input.core.createBackup();
        break;
      case "move-preview":
        assertArgs(options.args, 2, 2);
        result = await input.core.previewMove({ id: options.args[0]!, destinationScope: options.args[1]! });
        break;
      case "promote-preview":
        assertArgs(options.args, 2, 2);
        result = await input.core.previewPromote({ id: options.args[0]!, ancestor: options.args[1]! });
        break;
      case "delete-preview":
        assertArgs(options.args, 1, 1);
        result = await input.core.previewDeleteScope({ scope: options.args[0]! });
        break;
      case "restore-preview":
        assertArgs(options.args, 1, 1);
        result = await input.core.previewRestore({ snapshotId: options.args[0]! });
        break;
      default:
        throw new HorielError("invalid_input", "Horiel memory CLI action is not supported.");
    }
    return formatCliResult(action, result);
  };
  return Object.assign(execute, { run: execute, execute });
}

function formatCliResult(action: string, result: unknown): string {
  const lines = [`Horiel memory ${action}: completed`];
  if ((action === "list" || action === "tree") && isRecord(result) && Array.isArray(result.nodes)) {
    for (const node of result.nodes) {
      if (!isRecord(node) || typeof node.scope !== "string" || !safeScope(node.scope)) continue;
      lines.push(`- ${node.scope}`);
    }
  }
  return lines.join("\n").slice(0, 4_096);
}

function safeScope(value: string): boolean {
  return value === "@global" || (value.length <= 512
    && !value.startsWith("/")
    && !/[\\\0-\x1f\x7f]/.test(value)
    && !/(?:secret|password|token|select\s|insert\s|update\s|delete\s)/i.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertArgs(args: string[], minimum: number, maximum: number): void {
  if (!Array.isArray(args) || args.length < minimum || args.length > maximum) {
    throw new HorielError("invalid_input", "Horiel memory CLI arguments are invalid.");
  }
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new HorielError("invalid_input", `${label} is required.`);
  return value.trim();
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new HorielError("invalid_input", "Horiel memory CLI limit is invalid.");
  }
  return parsed;
}
