import { loadHookPolicy } from "../cli/core/hooks/policy-loader";
import type { HookContext, HookEvent } from "../cli/core/hooks/types";
import { resolvePaths } from "../cli/core/paths";
import { resolveProject } from "../cli/core/project";

/**
 * Contexto comun para operaciones MCP que ejecutan efectos propios.
 * Carga la misma politica efectiva que CLI/plugin para no saltarse el suelo
 * corporativo ni la auditoria obligatoria.
 */
export function mcpHookContext(event: HookEvent, overrides: Partial<HookContext> = {}): HookContext {
  const paths = resolvePaths();
  const project = resolveProject(paths.cwd);
  const policyLoad = loadHookPolicy(paths, project.canonicalKey);

  return {
    event,
    harness: "mcp",
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
}
