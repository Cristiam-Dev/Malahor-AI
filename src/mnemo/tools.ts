import { toolDefinitions } from "./tool-definitions";
import { auditHookResult, runHooks } from "../cli/core/hooks/engine";
import { loadHookPolicy, parseHookProfile } from "../cli/core/hooks/policy-loader";
import type { HookEvent } from "../cli/core/hooks/types";
import { resolvePaths } from "../cli/core/paths";
import { resolveProject } from "../cli/core/project";
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
    case "malahor_hook_check":
      return checkMalahorHooks(args);
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

function checkMalahorHooks(args: Record<string, unknown>): unknown {
  const paths = resolvePaths();
  const project = resolveProject(paths.cwd);
  const profileOverride = typeof args.profile === "string" && args.profile.trim() ? parseHookProfile(args.profile) : undefined;
  const policyLoad = loadHookPolicy(paths, project.canonicalKey, profileOverride);
  const context = {
    event: hookEventArg(args.event),
    harness: "mcp" as const,
    profile: policyLoad.policy.profile,
    cwd: paths.cwd,
    projectRoot: project.root,
    malahorHome: paths.malahorHome,
    project: project.canonicalKey,
    policy: policyLoad.policy,
    security: policyLoad.security,
    policyMeta: policyLoad.policyMeta,
    command: optionalStringArg(args.command),
    targetPaths: stringListArg(args.paths),
    confirmation: optionalStringArg(args.confirm),
    metadata: recordArg(args.metadata),
  };
  return auditHookResult(context, runHooks(context));
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

function hookEventArg(value: unknown): HookEvent {
  if (typeof value === "string" && value.trim()) return value as HookEvent;
  throw new Error("Expected hook event string");
}

function stringListArg(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function recordArg(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
