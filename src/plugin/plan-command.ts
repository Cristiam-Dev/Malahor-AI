import { controlPlan, renderPlan, type PlanControl, type PlanningAdapter } from "../cli/core/planning";
import type { PlanningAuthority } from "../cli/core/planning-authority";
import type { PluginAdapterOptions } from "../cli/core/hooks/plugin-adapter";
import {
  planKey,
  planRecordKey,
  planRevisionKey,
  resolvePlanningScope,
  type PlanningStorage,
} from "./planning";

interface PlanInvocation {
  sessionID: string;
  prompt: { text: string; files?: unknown[]; agents?: unknown[]; skills?: unknown[] };
  delivery: "steer" | "queue";
}

export interface PlanCommandHost {
  command: { transform: (callback: (editor: { add: (definition: {
    name: string;
    description: string;
    execute: (input: PlanInvocation) => Promise<void>;
  }) => void }) => void) => Promise<{ dispose?: () => Promise<void> | void } | void> };
  session: { synthetic: (input: { sessionID: string; text: string }) => Promise<unknown> };
  permission: { assert: (input: {
    sessionID: string;
    action: string;
    resources: string[];
    save: string[];
  }) => Promise<unknown> };
}

const CONTROLS = new Set<PlanControl>(["status", "pause", "resume", "revoke", "complete"]);

export async function registerPlanCommand(
  host: PlanCommandHost,
  storage: PlanningStorage,
  authority: PlanningAuthority,
  options: PluginAdapterOptions,
) {
  return host.command.transform((editor) => editor.add({
    name: "malahor-plan",
    description: "Consultar, pausar, reanudar, revocar o completar el plan activo",
    execute: async ({ sessionID, prompt }) => {
      if (!prompt || typeof prompt.text !== "string" || prompt.files?.length || prompt.agents?.length || prompt.skills?.length) {
        throw new Error("El comando de plan solo acepta argumentos de texto, sin adjuntos.");
      }
      const args = prompt.text.trim().replace(/^\/?malahor-plan(?:\s+|$)/, "").trim().split(/\s+/).filter(Boolean);
      const action = (args[0] ?? "status") as PlanControl;
      if (args.length > 1 || !CONTROLS.has(action)) {
        throw new Error("Uso: /malahor-plan [status|pause|resume|revoke|complete]");
      }
      const resolved = await resolvePlanningScope(sessionID, options);
      if (!resolved) throw new Error("Sesion sin proyecto registrado; plan no disponible.");
      const adapter: PlanningAdapter = {
        loadActive: (id) => storage.get(planKey(id)),
        loadPlan: (planID) => storage.get(planRecordKey(planID)),
        save: async (state) => {
          await storage.set(planRevisionKey(state.planID, state.revision), state);
          await storage.set(planRecordKey(state.planID), state);
          await storage.set(planKey(state.sessionID), state);
        },
        confirm: async (kind, state) => {
          const permissionAction = kind === "resume" ? "malahor_plan_resume"
            : kind === "complete" ? "malahor_plan_complete"
              : kind === "review" ? "malahor_plan_review" : "malahor_plan_run";
          await host.permission.assert({
            sessionID,
            action: permissionAction,
            resources: [state.digest],
            save: [],
          });
        },
      };
      const state = await controlPlan(resolved.scope, action, adapter, authority);
      await host.session.synthetic({ sessionID, text: renderPlan(state) });
    },
  }));
}
