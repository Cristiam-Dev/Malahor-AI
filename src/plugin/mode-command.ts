import { loadConfig } from "../cli/core/config";
import { resolveRegisteredProject, rootsForProject } from "../cli/core/context";
import { MODE_CHANGE_ACTION, modeName, parseModeName, previewModeChange, applyModeChange } from "../cli/core/mode";
import { assertModeWriteAllowed } from "../cli/core/mode-hooks";
import type { PluginAdapterOptions } from "../cli/core/hooks/plugin-adapter";

interface ModeInvocation {
  sessionID: string;
  prompt: { text: string; files?: unknown[]; agents?: unknown[]; skills?: unknown[] };
  delivery: "steer" | "queue";
}

export interface ModeCommandHost {
  command: { transform: (callback: (editor: { add: (definition: {
    name: string; description: string; execute: (input: ModeInvocation) => Promise<void>;
  }) => void }) => void) => Promise<{ dispose?: () => Promise<void> | void } | void> };
  session: { synthetic: (input: { sessionID: string; text: string }) => Promise<unknown> };
  permission: { assert: (input: {
    sessionID: string; action: string; resources: string[]; save: string[];
  }) => Promise<unknown> };
}

/** Slash command V2: usa argumentos estructurados, nunca interpolados en una shell. */
export async function registerModeCommand(host: ModeCommandHost, options: PluginAdapterOptions) {
  return host.command.transform((editor) => editor.add({
    name: "malahor-modo", description: "Consultar o cambiar el modo de Malahor con confirmacion nativa",
    execute: async ({ sessionID, prompt }) => {
      if (!prompt || typeof prompt.text !== "string" || prompt.files?.length || prompt.agents?.length || prompt.skills?.length) {
        throw new Error("El comando de modo solo acepta argumentos de texto, sin adjuntos.");
      }
      const directory = await options.resolveSessionDirectory?.(sessionID);
      if (!directory) throw new Error("Sesion sin ubicacion verificable; modo no disponible.");
      const env = { ...(options.env ?? process.env), MALAHOR_OPENCODE_DETECT: "0" };
      const config = loadConfig(env, directory);
      const project = resolveRegisteredProject(config.paths, config.projects.aliases);
      if (!rootsForProject(config.paths.projectsFile, project.canonicalKey).includes(project.root)) {
        throw new Error("El comando de modo requiere un proyecto registrado.");
      }
      const args = prompt.text.trim().replace(/^\/?malahor-modo(?:\s+|$)/, "").trim().split(/\s+/).filter(Boolean);
      const action = args[0] ?? "status";
      let message: string;
      if (action === "status" && args.length <= 1) {
        message = `Modo efectivo: ${modeName(config.execution.intervention)} (${config.execution.intervention}). Archivo: ${config.paths.configFile}`;
      } else if (action === "preview" && args.length === 2) {
        const plan = previewModeChange(parseModeName(args[1]), env, directory);
        message = plan.changes.length
          ? `Modo actual: ${plan.current}; propuesto: ${plan.target}. ${plan.changes.join(" ")}\nArchivo: ${plan.configFile}\nPara aplicar: /malahor-modo ${plan.target}`
          : `Modo ${plan.target} ya persistido. Sin cambios.`;
      } else if (args.length === 1) {
        const target = parseModeName(action);
        const plan = previewModeChange(target, env, directory);
        if (plan.changes.length === 0) {
          message = `Modo ${plan.target} ya persistido. Sin cambios.`;
        } else {
          await host.permission.assert({
            sessionID, action: MODE_CHANGE_ACTION,
            resources: [plan.configFile, plan.current, plan.target], save: [],
          });
          const result = applyModeChange(target, plan.version, (file, backups) =>
            assertModeWriteAllowed(file, backups, directory, env, "opencode"), env, directory);
          message = `Modo persistido: ${result.mode}. Archivo: ${result.configFile}. Respaldo: ${result.backup ?? "archivo nuevo"}. Activo desde el siguiente turno de esta misma sesion; los planes anteriores quedaron invalidados.`;
        }
      } else {
        throw new Error("Uso: /malahor-modo [status | preview <asesor|asistente|ejecutor> | asesor|asistente|ejecutor]");
      }
      await host.session.synthetic({ sessionID, text: message });
    },
  }));
}
