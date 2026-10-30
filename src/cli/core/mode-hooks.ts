import { loadConfig } from "./config";
import { resolveRegisteredProject, rootsForProject } from "./context";
import { assertHooksAllowed } from "./hooks/engine";
import { loadHookPolicy } from "./hooks/policy-loader";

/** Se comparte entre CLI y harness; un ASK sin evidencia del canal humano no pasa. */
export function assertModeWriteAllowed(
  configFile: string, backupsDir: string, cwd: string, env: NodeJS.ProcessEnv,
  harness: "cli" | "opencode", approval?: string,
): void {
  const config = loadConfig(env, cwd);
  const project = resolveRegisteredProject(config.paths, config.projects.aliases);
  if (!rootsForProject(config.paths.projectsFile, project.canonicalKey).includes(project.root)) {
    throw new Error("Cambia el modo desde una raiz de proyecto registrada.");
  }
  const loaded = loadHookPolicy(config.paths, project.canonicalKey);
  assertHooksAllowed({
    event: "file.write.before", harness, profile: loaded.policy.profile,
    cwd, projectRoot: project.root, malahorHome: config.paths.malahorHome,
    project: project.canonicalKey, policy: loaded.policy, security: loaded.security,
    policyMeta: loaded.policyMeta, resourceKind: "filesystem", targetPaths: [configFile, backupsDir],
    approval,
  });
}
