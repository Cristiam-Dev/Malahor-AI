import {
  HorielError,
  type HorielCore,
  type HorielErrorCode,
} from "../core";
import type { HookEvent } from "../../cli/core/hooks/types";
import type { HorielGuard, HorielGuardRequest, HorielGuardResult } from "../integration/guardrails";
import {
  horielToolDefinitions,
  type HorielJsonSchema,
} from "./tool-definitions";

export interface HorielDispatchEnvelope {
  approval?: string;
}

export interface HorielToolDispatcher {
  (
    name: string,
    args: Record<string, unknown>,
    envelope?: HorielDispatchEnvelope,
  ): Promise<unknown>;
  dispatch(
    name: string,
    args: Record<string, unknown>,
    envelope?: HorielDispatchEnvelope,
  ): Promise<unknown>;
  call(
    name: string,
    args: Record<string, unknown>,
    envelope?: HorielDispatchEnvelope,
  ): Promise<unknown>;
}

export function createHorielToolDispatcher(input: {
  core: HorielCore;
  guard?: HorielGuard;
}): HorielToolDispatcher {
  if (!input?.core) throw new TypeError("Horiel dispatcher requires the Core facade.");
  const schemas = new Map(horielToolDefinitions.map((definition) => [definition.name, definition.inputSchema]));

  const dispatch = async (
    name: string,
    args: Record<string, unknown>,
    envelope: HorielDispatchEnvelope = {},
  ): Promise<unknown> => {
    try {
      const schema = schemas.get(name);
      if (!schema) throw new HorielError("invalid_input", "Horiel tool name is not supported.");
      validateSchema(args, schema, "arguments");
      validateToolSpecifics(name, args);
      await authorize(input.guard, guardRequest(name, args, envelope));
      return await callCore(input.core, name, args);
    } catch (error) {
      if (error instanceof HorielError) throw publicHorielError(error);
      throw unavailableError();
    }
  };

  return Object.assign(dispatch, { dispatch, call: dispatch });
}

async function callCore(core: HorielCore, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "memory_save": return await core.saveMemory(args as never);
    case "memory_update": return await core.updateMemory(args as never);
    case "memory_get": return await core.getMemory(args as never);
    case "memory_search": return await core.searchMemory(args as never);
    case "memory_context": return await core.getContext(args as never);
    case "memory_brief": return await core.getBrief(args as never);
    case "memory_session_summary": return await core.saveSessionCheckpoint(args as never);
    case "memory_tree": return await core.listTree(args as never);
    case "memory_inspect_project": return await core.inspectScope({ scope: args.project as string });
    case "memory_pin": return await core.pinMemory(args as never);
    case "memory_unpin": return await core.unpinMemory(args as never);
    case "memory_link": return await core.linkMemory(args as never);
    case "memory_unlink": return await core.unlinkMemory(args as never);
    case "memory_move_preview": return await core.previewMove(args as never);
    case "memory_move": return await core.moveMemory(args as never);
    case "memory_promote_preview": return await core.previewPromote(args as never);
    case "memory_promote": return await core.promoteMemory(args as never);
    case "memory_backup": return await core.createBackup();
    case "memory_delete_project_preview": return await core.previewDeleteScope({ scope: args.project as string });
    case "memory_delete_project": return await core.deleteScope(args as never);
    case "memory_restore_preview": return await core.previewRestore(args as never);
    case "memory_restore": return await core.restore(args as never);
    case "memory_list_projects": {
      const tree = await core.listTree();
      const projects = [...new Set(tree.nodes
        .map((node) => node.scope)
        .filter((value) => value !== "@global")
        .map((value) => value.split("/")[0])
        .filter((value): value is string => Boolean(value)))]
        .sort((left, right) => left.localeCompare(right));
      return { projects, storeId: tree.storeId, sequence: tree.sequence };
    }
    default:
      throw new HorielError("invalid_input", "Horiel tool name is not supported.");
  }
}

function validateToolSpecifics(name: string, args: Record<string, unknown>): void {
  if (name === "memory_update") {
    const mutable = ["type", "title", "content", "tags", "provenance"];
    if (!mutable.some((key) => args[key] !== undefined)) {
      throw new HorielError("invalid_input", "Memory update requires at least one change.");
    }
  }
}

