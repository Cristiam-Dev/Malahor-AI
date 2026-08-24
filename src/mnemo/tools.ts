import { contextForProject, getObservation, listProjects, saveObservation, saveSessionSummary, searchObservations, type ObservationType } from "./db";

export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export const toolDefinitions = [
  {
    name: "mem_save",
    description: "Guarda una decision, bug, patron o aprendizaje en memoria persistente.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        type: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: "string" },
      },
      required: ["project", "title", "content"],
    },
  },
  {
    name: "mem_search",
    description: "Busca en memoria por keywords.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project: { type: "string" },
        type: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "mem_get",
    description: "Detalle completo de una observacion por ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "mem_context",
    description: "Contexto reciente del proyecto.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        limit: { type: "number" },
      },
      required: ["project"],
    },
  },
  {
    name: "mem_session_summary",
    description: "Guarda resumen de la sesion actual.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        summary: { type: "string" },
      },
      required: ["project", "summary"],
    },
  },
  {
    name: "mem_list_projects",
    description: "Lista proyectos con memoria guardada.",
    inputSchema: { type: "object", properties: {} },
  },
];

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
    case "mem_session_summary":
      return saveSessionSummary(stringArg(args.project), stringArg(args.summary));
    case "mem_list_projects":
      return listProjects();
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

function stringArg(value: unknown, fallback?: string): string {
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error("Expected string argument");
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function observationTypeArg(value: unknown): ObservationType {
  const allowed: ObservationType[] = ["decision", "bug", "pattern", "architecture", "learning", "general"];
  return allowed.includes(value as ObservationType) ? (value as ObservationType) : "general";
}
