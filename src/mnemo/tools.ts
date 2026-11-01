import { toolDefinitions } from "./tool-definitions";
import { resolveRegisteredProject } from "../cli/core/context";
import { assertHooksAllowed, auditHookResult, runHooks } from "../cli/core/hooks/engine";
import { loadHookPolicy, parseHookProfile } from "../cli/core/hooks/policy-loader";
import { usesFilesystemResources } from "../cli/core/hooks/resources";
import { HOOK_RESOURCE_KINDS, type HookEvent, type HookResourceKind } from "../cli/core/hooks/types";
import { resolvePaths } from "../cli/core/paths";
import { parseGitIntent } from "../cli/core/git-intent";
import { getObservation, listProjects, normalizeProject, saveObservation, saveSessionSummary, searchObservations, type Observation, type ObservationType } from "./db";
import { contextForProject, memoryBrief } from "./context";
import { deleteProjectMemory, inspectProjectMemory, moveMemory, previewMemoryMove, previewProjectDeletion } from "./admin";
import { backupMemory, previewMemoryRestore, restoreMemoryBackup } from "./admin-backup";
import { memoryTree, pinMemory, promoteMemory, previewMemoryPromotion, unpinMemory } from "./v2-tools";
import { memoryRuntimeIdentity, type MemoryRuntimeIdentity } from "./hook-context";

export { toolDefinitions };

export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}


