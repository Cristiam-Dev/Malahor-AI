import { resolveRegisteredProject } from "../../cli/core/context";
import { assertHooksAllowed } from "../../cli/core/hooks/engine";
import { loadHookPolicy } from "../../cli/core/hooks/policy-loader";
import type { HookDecision, HookEvent } from "../../cli/core/hooks/types";
import { resolvePaths } from "../../cli/core/paths";

export interface HorielGuardRequest {
  event: HookEvent;
  approval?: string;
  confirmation?: string;
  memoryScope?: string;
  metadata?: Record<string, unknown>;
}

export interface HorielGuardResult {
  decision: Extract<HookDecision, "allow" | "ask" | "deny">;
}

export type HorielGuard = ((request: HorielGuardRequest) => Promise<HorielGuardResult> | HorielGuardResult) | {
  authorize?: (request: HorielGuardRequest) => Promise<HorielGuardResult> | HorielGuardResult;
  check?: (request: HorielGuardRequest) => Promise<HorielGuardResult> | HorielGuardResult;
};

export interface CreateHorielHookGuardInput {
  project: string;
  databasePath: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function createHorielHookGuard(input: CreateHorielHookGuardInput): HorielGuard {
  const authorize = async (request: HorielGuardRequest): Promise<HorielGuardResult> => {
    const env = input.env ?? process.env;
    const cwd = input.cwd ?? process.cwd();
    const paths = resolvePaths({ ...env, MALAHOR_OPENCODE_DETECT: "0" }, cwd);
    const project = resolveRegisteredProject(paths, {}, {
      override: input.project,
      projectHint: request.memoryScope,
    });
    const loaded = loadHookPolicy(paths, input.project);
    const result = assertHooksAllowed({
      event: request.event,
      harness: "mcp",
      profile: loaded.policy.profile,
      cwd,
      projectRoot: project.root,
      malahorHome: paths.malahorHome,
      project: input.project,
      client: input.project,
      policy: loaded.policy,
      security: loaded.security,
      policyMeta: loaded.policyMeta,
      resourceKind: "filesystem",
      targetPaths: [input.databasePath],
      memoryScope: request.memoryScope,
      confirmation: request.confirmation,
      approval: request.approval,
      audit: { enabled: true },
      metadata: {
        writesMalahorData: true,
        ...request.metadata,
      },
    });
    return { decision: result.decision === "warn" ? "allow" : result.decision };
  };
  return Object.assign(authorize, { authorize, check: authorize });
}
