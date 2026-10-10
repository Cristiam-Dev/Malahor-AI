import { toolDefinitions } from "./tool-definitions";
import { getObservation, listProjects, saveObservation, saveSessionSummary, searchObservations, type ObservationType } from "./db";
import { contextForProject, memoryBrief } from "./context";
import { deleteProjectMemory, inspectProjectMemory, moveMemory, previewMemoryMove, previewProjectDeletion } from "./admin";
import { backupMemory, previewMemoryRestore, restoreMemoryBackup } from "./admin-backup";

export { toolDefinitions };

export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}


export function callTool(call: ToolCall): unknown {
  const args = call.arguments ?? {};

  switch (call.name) {
    case "mem_save":
      return saveObservation({
        project: stringArg(args.project, "global"),
        type: observationTypeArg(args.type),
        title: stringArg(args.title),
        content: stringArg(args.content),
        tags: stringArg(args.tags, ""),
      });
    case "mem_search":
      return searchObservations(stringArg(args.query, ""), stringArg(args.project, ""), stringArg(args.type, ""), numberArg(args.limit, 5));
    case "mem_get":
      return getObservation(numberArg(args.id, 0));
    case "mem_context":
      return contextForProject(stringArg(args.project), numberArg(args.limit, 8));
    case "mem_brief":
      return memoryBrief(stringArg(args.request), {
        project: optionalStringArg(args.project),
        scope: optionalStringArg(args.scope),
        limit: numberArg(args.limit, 8),
        relatedLimit: numberArg(args.relatedLimit, 5),
      });
    case "mem_session_summary":
      return saveSessionSummary(stringArg(args.project), stringArg(args.summary));
    case "mem_list_projects":
      return listProjects();
    case "mem_delete_project_preview":
      return previewProjectDeletion(stringArg(args.project));
    case "mem_delete_project":
      return deleteProjectMemory(stringArg(args.project), stringArg(args.confirm));
    case "mem_backup":
      return backupMemory();
    case "mem_restore_preview":
      return previewMemoryRestore(stringArg(args.backup));
    case "mem_restore":
      return restoreMemoryBackup(stringArg(args.backup), stringArg(args.confirm));
    case "mem_inspect_project":
      return inspectProjectMemory(stringArg(args.project));
    case "mem_move_preview":
      return previewMemoryMove(numberArg(args.id, 0), stringArg(args.targetProject));
    case "mem_move":
      return moveMemory(numberArg(args.id, 0), stringArg(args.targetProject), stringArg(args.confirm));
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

function stringArg(value: unknown, fallback?: string): string {
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error("Expected string argument");
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function observationTypeArg(value: unknown): ObservationType {
  const allowed: ObservationType[] = ["decision", "bug", "pattern", "architecture", "learning", "general"];
  return allowed.includes(value as ObservationType) ? (value as ObservationType) : "general";
}
