// malahor-managed
// Entrypoint fuente del plugin gestionado. `bun run build:plugin` lo bundlea a
// assets/opencode/plugins/malahor/index.ts. No importa el SDK: solo usa la
// forma estructural de los hosts V1/V2 para no romper la carga.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainThread, workerData } from "node:worker_threads";

import { resolvePaths, type MalahorPaths } from "../cli/core/paths";
import { loadPlanningAuthority, type PlanningAuthority } from "../cli/core/planning-authority";
import { codegraphEnabled, levelForProject, registeredProjectRoots } from "../cli/core/context";
import { resolveProject } from "../cli/core/project";
import { codegraphRoot, codegraphRuntime } from "../cli/core/codegraph-runtime";
import { loadHookPolicy } from "../cli/core/hooks/policy-loader";
import { createGitIntentRegistry } from "../cli/core/git-intent";
import {
  checkpointBeforeCompaction,
  injectCompactionInstructions,
  type CompactionStorage,
} from "./compaction";
import { markMemoryPersisted, maybeInjectMemoryNudge } from "./memory-nudge";
import { startEventCapture, type EventDomain } from "./events";
import {
  evaluatePermission,
  evaluateSessionHook,
  evaluateShellHook,
  evaluateToolHook,
  formatPluginBlock,
  shouldBlockPluginResult,
  type PluginAdapterOptions,
} from "../cli/core/hooks/plugin-adapter";
import type { HookEvent, HookResult } from "../cli/core/hooks/types";
import { injectMalahorProtocol } from "./protocol";
import {
  completePlanningTool, evaluatePlanningPermission, evaluatePlanningTool, injectPlanningInstructions,
  observePlanningPermissionOutcome, readPlan, registerPlanningTools,
  resolvePlanningScope,
  type PlanningStorage, type PlanningTools,
} from "./planning";
import {
  createCommitWorkflowRegistry,
  registerCommitWorkflowTool,
  type CommitWorkflowScope,
} from "./commit-workflow";
import { createPointActionMediator } from "./point-action-approval";
import { registerModeCommand, type ModeCommandHost } from "./mode-command";
import { registerPlanCommand, type PlanCommandHost } from "./plan-command";
import { compactTerminalPlans } from "./plan-retention";
import { registerReadOnlyCodeModeTools, type CodeModeToolDomain } from "./code-mode";
import { isCodeModeWorkerData, runCodeModeWorker } from "./code-mode-worker";
import {
  createProjectAffinityResolver,
  type ProjectAffinityResolver,
  type ProjectAffinityStorage,
} from "./project-affinity";

const PLUGIN_ID = "malahor";
const PLUGIN_VERSION = "0.6.0";
const STATE_SCHEMA = 1;

if (!isMainThread && isCodeModeWorkerData(workerData)) {
  void runCodeModeWorker(workerData).catch(() => { process.exit(1); });
}

type HostKind = "v1" | "v2" | "unknown";

interface HostInspection {
  host: HostKind;
  capabilities: Record<string, boolean>;
  degraded: string[];
  criticalGaps: string[];
}

interface PluginState extends HostInspection {
  schema: number;
  plugin: string;
  pluginVersion: string;
  updatedAt: string;
}

type Cleanup = () => Promise<void> | void;

type HookDomain = {
  hook: (name: string, callback: (input: Record<string, unknown>) => Promise<void> | void) => Promise<unknown> | unknown;
  get?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
};

type McpServerConfig = Record<string, unknown>;

type McpEditor = {
  get: (name: string) => McpServerConfig | undefined;
  set: (name: string, config: McpServerConfig) => void;
};

type McpTransformDomain = {
  transform: (callback: (editor: McpEditor) => void) => Promise<unknown> | unknown;
};

type StorageDomain = CompactionStorage;

const SESSION_HOOKS: HookEvent[] = [
  "session.prompt.before",
  "session.context.before",
  "session.compaction.before",
  "session.generate.before",
  "session.title.before",
  "session.model-request.before",
  "session.http-request.before",
  "session.http-response.after",
];

function detectHost(value: unknown): HostKind {
  if (!isRecord(value)) return "unknown";

  const isV2 =
    (isRecord(value.session) && typeof value.session.hook === "function") ||
    (isRecord(value.mcp) && typeof value.mcp.transform === "function") ||
    (isRecord(value.agent) && typeof value.agent.transform === "function");
  if (isV2) return "v2";

  const isV1 =
    isRecord(value.client) &&
    isRecord(value.project) &&
    typeof value.directory === "string";
  if (isV1) return "v1";

  return "unknown";
}

