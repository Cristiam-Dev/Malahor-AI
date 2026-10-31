import { loadConfig } from "./config";
import type { ContextMigrationWriteRequest } from "./context-migration";
import { assertHooksAllowed } from "./hooks/engine";
import { loadHookPolicy } from "./hooks/policy-loader";
import { resolveProject } from "./project";

/** Adaptador real del puerto de escritura; los tests del nucleo inyectan uno aislado. */
export function assertContextMigrationWriteAllowed(
  request: ContextMigrationWriteRequest,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): void {
  const config = loadConfig(env, cwd);
  const project = resolveProject(cwd, config.projects.aliases);
  const loaded = loadHookPolicy(config.paths, project.canonicalKey, undefined, { env });
  assertHooksAllowed({
    event: request.event,
    harness: "cli",
    profile: loaded.policy.profile,
    cwd,
    projectRoot: project.root,
    malahorHome: config.paths.malahorHome,
    project: project.canonicalKey,
    policy: loaded.policy,
    security: loaded.security,
    policyMeta: loaded.policyMeta,
    resourceKind: "filesystem",
    targetPaths: request.targetPaths,
    approval: request.approval,
    metadata: {
      operation: "context.migrate",
      expectedVersion: request.expectedVersion,
      writesMalahorData: true,
      backupBeforeWrite: true,
      atomicWrite: true,
    },
  });
}