function guardRequest(
  name: string,
  args: Record<string, unknown>,
  envelope: HorielDispatchEnvelope,
): HorielGuardRequest | undefined {
  const event = guardEvent(name);
  if (!event) return undefined;
  const scope = typeof args.scope === "string" ? args.scope
    : typeof args.project === "string" ? args.project
      : typeof args.destinationScope === "string" ? args.destinationScope
        : typeof args.ancestor === "string" ? args.ancestor : undefined;
  const confirmation = typeof args.confirmation === "string" ? args.confirmation : undefined;
  const previewToken = typeof args.previewId === "string" ? args.previewId : undefined;
  return {
    event,
    approval: envelope.approval,
    confirmation,
    memoryScope: scope,
    metadata: {
      ...(previewToken ? { previewToken } : {}),
      ...(confirmation ? { requiresConfirmation: confirmation } : {}),
    },
  };
}

function guardEvent(name: string): HookEvent | undefined {
  if ([
    "memory_save", "memory_update", "memory_session_summary", "memory_pin", "memory_unpin",
    "memory_link", "memory_unlink", "memory_backup",
  ].includes(name)) return "memory.write.before";
  if (name === "memory_delete_project_preview") return "memory.delete.preview";
  if (name === "memory_delete_project") return "memory.delete.apply";
  if (name === "memory_move_preview" || name === "memory_promote_preview") return "memory.move.preview";
  if (name === "memory_move" || name === "memory_promote") return "memory.move.apply";
  if (name === "memory_restore_preview") return "memory.restore.preview";
  if (name === "memory_restore") return "memory.restore.apply";
  return undefined;
}

async function authorize(guard: HorielGuard | undefined, request: HorielGuardRequest | undefined): Promise<void> {
  if (!guard || !request) return;
  let result: HorielGuardResult;
  if (typeof guard === "function") result = await guard(request);
  else if (typeof guard.authorize === "function") result = await guard.authorize(request);
  else if (typeof guard.check === "function") result = await guard.check(request);
  else throw unavailableError();
  if (!result || result.decision !== "allow") {
    throw new HorielError("unavailable", "Horiel operation is not authorized.");
  }
}

function validateSchema(value: unknown, schema: HorielJsonSchema, label: string): void {
  if (schema.type === "object") {
    if (!isRecord(value)) invalid(label);
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false
      && Object.keys(record).some((key) => !(key in properties))) invalid(label);
    for (const required of schema.required ?? []) {
      if (!(required in record) || record[required] === undefined) invalid(label);
    }
    if (schema.minProperties !== undefined && Object.keys(record).length < schema.minProperties) invalid(label);
    for (const [key, member] of Object.entries(record)) {
      const child = properties[key];
      if (child && member !== undefined) validateSchema(member, child, `${label}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) invalid(label);
    const array = value as unknown[];
    if (schema.minItems !== undefined && array.length < schema.minItems) invalid(label);
    if (schema.maxItems !== undefined && array.length > schema.maxItems) invalid(label);
    if (schema.uniqueItems && new Set(array.map((item) => JSON.stringify(item))).size !== array.length) invalid(label);
    if (schema.items) array.forEach((item, index) => validateSchema(item, schema.items!, `${label}.${index}`));
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") invalid(label);
    const text = value as string;
    if (schema.minLength !== undefined && [...text].length < schema.minLength) invalid(label);
    if (schema.maxLength !== undefined && [...text].length > schema.maxLength) invalid(label);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(text)) invalid(label);
  } else if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid(label);
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) invalid(label);
  } else if (schema.type === "boolean" && typeof value !== "boolean") invalid(label);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) invalid(label);
    if (schema.maximum !== undefined && value > schema.maximum) invalid(label);
  }
  if (schema.enum && !schema.enum.includes(value)) invalid(label);
}

function invalid(label: string): never {
  throw new HorielError("invalid_input", `Horiel ${label} are invalid.`);
}

function unavailableError(): HorielError {
  return new HorielError("unavailable", "Horiel integration is unavailable.");
}

function publicHorielError(error: HorielError): HorielError {
  const messages: Record<HorielErrorCode, string> = {
    invalid_input: "Horiel input is invalid.",
    not_found: "Horiel record was not found.",
    conflict: "Horiel operation conflicts with current state.",
    busy: "Horiel store is busy.",
    unavailable: "Horiel integration is unavailable.",
    capability_missing: "A required Horiel capability is unavailable.",
    unsafe_path: "Horiel path validation failed.",
    integrity_failed: "Horiel integrity validation failed.",
    future_schema: "Horiel schema is newer than this runtime.",
    budget_exceeded: "Horiel response budget was exceeded.",
    confirmation_mismatch: "Horiel confirmation does not match its preview.",
  };
  return new HorielError(error.code, messages[error.code]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function horielErrorCode(error: unknown): HorielErrorCode {
  return error instanceof HorielError ? error.code : "unavailable";
}