export function callTool(call: ToolCall): unknown {
  const args = call.arguments ?? {};
  const identity = call.name.startsWith("mem_") ? memoryRuntimeIdentity() : undefined;

  switch (call.name) {
    case "mem_save": {
      const project = authorizedScope(identity, stringArg(args.project, identity?.project ?? "global"));
      return saveObservation({
        project,
        type: observationTypeArg(args.type),
        title: stringArg(args.title),
        content: stringArg(args.content),
        tags: stringArg(args.tags, ""),
      });
    }
    case "mem_search": {
      const requested = stringArg(args.project, "");
      const project = identity ? authorizedScope(identity, requested || identity.project) : requested;
      const result = searchObservations(stringArg(args.query, ""), project, stringArg(args.type, ""),
        numberArg(args.limit, 5), booleanArg(args.subtree) || Boolean(identity && !requested));
      return filterObservations(result, identity);
    }
    case "mem_get": {
      const result = getObservation(numberArg(args.id, 0));
      assertAuthorizedObservation(identity, result);
      return result;
    }
    case "mem_context": {
      const project = authorizedScope(identity, stringArg(args.project));
      const result = contextForProject(project, numberArg(args.limit, 8), undefined, {
        budget: optionalNumberArg(args.budget), rollup: booleanArg(args.rollup),
      });
      return filterMemoryContext(result, identity);
    }
    case "mem_brief": {
      const requestedProject = optionalStringArg(args.project);
      const requestedScope = optionalStringArg(args.scope);
      const project = identity
        ? authorizedScope(identity, requestedProject ?? identity.project)
        : requestedProject;
      const scope = requestedScope ? authorizedScope(identity, requestedScope) : undefined;
      const result = memoryBrief(stringArg(args.request), {
        project,
        scope,
        limit: numberArg(args.limit, 8),
        relatedLimit: numberArg(args.relatedLimit, 5),
        budget: optionalNumberArg(args.budget),
      });
      return filterMemoryBrief(result, identity);
    }
    case "mem_session_summary": {
      const project = authorizedScope(identity, stringArg(args.project));
      return saveSessionSummary(project, stringArg(args.summary));
    }
    case "mem_list_projects":
      return listProjects().filter((entry) => isAuthorizedScope(identity, entry.project));
    case "mem_tree": {
      const requested = stringArg(args.prefix, "");
      const prefix = identity ? authorizedScope(identity, requested || identity.project) : requested;
      return memoryTree(prefix).filter((entry) => isAuthorizedScope(identity, entry.path));
    }
    case "mem_pin": {
      const id = numberArg(args.id, 0);
      assertAuthorizedObservation(identity, getObservation(id));
      return pinMemory(id);
    }
    case "mem_unpin": {
      const id = numberArg(args.id, 0);
      assertAuthorizedObservation(identity, getObservation(id));
      return unpinMemory(id);
    }
    case "mem_promote_preview": {
      const id = numberArg(args.id, 0);
      assertAuthorizedObservation(identity, getObservation(id));
      return previewMemoryPromotion(id, authorizedScope(identity, stringArg(args.ancestor)));
    }
    case "mem_promote": {
      const id = numberArg(args.id, 0);
      assertAuthorizedObservation(identity, getObservation(id));
      return promoteMemory(id, authorizedScope(identity, stringArg(args.ancestor)), stringArg(args.confirm));
    }
    case "mem_delete_project_preview":
      return previewProjectDeletion(authorizedScope(identity, stringArg(args.project)));
    case "mem_delete_project":
      return deleteProjectMemory(authorizedScope(identity, stringArg(args.project)), stringArg(args.confirm));
    case "mem_backup":
      assertUnboundAdministration(identity);
      return backupMemory();
    case "mem_restore_preview":
      assertUnboundAdministration(identity);
      return previewMemoryRestore(stringArg(args.backup));
    case "mem_restore":
      assertUnboundAdministration(identity);
      return restoreMemoryBackup(stringArg(args.backup), stringArg(args.confirm));
    case "mem_inspect_project":
      return inspectProjectMemory(authorizedScope(identity, stringArg(args.project)));
    case "mem_move_preview": {
      const id = numberArg(args.id, 0);
      assertAuthorizedObservation(identity, getObservation(id));
      return previewMemoryMove(id, authorizedScope(identity, stringArg(args.targetProject)));
    }
    case "mem_move": {
      const id = numberArg(args.id, 0);
      assertAuthorizedObservation(identity, getObservation(id));
      return moveMemory(id, authorizedScope(identity, stringArg(args.targetProject)), stringArg(args.confirm));
    }
    case "malahor_hook_check":
      return checkMalahorHooks(args);
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

function authorizedScope(identity: MemoryRuntimeIdentity | undefined, value: string): string {
  if (!identity) return value;
  if (!value.trim()) throw memoryAccessDenied();

  const owner = normalizeProject(identity.project);
  const scope = normalizeProject(value);
  if (scope === "global" || (scope !== owner && !scope.startsWith(`${owner}/`))) {
    throw memoryAccessDenied();
  }
  return scope;
}

function isAuthorizedScope(identity: MemoryRuntimeIdentity | undefined, value: string): boolean {
  if (!identity) return true;
  const owner = normalizeProject(identity.project);
  const scope = normalizeProject(value);
  return scope !== "global" && (scope === owner || scope.startsWith(`${owner}/`));
}

function assertAuthorizedObservation(identity: MemoryRuntimeIdentity | undefined, observation: Observation | null): void {
  if (observation && !isAuthorizedScope(identity, observation.project)) throw memoryAccessDenied();
}

function filterObservations(observations: Observation[], identity: MemoryRuntimeIdentity | undefined): Observation[] {
  return observations.filter((observation) => isAuthorizedScope(identity, observation.project));
}

function filterMemoryContext(
  context: ReturnType<typeof contextForProject>,
  identity: MemoryRuntimeIdentity | undefined,
): ReturnType<typeof contextForProject> {
  if (!identity) return context;
  const observations = filterObservations(context.observations, identity);
  const latestSession = context.latestSession && isAuthorizedScope(identity, context.latestSession.project)
    ? context.latestSession : null;
  const omittedPinnedIds = context.omittedPinnedIds.filter((id) => {
    const observation = getObservation(id);
    return Boolean(observation && isAuthorizedScope(identity, observation.project));
  });
  const budgetUsed = observations.reduce((total, observation) => total + JSON.stringify(observation).length, 0)
    + (latestSession ? JSON.stringify(latestSession).length : 0);
  return {
    ...context,
    observations,
    latestSession,
    scopeChain: context.scopeChain.filter((scope) => isAuthorizedScope(identity, scope)),
    ...(context.rollupScopes
      ? { rollupScopes: context.rollupScopes.filter((scope) => isAuthorizedScope(identity, scope)) }
      : {}),
    budgetUsed,
    omittedPinnedIds,
  };
}

type BriefWithBudget = ReturnType<typeof memoryBrief> & {
  budgetUsed?: number;
  omittedPinnedIds?: number[];
  rollupScopes?: string[];
};

function filterMemoryBrief(
  brief: ReturnType<typeof memoryBrief>,
  identity: MemoryRuntimeIdentity | undefined,
): ReturnType<typeof memoryBrief> {
  if (!identity) return brief;
  const result = brief as BriefWithBudget;
  const observations = filterObservations(result.observations, identity);
  const relatedMemories = result.relatedMemories.filter((observation) => isAuthorizedScope(identity, observation.project));
  const latestSession = result.latestSession && isAuthorizedScope(identity, result.latestSession.project)
    ? result.latestSession : null;
  const output: BriefWithBudget = {
    ...result,
    scope: result.scope && isAuthorizedScope(identity, result.scope) ? result.scope : null,
    scopeChain: result.scopeChain.filter((scope) => isAuthorizedScope(identity, scope)),
    scopeSuggestions: result.scopeSuggestions.filter((item) => isAuthorizedScope(identity, item.scope)),
    observations,
    relatedMemories,
    latestSession,
  };
  if (result.rollupScopes) {
    output.rollupScopes = result.rollupScopes.filter((scope) => isAuthorizedScope(identity, scope));
  }
  if (result.omittedPinnedIds) {
    output.omittedPinnedIds = result.omittedPinnedIds.filter((id) => {
      const observation = getObservation(id);
      return Boolean(observation && isAuthorizedScope(identity, observation.project));
    });
  }
  if (result.budgetUsed !== undefined) {
    output.budgetUsed = observations.reduce((total, observation) => total + JSON.stringify(observation).length, 0)
      + relatedMemories.reduce((total, observation) => total + JSON.stringify(observation).length, 0)
      + (latestSession ? JSON.stringify(latestSession).length : 0);
  }
  return output;
}

function assertUnboundAdministration(identity: MemoryRuntimeIdentity | undefined): void {
  if (identity) {
    throw new Error("La administracion global de memoria requiere una autoridad separada del proyecto vinculado.");
  }
}

function memoryAccessDenied(): Error {
  return new Error("Acceso de memoria denegado: el recurso no pertenece a la identidad de proyecto autorizada.");
}

function checkMalahorHooks(args: Record<string, unknown>): unknown {
  const paths = resolvePaths();
  const event = hookEventArg(args.event);
  const targetPaths = stringListArg(args.paths);
  const resourceKind = hookResourceKindArg(args.resourceKind);
  const metadata = recordArg(args.metadata);
  const approval = optionalStringArg(args.approval);
  const project = resolveRegisteredProject(paths, {}, {
    override: optionalStringArg(metadata.project),
    targetPaths: usesFilesystemResources(resourceKind) ? targetPaths : [],
  });
  const profileOverride = typeof args.profile === "string" && args.profile.trim() ? parseHookProfile(args.profile) : undefined;
  const policyLoad = loadHookPolicy(paths, project.canonicalKey, profileOverride);
  const context = {
    event,
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
    resourceKind,
    targetPaths,
    gitIntent: parseGitIntent(args.intent),
    confirmation: optionalStringArg(args.confirm),
    approval,
    metadata,
  };
  return approval ? assertHooksAllowed(context) : auditHookResult(context, runHooks(context));
}

function stringArg(value: unknown, fallback?: string): string {
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error("Expected string argument");
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumberArg(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error("Expected a non-negative safe integer argument");
}

function booleanArg(value: unknown): boolean {
  return value === true;
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

function hookResourceKindArg(value: unknown): HookResourceKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && HOOK_RESOURCE_KINDS.includes(value as HookResourceKind)) {
    return value as HookResourceKind;
  }
  throw new Error(`Expected resourceKind to be one of: ${HOOK_RESOURCE_KINDS.join(", ")}`);
}

function stringListArg(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function recordArg(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
