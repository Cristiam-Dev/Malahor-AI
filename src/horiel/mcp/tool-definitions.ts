import { MEMORY_TYPES, RELATION_TYPES } from "../core/model";
import { HORIEL_LIMITS } from "../core/validation";

export interface HorielJsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  additionalProperties?: boolean;
  properties?: Record<string, HorielJsonSchema>;
  required?: string[];
  items?: HorielJsonSchema;
  enum?: readonly unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
}

export interface HorielToolDefinition {
  name: string;
  description: string;
  inputSchema: HorielJsonSchema;
}

const identifier = (prefix: "mem" | "prv" | "snp"): HorielJsonSchema => ({
  type: "string",
  pattern: `^${prefix}_[a-f0-9]{32}$`,
});

const scope: HorielJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
};

const memoryType: HorielJsonSchema = {
  type: "string",
  enum: MEMORY_TYPES,
};

const relationType: HorielJsonSchema = {
  type: "string",
  enum: RELATION_TYPES,
};

const tags: HorielJsonSchema = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.tagBytes },
  minItems: 0,
  maxItems: HORIEL_LIMITS.tags,
  uniqueItems: true,
};

const provenance: HorielJsonSchema = objectSchema({
  source: { type: "string", minLength: 1, maxLength: 64 },
  sessionRef: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.sessionRefCharacters },
  externalRef: { type: "string", minLength: 1, maxLength: 512 },
}, ["source"]);

const checkpointList: HorielJsonSchema = {
  type: "array",
  items: { type: "string", maxLength: HORIEL_LIMITS.checkpointItemBytes },
  minItems: 0,
  maxItems: HORIEL_LIMITS.checkpointItems,
};

const contextProperties: Record<string, HorielJsonSchema> = {
  scope,
  rollup: { type: "boolean" },
  includeGlobal: { type: "boolean" },
  budgetBytes: { type: "integer", minimum: 1, maximum: HORIEL_LIMITS.budgetBytes },
  limit: { type: "integer", minimum: 1, maximum: HORIEL_LIMITS.pageSize },
};

const searchProperties: Record<string, HorielJsonSchema> = {
  scope,
  query: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.queryBytes },
  includeAncestors: { type: "boolean" },
  rollup: { type: "boolean" },
  includeGlobal: { type: "boolean" },
  types: {
    type: "array",
    items: memoryType,
    minItems: 1,
    maxItems: MEMORY_TYPES.length,
    uniqueItems: true,
  },
  tags,
  limit: { type: "integer", minimum: 1, maximum: HORIEL_LIMITS.pageSize },
  cursor: { type: "string", minLength: 1, maxLength: 1_024 },
};

