import { resolveRegisteredProject } from "../cli/core/context";
import { loadHookPolicy } from "../cli/core/hooks/policy-loader";
import { usesFilesystemResources } from "../cli/core/hooks/resources";
import type { HookContext, HookEvent } from "../cli/core/hooks/types";
import { resolvePaths } from "../cli/core/paths";

export interface MemoryRuntimeIdentity {
  project: string;
  client: string;
}

/**
 * Identidad fijada por el registro MCP gestionado. No se deriva de argumentos
 * de una tool ni de un scope de memoria: esos valores son datos del caller y
 * nunca una ACL.
 */
export function memoryRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): MemoryRuntimeIdentity | undefined {
  if (env.MALAHOR_MEMORY_BOUND !== "1") return undefined;

  const project = env.MALAHOR_MEMORY_PROJECT?.trim();
  if (!project || project === "global" || /[\0\r\n\\]/.test(project)
    || project.startsWith("/") || project.endsWith("/") || project.includes("//")) {
    throw new Error("Identidad de proyecto de memoria ausente o invalida; acceso denegado.");
  }

  // No existe una identidad de cliente separada en el registro actual. La
  // afinidad canonica de proyecto se vincula a ambos campos de hooks/approvals
  // sin inferir autoridad desde la jerarquia del scope.
  return { project, client: project };
}

/**
 * Contexto comun para operaciones Mnemo de CLI/MCP que ejecutan efectos propios.
 * Carga la misma politica efectiva que CLI/plugin para no saltarse el suelo
 * corporativo ni la auditoria obligatoria.
 */
export function mcpHookContext(event: HookEvent, overrides: Partial<HookContext> = {}): HookContext {
  return mnemoHookContext(event, "mcp", overrides);
}

export function mnemoHookContext(event: HookEvent, harness: HookContext["harness"],
  overrides: Partial<HookContext> = {}): HookContext {
  const paths = resolvePaths();
  const identity = memoryRuntimeIdentity();
  const metadataProject = typeof overrides.metadata?.project === "string" ? overrides.metadata.project : undefined;
  const project = resolveRegisteredProject(paths, {}, {
    override: identity?.project ?? overrides.project ?? metadataProject,
    preferredRoot: overrides.projectRoot,
    targetPaths: usesFilesystemResources(overrides.resourceKind) ? overrides.targetPaths : [],
    projectHint: overrides.memoryScope,
  });
  const policyLoad = loadHookPolicy(paths, identity?.project ?? project.canonicalKey);

  const context: HookContext = {
    event,
    harness,
    profile: policyLoad.policy.profile,
    cwd: paths.cwd,
    projectRoot: project.root,
    malahorHome: paths.malahorHome,
    project: project.canonicalKey,
    policy: policyLoad.policy,
    security: policyLoad.security,
    policyMeta: policyLoad.policyMeta,
    audit: { enabled: true },
    ...overrides,
  };
  return identity ? { ...context, project: identity.project, client: identity.client } : context;
}