async function setupV2(context: Record<string, unknown>): Promise<Cleanup | void> {
  const cwd = locationDirectory(context) ?? process.cwd();
  const options: PluginAdapterOptions = {
    cwd,
    permissionRegistered: false,
    shellRegistered: false,
    gitIntentRegistry: createGitIntentRegistry(),
  };
  // El adaptador de commit conserva su grant exacto. La clasificación directa y
  // el envelope genérico se registran en la fase de wiring posterior; hasta
  // entonces no se declaran capacidades nuevas ni se habilitan mutaciones.
  const commitWorkflow = createCommitWorkflowRegistry();
  const pointActions = createPointActionMediator();
  const cleanups: Cleanup[] = [];
  const capabilities: Record<string, boolean> = {};
  const degraded: string[] = [];
  const criticalGaps: string[] = [];
  let stateRecorded = false;

  const updateCodeModeAvailability = (available: boolean, reason?: string): void => {
    const key = "code-mode.read-only";
    const changed = capabilities[key] !== available;
    capabilities[key] = available;
    const index = criticalGaps.indexOf(key);
    if (available && index >= 0) criticalGaps.splice(index, 1);
    if (!available && index < 0) criticalGaps.push(key);
    if (!changed) return;
    if (!available && reason) warn(`Code Mode R0 degradado: ${reason}`);
    if (!stateRecorded) return;
    const recorded = recordState({
      host: "v2",
      capabilities,
      degraded: unique(degraded),
      criticalGaps: unique(criticalGaps),
    });
    if (!recorded) warn("estado dinamico de Code Mode no disponible (degradado auxiliar)");
  };

  const domain = (name: string): HookDomain | undefined => {
    const value = context[name];
    if (!isRecord(value) || typeof value.hook !== "function") return undefined;
    return value as unknown as HookDomain;
  };

  const mcp = transformDomain(context.mcp);
  if (mcp) {
    const registration = await registerMcpTransform(mcp, cwd, process.env, cleanups, locationCanonical(context));
    capabilities["mcp.transform"] = registration.ok;
    if (registration.warnings.length > 0) degraded.push(...registration.warnings);
  } else {
    capabilities["mcp.transform"] = false;
    degraded.push("mcp.transform");
  }

  const session = domain("session");
  const storage = storageDomain(context.storage);
  const planStorage = storage && typeof storage.get === "function" ? storage as unknown as PlanningStorage : undefined;
  let planningAuthority: PlanningAuthority | undefined;
  if (planStorage) {
    try {
      planningAuthority = loadPlanningAuthority(resolvePaths(process.env, cwd).secretsDir);
      capabilities["planning.authority"] = true;
    } catch (error) {
      capabilities["planning.authority"] = false;
      criticalGaps.push("planning.authority");
      warn(`autoridad de planeacion no disponible: ${(error as Error).message}`);
    }
  }
  if (planStorage && planningAuthority) {
    try {
      const retention = await compactTerminalPlans(planStorage, planningAuthority);
      capabilities["planning.retention"] = retention.supported;
      if (!retention.supported) {
        degraded.push("planning.retention");
      } else if (retention.failed > 0) {
        degraded.push("planning.retention.verification");
        warn(`retencion de planes degradada: ${retention.failed} revision(es) no se compactaron`);
      }
    } catch (error) {
      capabilities["planning.retention"] = false;
      degraded.push("planning.retention");
      warn(`retencion de planes no disponible: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    capabilities["planning.retention"] = false;
    degraded.push("planning.retention");
  }
  if (session?.get) {
    options.resolveSessionDirectory = async (sessionID) => {
      const value = await session.get?.({ sessionID });
      return sessionLocationDirectory(value);
    };
    options.resolveParentSession = async (sessionID) => {
      const raw = await session.get?.({ sessionID });
      const value = isRecord(raw) && isRecord(raw.data) ? raw.data : raw;
      return isRecord(value) && typeof value.parentID === "string" && typeof value.agent === "string"
        ? { parentID: value.parentID, agent: value.agent } : undefined;
    };
  }
  const affinityStorage = storage && typeof storage.get === "function"
    ? storage as ProjectAffinityStorage
    : undefined;
  const projectAffinity: ProjectAffinityResolver | undefined = affinityStorage && session?.get
    ? createProjectAffinityResolver({
      cwd,
      env: process.env,
      storage: affinityStorage,
      locationProject: locationCanonical(context),
      resolveSessionHints: async (sessionID) => {
        const value = await session.get?.({ sessionID });
        const directory = sessionLocationDirectory(value);
        const projectHint = sessionLocationProject(value);
        return directory || projectHint ? {
          ...(directory ? { directory } : {}),
          ...(projectHint ? { projectHint } : {}),
        } : undefined;
      },
      resolvePlanProject: planStorage && planningAuthority ? async (sessionID) => {
        const state = await readPlan(planStorage, sessionID, planningAuthority);
        return state && !["completed", "revoked"].includes(state.phase) ? state.project : undefined;
      } : undefined,
    })
    : undefined;
  if (projectAffinity) options.resolveSessionProject = projectAffinity.resolveSessionProject;
  const resolveCommitWorkflowScope = async (sessionID: string): Promise<CommitWorkflowScope | undefined> => {
    const resolved = await resolvePlanningScope(sessionID, options);
    if (!resolved) return undefined;
    const paths = resolvePaths({ ...process.env, MALAHOR_OPENCODE_DETECT: "0" }, resolved.directory);
    const roots = registeredProjectRoots(paths.projectsFile)
      .filter((entry) => entry.canonicalKey === resolved.scope.project)
      .sort((left, right) => right.root.length - left.root.length);
    const root = roots.find((entry) => isWithin(resolved.directory, entry.root))?.root
      ?? roots[0]?.root
      ?? resolved.directory;
    return {
      sessionID: resolved.scope.sessionID,
      project: resolved.scope.project,
      policyRevision: resolved.scope.policyRevision,
      mode: resolved.scope.mode,
      root,
    };
  };

  const permission = domain("permission");
  if (permission) {
    options.permissionRegistered = await registerHook(permission, "evaluate", async (input) => {
      const evaluated = await evaluatePermission(input, options);
      await observePlanningPermissionOutcome(
        input,
        evaluated.effect,
        options,
        planningAuthority ? planStorage : undefined,
        planningAuthority,
      );
      if (evaluated.effect !== "deny") await evaluatePlanningPermission(
        input,
        options,
        planningAuthority ? planStorage : undefined,
        planningAuthority,
        commitWorkflow,
        capabilities["point-action.approval"] === true ? pointActions : undefined,
      );
      if (input.effect === "deny") {
        warn(`permission.evaluate deny: ${evaluated.effect === "deny" ? summary(evaluated.result) : String(input.message ?? "plan no autorizado")}`);
      }
    }, cleanups);
  }
  if (!permission) criticalGaps.push("permission.hook");
  else if (!options.permissionRegistered) criticalGaps.push("permission.evaluate");
  capabilities.permission = Boolean(permission);
  capabilities["permission.evaluate"] = options.permissionRegistered === true;

  const shell = domain("shell");
  if (shell) {
    options.shellRegistered = await registerHook(shell, "create.before", async (input) => {
      const evaluated = await evaluateShellHook(input, options);
      if (isRecord(input.env)) {
        replaceRecord(input.env as Record<string, string | undefined>, evaluated.env);
      }
      input.timeout = evaluated.timeout;
      if (shouldBlockPluginResult(evaluated.result, options)) {
        throw new Error(formatPluginBlock(evaluated.result));
      }
      // OpenCode V2 no atribuye shell.create.before a una sesion. La politica de
      // plan se valida en tool.execute.before, que si incluye el contexto de sesion.
    }, cleanups);
  }
  if (!shell) criticalGaps.push("shell.hook");
  else if (!options.shellRegistered) criticalGaps.push("shell.create.before");
  capabilities.shell = Boolean(shell);
  capabilities["shell.create.before"] = options.shellRegistered === true;

  const approvalPort = isRecord(context.permission) && typeof context.permission.assert === "function"
    ? context.permission as unknown as Parameters<typeof registerPlanningTools>[1] : undefined;
  const tool = domain("tool");
  if (tool) {
    const registered = await registerHook(tool, "execute.before", async (input) => {
      const result = await evaluateToolHook(input, options);
      if (shouldBlockPluginResult(result, options)) {
        throw new Error(formatPluginBlock(result));
      }
      await evaluatePlanningTool(
        input,
        options,
        planningAuthority ? planStorage : undefined,
        planningAuthority,
        approvalPort,
        commitWorkflow,
        capabilities["point-action.approval"] === true ? pointActions : undefined,
      );
    }, cleanups);
    options.toolRegistered = registered;
    capabilities.tool = true;
    capabilities["tool.execute.before"] = registered;
    if (!registered) criticalGaps.push("tool.execute.before");

    const toolAfterRegistered = (storage && typeof storage.get === "function") || (planStorage && planningAuthority)
      ? await registerHook(tool, "execute.after", async (input) => {
        if (planStorage && planningAuthority) {
          const completed = await completePlanningTool(input, options, planStorage, planningAuthority);
          if (!completed.ok) warn(`recuperación de Planning degradada${completed.reason ? `: ${completed.reason}` : ""}`);
        }
        if (storage && typeof storage.get === "function") {
          const marked = await markMemoryPersisted(input, storage, {
            cwd,
            env: process.env,
            resolveSessionDirectory: options.resolveSessionDirectory,
            resolveSessionProject: options.resolveSessionProject,
          });
          if (!marked.ok) warn(`freshness de memoria degradada${marked.reason ? `: ${marked.reason}` : ""}`);
        }
      }, cleanups)
      : false;
    capabilities["tool.execute.after"] = toolAfterRegistered;
    capabilities["memory.freshness"] = toolAfterRegistered && Boolean(storage && typeof storage.get === "function");
    capabilities["planning.recovery"] = toolAfterRegistered && Boolean(planStorage && planningAuthority);
    if (!capabilities["memory.freshness"]) degraded.push("memory.freshness");
    if (!capabilities["planning.recovery"]) criticalGaps.push("planning.recovery");

    const planningTools = typeof (tool as Record<string, unknown>).transform === "function"
      ? tool as unknown as PlanningTools : undefined;
    if (planningTools && approvalPort && planStorage && planningAuthority
      && (options.resolveSessionProject || options.resolveSessionDirectory) && options.permissionRegistered && registered) {
      try {
        const registration = await registerPlanningTools(planningTools, approvalPort, planStorage, options, planningAuthority);
        if (registration && typeof registration.dispose === "function") cleanups.push(() => registration.dispose?.());
        capabilities["planning.v5"] = true;
        capabilities["planning.v4"] = true; // lectura/revocación de estados terminales o activos legados
      } catch (error) {
        warn(`herramientas de planeacion no registradas: ${(error as Error).message}`);
      }
    }
    if (!capabilities["planning.v5"]) criticalGaps.push("planning.v5");
    if (planningTools && approvalPort && projectAffinity && (options.resolveSessionProject || options.resolveSessionDirectory)
      && options.permissionRegistered && registered) {
      try {
        const registration = await registerCommitWorkflowTool(
          planningTools,
          commitWorkflow,
          resolveCommitWorkflowScope,
          approvalPort,
        );
        if (registration && typeof registration.dispose === "function") cleanups.push(() => registration.dispose?.());
        capabilities["commit.workflow.tool"] = true;
      } catch (error) {
        capabilities["commit.workflow.tool"] = false;
        warn(`herramienta estructural de commit no registrada: ${(error as Error).message}`);
      }
    } else {
      capabilities["commit.workflow.tool"] = false;
    }
    if (planningTools && approvalPort && projectAffinity && (options.resolveSessionProject || options.resolveSessionDirectory)
      && options.permissionRegistered && registered) {
      try {
        const [{ createTaskClassifier, registerTaskClassificationTool }, { createDirectTaskRegistry, registerDirectTaskTool }] =
          await Promise.all([
            import("./task-classification"),
            import("./direct-task-execution"),
          ]);
        const taskClassifier = createTaskClassifier();
        const directTasks = createDirectTaskRegistry();
        const classifierRegistration = await registerTaskClassificationTool(
          planningTools as unknown as import("./task-classification").TaskClassificationTools,
          taskClassifier,
          resolveCommitWorkflowScope,
        );
        if (classifierRegistration && typeof classifierRegistration.dispose === "function") {
          cleanups.push(() => classifierRegistration.dispose?.());
        }
        const directRegistration = await registerDirectTaskTool(
          planningTools as unknown as import("./direct-task-execution").DirectTaskTools,
          directTasks,
          taskClassifier,
          resolveCommitWorkflowScope,
          approvalPort,
        );
        if (directRegistration && typeof directRegistration.dispose === "function") {
          cleanups.push(() => directRegistration.dispose?.());
        }
        capabilities["task.classification"] = true;
        capabilities["direct.task"] = true;
      } catch (error) {
        capabilities["task.classification"] = false;
        capabilities["direct.task"] = false;
        warn(`herramientas de clasificación directa no registradas: ${(error as Error).message}`);
      }
    } else {
      capabilities["task.classification"] = false;
      capabilities["direct.task"] = false;
    }

    const codeModeTools = typeof (tool as Record<string, unknown>).transform === "function"
      && typeof (tool as Record<string, unknown>).list === "function"
      ? tool as unknown as CodeModeToolDomain : undefined;
    if (codeModeTools && approvalPort && storage && options.resolveSessionProject
      && options.permissionRegistered && registered) {
      try {
        const registration = await registerReadOnlyCodeModeTools(
          codeModeTools,
          approvalPort,
          storage,
          options,
          { moduleURL: import.meta.url, onAvailability: updateCodeModeAvailability },
        );
        if (registration.dispose) cleanups.push(() => registration.dispose?.());
        updateCodeModeAvailability(registration.available);
      } catch (error) {
        updateCodeModeAvailability(false);
        warn(`Code Mode R0 no registrado: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      updateCodeModeAvailability(false);
    }
  } else {
    capabilities.tool = false;
    capabilities["tool.execute.before"] = false;
    capabilities["memory.freshness"] = false;
    capabilities["commit.workflow.tool"] = false;
    updateCodeModeAvailability(false);
    criticalGaps.push("tool.hook");
    criticalGaps.push("planning.v5");
  }

  const modeHost = isRecord(context.command) && typeof context.command.transform === "function"
    && isRecord(context.session) && typeof context.session.synthetic === "function"
    && isRecord(context.permission) && typeof context.permission.assert === "function"
    && (options.resolveSessionProject || options.resolveSessionDirectory)
    ? context as unknown as ModeCommandHost : undefined;
  if (modeHost) {
    try {
      const registration = await registerModeCommand(modeHost, options);
      if (registration && typeof registration.dispose === "function") cleanups.push(() => registration.dispose?.());
      capabilities["mode.command"] = true;
    } catch (error) {
      warn(`comando de modo no registrado: ${(error as Error).message}`);
    }
  }
  if (!capabilities["mode.command"]) degraded.push("mode.command");

  const planCommandHost = isRecord(context.command) && typeof context.command.transform === "function"
    && isRecord(context.session) && typeof context.session.synthetic === "function"
    && isRecord(context.permission) && typeof context.permission.assert === "function"
    && (options.resolveSessionProject || options.resolveSessionDirectory)
    ? context as unknown as PlanCommandHost : undefined;
  if (planCommandHost && planStorage && planningAuthority) {
    try {
      const registration = await registerPlanCommand(planCommandHost, planStorage, planningAuthority, options);
      if (registration && typeof registration.dispose === "function") cleanups.push(() => registration.dispose?.());
      capabilities["plan.command"] = true;
    } catch (error) {
      warn(`comando de plan no registrado: ${(error as Error).message}`);
    }
  }
  if (!capabilities["plan.command"]) degraded.push("plan.command");

  if (session) {
    for (const event of SESSION_HOOKS) {
      const registered = await registerHook(session, hookNameForEvent(event), async (input) => {
        if (event === "session.prompt.before" && projectAffinity) {
          try {
            await projectAffinity.observePrompt(input);
          } catch (error) {
            warn(`afinidad de proyecto no observable: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (event === "session.prompt.before" && capabilities["commit.workflow.tool"] === true) {
          try {
            const observed = await commitWorkflow.observePrompt(input, resolveCommitWorkflowScope);
            const sessionID = typeof input.sessionID === "string" ? input.sessionID : "";
            const messageID = typeof input.messageID === "string" ? input.messageID : "";
            if (observed.explicit && sessionID && messageID) {
              const scope = await resolveCommitWorkflowScope(sessionID);
              if (scope) {
                const { recordCommitDecision } = await import("./task-classification");
                recordCommitDecision(scope, messageID);
              }
            }
          } catch (error) {
            const sessionID = typeof input.sessionID === "string" ? input.sessionID : "";
            if (sessionID) commitWorkflow.invalidate(sessionID);
            warn(`solicitud estructural de commit no observable: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (event === "session.prompt.before" && typeof input.sessionID === "string") {
          pointActions.invalidate(input.sessionID);
        }
        const result = await evaluateSessionHook(event, input, options);
        if (event === "session.http-response.after") return;
        if (result.decision === "deny" || result.decision === "ask") {
          throw new Error(formatPluginBlock(result));
        }
      }, cleanups);
      capabilities[event] = registered;
      if (!registered) {
        if (event === "session.http-response.after") degraded.push(event);
        else criticalGaps.push(event);
      }
    }

    const protocolRegistered = await registerHook(session, "context", async (input) => {
      if (projectAffinity) await projectAffinity.injectContext(input);
      injectMalahorProtocol(input);
      await injectPlanningInstructions(input, options, planningAuthority ? planStorage : undefined, planningAuthority);
    }, cleanups);
    capabilities["protocol.context"] = protocolRegistered;
    if (!protocolRegistered) degraded.push("protocol.context");

    const compactionRegistered = await registerHook(session, "compaction", async (input) => {
      if (storage) {
          const checkpoint = await checkpointBeforeCompaction(input, storage, {
            cwd,
            resolveSessionDirectory: options.resolveSessionDirectory,
            resolveSessionProject: options.resolveSessionProject,
          });
        if (!checkpoint.ok) {
          warn(`checkpoint de compaction degradado${checkpoint.reason ? `: ${checkpoint.reason}` : ""}`);
        }
      } else {
        warn("checkpoint de compaction degradado: ctx.storage no disponible");
      }
      injectCompactionInstructions(input);
    }, cleanups);
    capabilities["compaction.checkpoint"] = compactionRegistered && Boolean(storage);
    if (!compactionRegistered || !storage) degraded.push("compaction.checkpoint");

    const nudgeRegistered = storage && typeof storage.get === "function"
      ? await registerHook(session, "context", async (input) => {
          const nudge = await maybeInjectMemoryNudge(input, storage, {
            cwd,
            env: process.env,
            resolveSessionDirectory: options.resolveSessionDirectory,
            resolveSessionProject: options.resolveSessionProject,
          });
        if (!nudge.ok && nudge.reason) warn(`nudge de memoria degradado: ${nudge.reason}`);
      }, cleanups)
      : false;
    capabilities["memory.nudge"] = nudgeRegistered;
    if (!nudgeRegistered) degraded.push("memory.nudge");
  } else {
    capabilities.session = false;
    for (const event of SESSION_HOOKS) capabilities[event] = false;
    capabilities["protocol.context"] = false;
    capabilities["compaction.checkpoint"] = false;
    capabilities["memory.nudge"] = false;
    criticalGaps.push("session.hook");
  }
  capabilities.session = Boolean(session);
  capabilities["commit.workflow"] = capabilities["commit.workflow.tool"] === true
    && capabilities["session.prompt.before"] === true
    && capabilities["permission.evaluate"] === true
    && capabilities["tool.execute.before"] === true
    && capabilities["shell.create.before"] === true;
  if (!capabilities["commit.workflow"]) criticalGaps.push("commit.workflow");
  capabilities["point-action.approval"] = Boolean(approvalPort && planStorage && planningAuthority)
    && capabilities["permission.evaluate"] === true
    && capabilities["tool.execute.before"] === true
    && capabilities["session.prompt.before"] === true;
  if (!capabilities["point-action.approval"]) criticalGaps.push("point-action.approval");

  const event = eventDomain(context.event);
  if (event && storage) {
    const capture = startEventCapture(event, storage, {
      cwd,
      captureSubagentsOptIn: (project) => captureSubagentsOptIn(project.root, process.env, project.canonicalKey),
      resolveSessionDirectory: options.resolveSessionDirectory,
      resolveSessionProject: options.resolveSessionProject,
      onError: (message) => warn(message),
    });
    capabilities.event = capture.ok;
    cleanups.push(capture.cleanup);
    if (!capture.ok) degraded.push("event");
  } else {
    capabilities.event = false;
    degraded.push("event");
  }

  const auxiliary = ["mcp", "agent", "command", "skill", "storage"] as const;
  for (const name of auxiliary) {
    const available = name === "storage"
      ? context.storage !== undefined && context.storage !== null
      : isRecord(context[name]) && (
        typeof (context[name] as Record<string, unknown>).transform === "function"
        || typeof (context[name] as Record<string, unknown>).hook === "function"
        || typeof (context[name] as Record<string, unknown>).subscribe === "function"
      );
    capabilities[name] = available;
    if (!available) degraded.push(name);
  }

  const inspection: HostInspection = {
    host: "v2",
    capabilities,
    degraded: unique(degraded),
    criticalGaps: unique(criticalGaps),
  };
  const recorded = recordState(inspection);
  stateRecorded = true;
  if (!recorded) warn("estado de diagnostico no disponible (degradado auxiliar)");
  if (inspection.criticalGaps.length > 0) {
    warn(`controles criticos no disponibles: ${inspection.criticalGaps.join(", ")}; no se habilitan operaciones protegidas`);
  } else if (inspection.degraded.length > 0) {
    warn(`capacidades auxiliares degradadas: ${inspection.degraded.join(", ")}`);
  }

  return async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        warn(`cleanup fallido: ${(error as Error).message}`);
      }
    }
  };
}

async function setupV1(input: Record<string, unknown>): Promise<void> {
  const capabilities = {
    client: isRecord(input.client),
    project: isRecord(input.project),
    directory: typeof input.directory === "string",
    worktree: typeof input.worktree === "string",
    shell: typeof input.$ === "function",
    workspace: isRecord(input.experimental_workspace),
  };
  const degraded = Object.entries(capabilities)
    .filter(([, available]) => !available)
    .map(([name]) => name);
  const criticalGaps = [
    "v1.permission.hook",
    "v1.tool.hook",
    "v1.shell.hook",
    "v1.session.hook",
  ];
  recordState({ host: "v1", capabilities, degraded, criticalGaps });
  warn("host V1 detectado: no hay hooks de mediacion; cobertura V1 completa queda en T-5.6.4");
}

async function setupUnknown(): Promise<void> {
  recordState({
    host: "unknown",
    capabilities: {},
    degraded: ["host-api-desconocida"],
    criticalGaps: ["host-api-desconocida"],
  });
  warn("API de host no reconocida; plugin inactivo (degradacion segura)");
}

const plugin = {
  id: PLUGIN_ID,

  async setup(context: unknown): Promise<Cleanup | void> {
    const host = detectHost(context);
    if (host === "v2") return setupV2(context as Record<string, unknown>);
    if (host === "v1") {
      await setupV1(context as Record<string, unknown>);
      return;
    }
    await setupUnknown();
  },

  async server(input: unknown): Promise<Record<string, never>> {
    const host = detectHost(input);
    if (host === "v2") {
      await setupV2(input as Record<string, unknown>);
    } else if (host === "v1") {
      await setupV1(input as Record<string, unknown>);
    } else {
      await setupUnknown();
    }
    return {};
  },
};

export default plugin;

async function registerHook(
  domain: HookDomain,
  name: string,
  callback: (input: Record<string, unknown>) => Promise<void>,
  cleanups: Cleanup[],
): Promise<boolean> {
  try {
    const registration = await domain.hook(name, callback);
    if (isRecord(registration) && typeof registration.dispose === "function") {
      cleanups.push(() => (registration.dispose as () => Promise<void> | void)());
    }
    return true;
  } catch (error) {
    warn(`no se pudo registrar ${name}: ${(error as Error).message}`);
    return false;
  }
}

function hookNameForEvent(event: HookEvent): string {
  if (event === "session.prompt.before") return "prompt";
  if (event === "session.context.before") return "context";
  if (event === "session.compaction.before") return "compaction";
  if (event === "session.generate.before") return "generate";
  if (event === "session.title.before") return "title";
  if (event === "session.model-request.before") return "model.request";
  if (event === "session.http-request.before") return "http.request";
  if (event === "session.http-response.after") return "http.response";
  return event;
}

function locationDirectory(context: Record<string, unknown>): string | undefined {
  const location = isRecord(context.location) ? context.location : undefined;
  if (!location) return undefined;
  return typeof location.directory === "string" ? location.directory : undefined;
}

function locationCanonical(context: Record<string, unknown>): string | undefined {
  const location = isRecord(context.location) ? context.location : undefined;
  const project = location && isRecord(location.project) ? location.project : undefined;
  return typeof project?.canonical === "string" ? project.canonical : undefined;
}

function isWithin(value: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function transformDomain(value: unknown): McpTransformDomain | undefined {
  if (!isRecord(value) || typeof value.transform !== "function") return undefined;
  return value as unknown as McpTransformDomain;
}

function storageDomain(value: unknown): StorageDomain | undefined {
  if (!isRecord(value) || typeof value.set !== "function") return undefined;
  return value as unknown as StorageDomain;
}

function eventDomain(value: unknown): EventDomain | undefined {
  if (!isRecord(value) || typeof value.subscribe !== "function") return undefined;
  return value as unknown as EventDomain;
}

function captureSubagentsOptIn(cwd: string, env: NodeJS.ProcessEnv, canonicalKey?: string): boolean {
  try {
    const paths = resolvePaths({ ...env, MALAHOR_OPENCODE_DETECT: "0" }, cwd);
    const project = canonicalKey ?? resolveProject(cwd).canonicalKey;
    const loaded = loadHookPolicy(paths, project);
    return loaded.security?.persistence?.captureSubagentsOptIn === true;
  } catch {
    return false;
  }
}

async function registerMcpTransform(
  domain: McpTransformDomain,
  cwd: string,
  env: NodeJS.ProcessEnv,
  cleanups: Cleanup[],
  canonical?: string,
): Promise<{ ok: boolean; warnings: string[] }> {
  const paths = resolvePaths({ ...env, MALAHOR_OPENCODE_DETECT: "0" }, cwd);
  const warnings: string[] = [];
  const memoryProject = memoryProjectForLocation(paths, cwd, canonical);
  const horielIndex = paths.horielIndex ?? path.join(paths.malahorHome, "horiel", "index.js");
  const horielDatabase = paths.horielDb ?? path.join(paths.malahorHome, "horiel", "horiel.sqlite");
  const horielSnapshots = paths.horielSnapshots ?? path.join(paths.malahorHome, "horiel", "snapshots");
  if (!fs.existsSync(paths.mnemoIndex)) {
    warnings.push("mcp.mnemo-index-missing");
  } else if (!memoryProject) {
    warnings.push("mcp.mnemo-project-unresolved");
  }
  if (!fs.existsSync(paths.docsIndex)) {
    warnings.push("mcp.docs-index-missing");
  }

  try {
    const registration = await domain.transform((editor) => {
      const existingMnemo = editor.get("mnemo");
      if (fs.existsSync(paths.mnemoIndex)) {
        if (!existingMnemo || isMalahorMnemo(existingMnemo, paths)) {
          editor.set("mnemo", {
            ...(existingMnemo ?? {}),
            type: "local",
            command: ["node", paths.mnemoIndex],
            environment: memoryProject ? {
              ...(isRecord(existingMnemo?.environment) ? existingMnemo.environment : {}),
              MALAHOR_MEMORY_BOUND: "1",
              MALAHOR_MEMORY_PROJECT: memoryProject,
            } : {
              MALAHOR_MEMORY_BOUND: "1",
            },
            disabled: !memoryProject,
            codemode: false,
          });
        } else {
          warnings.push("mcp.mnemo-foreign-definition");
        }
      }

      const existingDocs = editor.get("docs");
      if (fs.existsSync(paths.docsIndex)) {
        if (!existingDocs || isMalahorDocs(existingDocs, paths)) {
          editor.set("docs", {
            ...(existingDocs ?? {}),
            type: "local",
            command: ["node", paths.docsIndex],
            disabled: false,
            codemode: false,
          });
        } else {
          warnings.push("mcp.docs-foreign-definition");
        }
      }

      const existingHoriel = editor.get("horiel");
      if (fs.existsSync(horielIndex)) {
        if (!memoryProject) {
          warnings.push("mcp.horiel-project-unresolved");
        } else if (!existingHoriel || isMalahorHoriel(existingHoriel, paths)) {
          editor.set("horiel", {
            ...(existingHoriel ?? {}),
            type: "local",
            command: ["node", horielIndex],
            environment: {
              ...withoutHorielEnablement(existingHoriel?.environment),
              MALAHOR_HORIEL_BOUND: "1",
              MALAHOR_HORIEL_PROJECT: memoryProject,
              MALAHOR_HORIEL_DATABASE: horielDatabase,
              MALAHOR_HORIEL_SNAPSHOT_DIRECTORY: horielSnapshots,
            },
            disabled: true,
            codemode: false,
          });
        } else {
          warnings.push("mcp.horiel-foreign-definition");
        }
      }

      let target: ReturnType<typeof codegraphRoot> | undefined;
      try {
        const registered = canonical ? registeredProjectRoots(paths.projectsFile)
          .find((entry) => fs.realpathSync(entry.root) === fs.realpathSync(canonical)) : undefined;
        if (!canonical || registered) target = codegraphRoot(paths, registered?.canonicalKey);
      } catch { /* No registered root at this location. */ }
      const level = target ? levelForProject(paths.projectsFile, target.project) : undefined;

      const existingCodegraph = editor.get("codegraph");
      if (!level || !codegraphEnabled(level)) {
        if (existingCodegraph && isManagedCodegraph(existingCodegraph, paths)) {
          editor.set("codegraph", { ...existingCodegraph, disabled: true });
        }
        return;
      }
      const runtime = target && codegraphRuntime(paths, target.project, target.root);
      if (!runtime) {
        warnings.push("mcp.codegraph-no-managed-index");
        if (existingCodegraph && isManagedCodegraph(existingCodegraph, paths)) {
          editor.set("codegraph", { ...existingCodegraph, disabled: true });
        }
      } else if (existingCodegraph && !isManagedCodegraph(existingCodegraph, paths)) {
        warnings.push("mcp.codegraph-foreign-definition");
      } else {
        editor.set("codegraph", {
          type: "local",
          command: ["node", runtime.proxy, runtime.binary, runtime.root, runtime.database, target!.project, paths.projectsFile, paths.malahorHome],
          cwd: runtime.root,
          environment: { NODE_OPTIONS: "", NODE_PATH: "" },
          disabled: false,
          codemode: false,
          protocol: "legacy",
        });
      }
    });
    if (isRecord(registration) && typeof registration.dispose === "function") {
      cleanups.push(() => (registration.dispose as () => Promise<void> | void)());
    }
    return { ok: true, warnings: unique(warnings) };
  } catch (error) {
    warn(`no se pudo registrar ctx.mcp.transform: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, warnings: ["mcp.transform-registration"] };
  }
}

function isManagedCodegraph(config: McpServerConfig, paths: MalahorPaths): boolean {
  return config.type === "local" && Array.isArray(config.command)
    && config.command[0] === "node" && config.command[1] === path.join(paths.malahorHome, "codegraph", "bin", "mcp-proxy.mjs");
}

function memoryProjectForLocation(paths: MalahorPaths, cwd: string, canonical?: string): string | undefined {
  const roots = registeredProjectRoots(paths.projectsFile)
    .sort((left, right) => right.root.length - left.root.length);
  const canonicalValue = canonical?.trim();
  const byKey = canonicalValue ? roots.find((entry) => entry.canonicalKey === canonicalValue) : undefined;
  const byDirectory = roots.find((entry) => pathInside(cwd, entry.root));
  const byCanonicalPath = canonicalValue && path.isAbsolute(canonicalValue)
    ? roots.find((entry) => pathInside(canonicalValue, entry.root))
    : undefined;
  const candidates = new Set([byKey?.canonicalKey, byDirectory?.canonicalKey, byCanonicalPath?.canonicalKey]
    .filter((value): value is string => Boolean(value)));
  if (candidates.size > 1) return undefined;
  if (candidates.size === 1) return validMemoryProject([...candidates][0]);
  if (roots.length === 1) return validMemoryProject(roots[0]?.canonicalKey);
  if (roots.length > 1) return undefined;
  return validMemoryProject(resolveProject(cwd).canonicalKey);
}

function validMemoryProject(value: string | undefined): string | undefined {
  const project = value?.trim();
  if (!project || project === "global" || /[\0\r\n\\]/.test(project)
    || project.startsWith("/") || project.endsWith("/") || project.includes("//")) return undefined;
  return project;
}

function canonicalLocation(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function pathInside(value: string, root: string): boolean {
  const relative = path.relative(canonicalLocation(root), canonicalLocation(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMalahorMnemo(config: McpServerConfig, paths: MalahorPaths): boolean {
  if (config.type !== "local" || !Array.isArray(config.command)) return false;
  const command = config.command.filter((item): item is string => typeof item === "string");
  return command.some((item) => path.resolve(paths.opencodeDir, item) === path.resolve(paths.mnemoIndex));
}

function isMalahorDocs(config: McpServerConfig, paths: MalahorPaths): boolean {
  if (config.type !== "local" || !Array.isArray(config.command)) return false;
  const command = config.command.filter((item): item is string => typeof item === "string");
  return command.some((item) => path.resolve(paths.opencodeDir, item) === path.resolve(paths.docsIndex));
}

function isMalahorHoriel(config: McpServerConfig, paths: MalahorPaths): boolean {
  if (config.type !== "local" || !Array.isArray(config.command)) return false;
  const index = paths.horielIndex ?? path.join(paths.malahorHome, "horiel", "index.js");
  const command = config.command.filter((item): item is string => typeof item === "string");
  return command.some((item) => path.resolve(paths.opencodeDir, item) === path.resolve(index));
}

function withoutHorielEnablement(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/HORIEL.*ENABLED/i.test(key)));
}

function sessionLocationDirectory(value: unknown): string | undefined {
  const response = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(response)) return undefined;
  const location = isRecord(response.location) ? response.location : undefined;
  return location && typeof location.directory === "string" ? location.directory : undefined;
}

function sessionLocationProject(value: unknown): string | undefined {
  const response = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(response)) return undefined;
  const location = isRecord(response.location) ? response.location : undefined;
  const project = location && isRecord(location.project) ? location.project : undefined;
  return typeof project?.canonical === "string" ? project.canonical
    : typeof project?.name === "string" ? project.name
      : typeof project?.id === "string" ? project.id : undefined;
}

function recordState(inspection: HostInspection): boolean {
  const directory = resolveMalahorHome();
  const file = path.join(directory, "plugin-state.json");
  const state: PluginState = {
    schema: STATE_SCHEMA,
    plugin: PLUGIN_ID,
    pluginVersion: PLUGIN_VERSION,
    host: inspection.host,
    capabilities: inspection.capabilities,
    degraded: inspection.degraded,
    criticalGaps: inspection.criticalGaps,
    updatedAt: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.plugin-state.${process.pid}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    return true;
  } catch (error) {
    warn(`no se pudo escribir ${file}: ${(error as Error).message}`);
    return false;
  }
}

function resolveMalahorHome(): string {
  const override = process.env.MALAHOR_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".malahor");
}

function replaceRecord(target: Record<string, string | undefined>, source: Record<string, string | undefined>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function summary(result: HookResult): string {
  return result.violations
    .filter((violation) => violation.decision === "deny")
    .map((violation) => violation.id)
    .join(",") || result.decision;
}

function warn(message: string): void {
  console.warn(`[${PLUGIN_ID}] ${message}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