export const horielToolDefinitions: HorielToolDefinition[] = [
  tool("memory_backup", "Create a verified Horiel snapshot.", objectSchema({}, [])),
  tool("memory_brief", "Build a bounded memory brief for one scope.", objectSchema({
    ...contextProperties,
    query: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.queryBytes },
    relatedLimit: { type: "integer", minimum: 1, maximum: HORIEL_LIMITS.pageSize },
  }, ["scope", "query"])),
  tool("memory_context", "Read bounded hierarchical context.", objectSchema(contextProperties, ["scope"])),
  tool("memory_delete_project", "Apply a previously previewed scope deletion.", objectSchema({
    previewId: identifier("prv"),
    confirmation: { type: "string", minLength: 1, maxLength: 512 },
  }, ["previewId", "confirmation"])),
  tool("memory_delete_project_preview", "Preview deletion of one exact scope.", objectSchema({
    project: scope,
  }, ["project"])),
  tool("memory_get", "Read one memory by opaque identifier.", objectSchema({
    id: identifier("mem"),
    version: { type: "integer", minimum: 1 },
  }, ["id"])),
  tool("memory_inspect_project", "Inspect one exact scope.", objectSchema({
    project: scope,
  }, ["project"])),
  tool("memory_link", "Create an idempotent relation between memories.", objectSchema({
    sourceId: identifier("mem"),
    targetId: identifier("mem"),
    type: relationType,
  }, ["sourceId", "targetId", "type"])),
  tool("memory_list_projects", "List project roots present in the canonical store.", objectSchema({}, [])),
  tool("memory_move", "Apply a previously previewed memory move.", objectSchema({
    previewId: identifier("prv"),
    confirmation: { type: "string", minLength: 1, maxLength: 512 },
  }, ["previewId", "confirmation"])),
  tool("memory_move_preview", "Preview moving a memory to another scope.", objectSchema({
    id: identifier("mem"),
    destinationScope: scope,
  }, ["id", "destinationScope"])),
  tool("memory_pin", "Pin a memory.", objectSchema({ id: identifier("mem") }, ["id"])),
  tool("memory_promote", "Apply a previously previewed promotion.", objectSchema({
    previewId: identifier("prv"),
    confirmation: { type: "string", minLength: 1, maxLength: 512 },
  }, ["previewId", "confirmation"])),
  tool("memory_promote_preview", "Preview promotion to a strict ancestor.", objectSchema({
    id: identifier("mem"),
    ancestor: scope,
  }, ["id", "ancestor"])),
  tool("memory_restore", "Apply a previously previewed snapshot restore.", objectSchema({
    previewId: identifier("prv"),
    confirmation: { type: "string", minLength: 1, maxLength: 512 },
  }, ["previewId", "confirmation"])),
  tool("memory_restore_preview", "Preview restoration of one snapshot.", objectSchema({
    snapshotId: identifier("snp"),
  }, ["snapshotId"])),
  tool("memory_save", "Create or replay one idempotent memory.", objectSchema({
    scope,
    type: memoryType,
    title: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.titleCharacters },
    content: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.contentBytes },
    tags,
    idempotencyKey: {
      type: "string",
      minLength: 8,
      maxLength: HORIEL_LIMITS.idempotencyCharacters,
    },
    provenance,
  }, ["scope", "type", "title", "content", "idempotencyKey"])),
  tool("memory_search", "Search ranked memories in one hierarchy.", objectSchema(searchProperties, ["scope", "query"])),
  tool("memory_session_summary", "Save an idempotent structured session checkpoint.", objectSchema({
    scope,
    sessionRef: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.sessionRefCharacters },
    idempotencyKey: {
      type: "string",
      minLength: 8,
      maxLength: HORIEL_LIMITS.idempotencyCharacters,
    },
    objective: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.checkpointItemBytes },
    implemented: checkpointList,
    verified: checkpointList,
    pending: checkpointList,
    decisions: checkpointList,
    blockers: checkpointList,
    validations: checkpointList,
    nextStep: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.checkpointItemBytes },
  }, [
    "scope", "sessionRef", "idempotencyKey", "objective", "implemented", "verified",
    "pending", "decisions", "blockers", "validations", "nextStep",
  ])),
  tool("memory_tree", "List exact scope summaries.", objectSchema({ prefix: scope }, [])),
  tool("memory_unlink", "Remove a relation between memories.", objectSchema({
    sourceId: identifier("mem"),
    targetId: identifier("mem"),
    type: relationType,
  }, ["sourceId", "targetId", "type"])),
  tool("memory_unpin", "Remove a memory pin.", objectSchema({ id: identifier("mem") }, ["id"])),
  tool("memory_update", "Update one memory with optimistic concurrency.", {
    ...objectSchema({
      id: identifier("mem"),
      expectedVersion: { type: "integer", minimum: 1 },
      type: memoryType,
      title: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.titleCharacters },
      content: { type: "string", minLength: 1, maxLength: HORIEL_LIMITS.contentBytes },
      tags,
      provenance,
    }, ["id", "expectedVersion"]),
    minProperties: 3,
  }),
];

function tool(name: string, description: string, inputSchema: HorielJsonSchema): HorielToolDefinition {
  return { name, description, inputSchema };
}

function objectSchema(
  properties: Record<string, HorielJsonSchema>,
  required: string[],
): HorielJsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}
