import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { Schema } from "effect";

import { classifyInfrastructurePath } from "../cli/core/infrastructure-boundary";
import { resolvePaths } from "../cli/core/paths";
import { writeCodeModeAudit } from "../cli/core/hooks/audit";
import { evaluateToolHook, type PluginAdapterOptions } from "../cli/core/hooks/plugin-adapter";
import { loadHookPolicy } from "../cli/core/hooks/policy-loader";
import { detectPayloadSecretKinds, isPotentialSecretPath } from "../cli/core/hooks/secret-scan";
import type { HookContext } from "../cli/core/hooks/types";
import {
  canonicalCodeModeJson,
  CodeModeBoundaryError,
  codeModeUtf8Bytes,
  sanitizeCodeModeBoundary,
  type CodeModeJson,
} from "./code-mode-redaction";
import {
  CODE_MODE_FAILURE_CODES,
  CODE_MODE_LIMITS,
  CODE_MODE_LOGICAL_TOOLS,
  CODE_MODE_RESOURCE_LIMITS,
  CODE_MODE_RPC_VERSION,
  type CodeModeFailureCode,
  type CodeModeLogicalTool,
} from "./code-mode-worker";

export type { CodeModeFailureCode } from "./code-mode-worker";

export interface CodeModeToolCall {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  abort?: AbortSignal;
  signal?: AbortSignal;
}

type HostOutputKind = "text" | "text-parts" | "glob-paths" | "grep-matches";

interface HostOutputAdapter {
  source: "direct" | "field" | "runtime-default" | "tagged-text" | "read-text" | "glob-entries" | "grep-entries";
  field?: "output" | "content";
  kind: HostOutputKind;
  allowedKeys: readonly string[];
  variant?: string;
  deniedVariants?: readonly string[];
}

interface HostToolDefinition {
  id: string;
  name: string;
  description: string;
  inputContract: CodeModeJson;
  outputContract: CodeModeJson;
  outputAdapter: HostOutputAdapter;
  optionsContract: CodeModeJson;
  executeIdentity: (input: unknown, call: Record<string, unknown>) => unknown;
  execute(input: unknown, call: Record<string, unknown>): unknown;
}

interface CodeModeToolEditor {
  namespace(input: { name: string; description: string }): void;
  add(input: Record<string, unknown>): void;
  list(): unknown;
  get(name: string): unknown;
}

export interface CodeModeToolDomain {
  transform(callback: (editor: CodeModeToolEditor) => void): Promise<{ dispose?: () => Promise<void> | void } | void>;
  list(): Promise<unknown>;
}

export interface CodeModePermissionPort {
  assert(input: {
    sessionID: string;
    agent: string;
    source: { type: "tool"; messageID: string; id: string };
    action: string;
    resources: string[];
    save: string[];
  }): Promise<unknown>;
}

export interface CodeModeRegistrationOptions {
  moduleURL: string;
  workerSource?: () => string;
  runSandbox?: typeof executeCodeModeSandbox;
  randomRef?: (prefix: "cat" | "exec") => string;
  onAvailability?: (available: boolean, reason?: string) => void;
}

export interface CodeModeRegistration {
  dispose?: () => Promise<void> | void;
  catalogHash: string;
  readonly available: boolean;
}

interface CapturedTool {
  logical: CodeModeLogicalTool;
  hostName: CodeModeLogicalTool;
  definition: HostToolDefinition;
  fingerprint: string;
}

interface CapturedCatalog {
  tools: Map<CodeModeLogicalTool, CapturedTool>;
  hash: string;
}

interface CatalogGeneration extends CapturedCatalog {
  id: number;
  active: boolean;
  retiredCode?: CodeModeFailureCode;
}

interface CatalogRuntime {
  current?: CatalogGeneration;
  readCurrent(): Promise<unknown>;
}

interface CodeModeScope {
  sessionID: string;
  project: string;
  root: string;
  realRoot: string;
  policyHash: string;
  hookContext: HookContext;
}

interface CatalogGrant {
  call: CodeModeToolCall;
  scope: CodeModeScope;
  generation: CatalogGeneration;
  catalogHash: string;
  tools: CodeModeLogicalTool[];
}

interface PublicCall {
  tool: string;
  status: "completed" | "denied" | "error";
}

interface PublicExecutionResult {
  ok: boolean;
  value?: CodeModeJson;
  error?: { kind: CodeModeFailureCode; message: string };
  executionRef: string;
  calls: PublicCall[];
  redacted: boolean;
  truncated: boolean;
}

interface WorkerCallMessage {
  version: 1;
  type: "call";
  executionRef: string;
  callID: string;
  index: number;
  tool: CodeModeLogicalTool;
  input: unknown;
}

interface WorkerFinishMessage {
  version: 1;
  type: "finish";
  executionRef: string;
  result: unknown;
  redacted: boolean;
  redactions: string[];
  truncated: boolean;
}

interface SandboxResult {
  result: unknown;
  redacted: boolean;
  redactions: string[];
  truncated: boolean;
}

interface SandboxOptions {
  source: string;
  code: string;
  executionRef: string;
  tools: CodeModeLogicalTool[];
  signal?: AbortSignal;
  onCall(message: WorkerCallMessage, signal: AbortSignal): Promise<BrokerResponse>;
}

interface BrokerResponse {
  ok: boolean;
  value?: CodeModeJson;
  error?: { code: CodeModeFailureCode; message: string };
}

const CATALOG_CAPACITY = 128;
const MAX_WORKER_ARTIFACT_BYTES = 32 * 1024 * 1024;
const TOOL_SIGNATURES: Record<CodeModeLogicalTool, string> = {
  read: "tools.repo.read({ path: string; offset?: number; limit?: number }): Promise<unknown>",
  glob: "tools.repo.glob({ pattern: string; path?: string; limit?: number }): Promise<unknown>",
  grep: "tools.repo.grep({ pattern: string; path?: string; include?: string; literal?: boolean; caseSensitive?: boolean; limit?: number }): Promise<unknown>",
};
const TOOL_DESCRIPTIONS: Record<CodeModeLogicalTool, string> = {
  read: "Lectura acotada de texto UTF-8 dentro del proyecto registrado.",
  glob: "Busqueda acotada de paths relativos, sin ocultos ni symlinks.",
  grep: "Busqueda acotada de coincidencias de texto dentro del proyecto.",
};

export async function registerReadOnlyCodeModeTools(
  domain: CodeModeToolDomain,
  permission: CodeModePermissionPort,
  storage: unknown,
  adapter: PluginAdapterOptions,
  registration: CodeModeRegistrationOptions,
): Promise<CodeModeRegistration> {
  if (!storage || typeof storage !== "object") throw new Error("ctx.storage no disponible para Code Mode R0.");
  if (typeof domain.list !== "function") throw new Error("ctx.tool.list no disponible para Code Mode R0.");
  if (!adapter.resolveSessionProject || adapter.toolRegistered !== true || adapter.permissionRegistered !== true) {
    throw new Error("Faltan scope, tool hook o permission hook para Code Mode R0.");
  }

  const grants = new Map<string, CatalogGrant>();
  const invalidatedCatalogRefs = new Set<string>();
  const activeExecutions = new Map<string, ActiveExecution>();
  const preflight = captureCatalog(await domain.list());
  const catalogRuntime: CatalogRuntime = { readCurrent: () => domain.list() };
  let generationSequence = 0;
  let transformSettled = false;
  let publishedGeneration = false;
  let available = false;
  let disposed = false;
  const randomRef = registration.randomRef ?? defaultRandomRef;
  const runSandbox = registration.runSandbox ?? executeCodeModeSandbox;
  const workerSource = registration.workerSource?.() ?? readWorkerArtifact(registration.moduleURL);
  validateWorkerSource(workerSource);
  await probeCodeModeSandbox(workerSource, runSandbox);
  const notifyAvailability = (next: boolean, reason?: string): void => {
    if (available === next) return;
    available = next;
    registration.onAvailability?.(next, reason);
  };
  const rememberInvalidatedRef = (catalogRef: string): void => {
    invalidatedCatalogRefs.add(catalogRef);
    while (invalidatedCatalogRefs.size > CATALOG_CAPACITY) {
      invalidatedCatalogRefs.delete(invalidatedCatalogRefs.values().next().value as string);
    }
  };
  const retireCurrentGeneration = (code: CodeModeFailureCode, preserveRefs: boolean): void => {
    const current = catalogRuntime.current;
    if (!current) return;
    current.active = false;
    current.retiredCode = code;
    catalogRuntime.current = undefined;
    for (const [catalogRef, grant] of grants) {
      if (grant.generation !== current) continue;
      if (preserveRefs) rememberInvalidatedRef(catalogRef);
      grants.delete(catalogRef);
    }
    for (const active of activeExecutions.values()) {
      if (active.generationID === current.id) active.abort(code);
    }
  };

  let transformed: Awaited<ReturnType<CodeModeToolDomain["transform"]>>;
  try {
    transformed = await domain.transform((editor) => {
      retireCurrentGeneration("CATALOG_DRIFT", true);
      try {
        if (disposed) return;
        const snapshot = captureEditorCatalog(editor, preflight);
        const generation: CatalogGeneration = {
          ...snapshot,
          id: ++generationSequence,
          active: true,
        };
        catalogRuntime.current = generation;
        publishedGeneration = true;

        editor.namespace({ name: "malahor", description: "Gateways first-party de Malahor" });
        editor.add({
          name: "code_search",
          description: "Busca firmas dentro del catalogo R0 gestionado (read, glob y grep) y emite una referencia de un solo uso ligada al request.",
          input: {
            type: "object",
            properties: { query: { type: "string", minLength: 1, maxLength: 160 } },
            required: ["query"],
            additionalProperties: false,
          },
          options: { namespace: "malahor", codemode: false },
          execute: async (value: unknown, call: CodeModeToolCall) => {
            if (disposed) throw new CodeModeExecutionError("SANDBOX_FAILURE");
            const query = validateSearchInput(value);
            const scope = await resolveCodeModeScope(call, adapter);
            const catalog = await requireStableCatalog(generation, catalogRuntime);
            const tools = searchCatalog(query);
            if (tools.length === 0) {
              return toolResult({ items: [], classification: "read-only", limits: visibleLimits() }, "malahor.code.search", 0);
            }
            pruneGrants(grants, call);
            const catalogRef = randomRef("cat");
            invalidatedCatalogRefs.delete(catalogRef);
            grants.set(catalogRef, {
              call: normalizedCall(call),
              scope,
              generation,
              catalogHash: catalog.hash,
              tools,
            });
            const items = tools.map((name) => ({
              path: `tools.repo.${name}`,
              description: TOOL_DESCRIPTIONS[name],
              signature: TOOL_SIGNATURES[name],
              classification: "read-only",
            }));
            return toolResult({ catalogRef, items, classification: "read-only", limits: visibleLimits() }, "malahor.code.search", items.length);
          },
        });
        editor.add({
          name: "code_execute",
          description: "Ejecuta JavaScript confinado sobre una referencia R0 de un solo uso. No expone shell, red, Git, MCP, memoria, documentacion ni mutaciones.",
          input: {
            type: "object",
            properties: {
              catalogRef: { type: "string", pattern: "^cat_[A-Za-z0-9_-]{16,128}$" },
              code: { type: "string", minLength: 1, maxLength: CODE_MODE_LIMITS.codeBytes },
            },
            required: ["catalogRef", "code"],
            additionalProperties: false,
          },
          options: { namespace: "malahor", codemode: false },
          execute: async (value: unknown, call: CodeModeToolCall) => {
            const executionRef = randomRef("exec");
            let current: CodeModeScope | undefined;
            let grant: CatalogGrant | undefined;
            let parsed: { catalogRef: string; code: string } | undefined;
            let beforeWritten = false;
            let programHash = sha256(typeof (value as Record<string, unknown> | null)?.code === "string"
              ? String((value as Record<string, unknown>).code)
              : "invalid-code-mode-input");

            const writeExecutionBefore = (decision: "allow" | "deny" | "error"): boolean => {
              if (!current) return false;
              const audit = writeCodeModeAudit(current.hookContext, {
                phase: "execution.before",
                sessionID: call.sessionID,
                messageID: call.messageID,
                executionRef,
                programHash,
                decision,
              }, { required: true });
              beforeWritten = audit.ok;
              return audit.ok;
            };
            const finish = async (candidate: PublicExecutionResult): Promise<ReturnType<typeof executionToolResult>> => {
              if (!current || !beforeWritten) {
                return executionToolResult(failureResult(executionRef, current ? "AUDIT_UNAVAILABLE" : "SCOPE_DRIFT", candidate.calls, true));
              }

              let result = candidate;
              try {
                const latest = await resolveCodeModeScope(call, adapter);
                assertSameScope(current, latest);
                await requireStableCatalog(generation, catalogRuntime);
                current = latest;
              } catch (error) {
                result = failureResult(executionRef, failureCode(error), candidate.calls, true, candidate.truncated);
              }

              let sanitized: { value: PublicExecutionResult; json: CodeModeJson; redacted: boolean };
              try {
                sanitized = sanitizePublicResult(result, current.root);
              } catch (error) {
                sanitized = sanitizePublicResult(
                  failureResult(executionRef, failureCode(error), result.calls, true, result.truncated),
                  current.root,
                );
              }
              if (sanitized.redacted && !sanitized.value.redacted) {
                sanitized = sanitizePublicResult({ ...sanitized.value, redacted: true }, current.root);
              }
              const output = sanitized.value;
              const encoded = canonicalCodeModeJson(sanitized.json);
              const after = writeCodeModeAudit(current.hookContext, {
                phase: "execution.after",
                sessionID: call.sessionID,
                messageID: call.messageID,
                executionRef,
                programHash,
                decision: output.ok === true ? "completed" : output.error?.kind === "CANCELLED" ? "cancelled" : "error",
                outputHash: sha256(encoded),
                resultClass: output.ok === true ? "success" : output.error?.kind,
                quota: output.error?.kind === "QUOTA_EXCEEDED" ? "security-limit" : undefined,
                outputBytes: codeModeUtf8Bytes(encoded),
                callCount: output.calls.length,
                redacted: output.redacted,
              }, { required: true });
              if (!after.ok) return executionToolResult(failureResult(executionRef, "AUDIT_UNAVAILABLE", output.calls, true));
              return executionToolResult(output);
            };

            try {
              if (disposed) throw new CodeModeExecutionError("SANDBOX_FAILURE");
              parsed = validateExecuteInput(value);
              programHash = sha256(parsed.code);
              grant = grants.get(parsed.catalogRef);
              grants.delete(parsed.catalogRef);
              const invalidated = !grant && invalidatedCatalogRefs.delete(parsed.catalogRef);
              if (!grant || !sameRequest(grant.call, call)) {
                current = await resolveCodeModeScope(call, adapter);
                if (!writeExecutionBefore("deny")) return executionToolResult(failureResult(executionRef, "AUDIT_UNAVAILABLE"));
                return finish(failureResult(executionRef, invalidated ? "CATALOG_DRIFT" : "CATALOG_REF_INVALID"));
              }
              current = grant.scope;
              if (grant.generation !== generation) throw new CodeModeExecutionError("CATALOG_DRIFT");
              if (codeModeUtf8Bytes(parsed.code) > CODE_MODE_LIMITS.codeBytes) {
                if (!writeExecutionBefore("deny")) return executionToolResult(failureResult(executionRef, "AUDIT_UNAVAILABLE"));
                return finish(failureResult(executionRef, "QUOTA_EXCEEDED"));
              }
              current = await resolveCodeModeScope(call, adapter);
              assertSameScope(grant.scope, current);
              const catalog = await requireStableCatalog(generation, catalogRuntime);
              if (catalog.hash !== grant.catalogHash) throw new CodeModeExecutionError("CATALOG_DRIFT");
            } catch (error) {
              current ??= grant?.scope;
              if (!current) {
                try { current = await resolveCodeModeScope(call, adapter); } catch { /* no auditable scope */ }
              }
              if (!writeExecutionBefore("error")) return executionToolResult(failureResult(executionRef, "AUDIT_UNAVAILABLE"));
              return finish(failureResult(executionRef, failureCode(error)));
            }

            if (!writeExecutionBefore("allow")) return executionToolResult(failureResult(executionRef, "AUDIT_UNAVAILABLE"));

            const broker = createBroker({
              call: normalizedCall(call),
              grant,
              scope: current,
              generation,
              catalogRuntime,
              permission,
              adapter,
              executionRef,
              programHash,
            });
            const active = createActiveExecution(callSignal(call), generation.id);
            activeExecutions.set(executionRef, active);
            let publicResult: PublicExecutionResult;
            try {
              const sandbox = await runSandbox({
                source: workerSource,
                code: parsed!.code,
                executionRef,
                tools: grant!.tools,
                signal: active.controller.signal,
                onCall: (message, signal) => broker.handle(message, signal),
              });
              publicResult = active.failure
                ? failureResult(executionRef, active.failure, broker.calls, broker.redacted, broker.truncated)
                : sandboxToPublicResult(sandbox, executionRef, broker.calls, broker.redacted, broker.truncated);
            } catch (error) {
              publicResult = failureResult(executionRef, active.failure ?? failureCode(error), broker.calls, broker.redacted);
            } finally {
              broker.close();
              active.finish();
              activeExecutions.delete(executionRef);
            }
            return finish(publicResult);
          },
        });
        notifyAvailability(true);
      } catch (error) {
        const current = catalogRuntime.current;
        if (current) current.active = false;
        catalogRuntime.current = undefined;
        notifyAvailability(false, error instanceof Error ? error.message : "catalogo R0 incompatible");
        if (error instanceof CatalogCompatibilityError && (transformSettled || publishedGeneration)) return;
        throw error;
      }
    });
  } catch (error) {
    disposed = true;
    retireCurrentGeneration("CANCELLED", false);
    grants.clear();
    invalidatedCatalogRefs.clear();
    for (const active of activeExecutions.values()) active.abort("CANCELLED");
    await waitForActiveExecutions(activeExecutions);
    activeExecutions.clear();
    notifyAvailability(false, error instanceof Error ? error.message : "registro de Code Mode R0 fallido");
    throw error;
  } finally {
    transformSettled = true;
  }

  return {
    catalogHash: preflight.hash,
    get available() { return available; },
    dispose: async () => {
      disposed = true;
      retireCurrentGeneration("CANCELLED", false);
      grants.clear();
      invalidatedCatalogRefs.clear();
      for (const active of activeExecutions.values()) active.abort("CANCELLED");
      await waitForActiveExecutions(activeExecutions);
      activeExecutions.clear();
      if (transformed && typeof transformed.dispose === "function") await transformed.dispose();
    },
  };
}

interface BrokerOptions {
  call: CodeModeToolCall;
  grant: CatalogGrant;
  scope: CodeModeScope;
  generation: CatalogGeneration;
  catalogRuntime: CatalogRuntime;
  permission: CodeModePermissionPort;
  adapter: PluginAdapterOptions;
  executionRef: string;
  programHash: string;
}

interface ResourceLease {
  verify(): void;
  close(): void;
}

interface BrokerCallAuditState {
  scope: CodeModeScope;
  inputHash: string;
  inputBytes: number;
  ruleIds: string[];
  beforeWritten: boolean;
  afterWritten?: boolean;
  resource?: ResourceLease;
}

interface ActiveExecution {
  generationID: number;
  controller: AbortController;
  readonly failure?: CodeModeFailureCode;
  settled: Promise<void>;
  abort(code: CodeModeFailureCode): void;
  finish(): void;
}

function createBroker(options: BrokerOptions) {
  let expectedIndex = 0;
  let inFlight = 0;
  let aggregateBytes = 0;
  let closed = false;
  let wasRedacted = false;
  let wasTruncated = false;
  let fatalCode: CodeModeFailureCode | undefined;
  const controllers = new Set<AbortController>();
  const calls: PublicCall[] = [];
  const generationFailure = (): CodeModeFailureCode | undefined =>
    !options.generation.active || options.catalogRuntime.current !== options.generation
      ? options.generation.retiredCode ?? "CATALOG_DRIFT"
      : undefined;

  return {
    calls,
    get redacted() { return wasRedacted; },
    get truncated() { return wasTruncated; },
    async handle(message: WorkerCallMessage, sandboxSignal: AbortSignal): Promise<BrokerResponse> {
      if (closed) throw new CodeModeExecutionError(fatalCode ?? generationFailure() ?? "CANCELLED");
      if (message.executionRef !== options.executionRef || message.index !== expectedIndex
        || message.callID !== `call_${message.index}`) throw new CodeModeExecutionError("SANDBOX_FAILURE");
      expectedIndex += 1;
      const controller = new AbortController();
      controllers.add(controller);
      let abortCode: CodeModeFailureCode = "CANCELLED";
      const abort = () => {
        abortCode = fatalCode ?? generationFailure() ?? "CANCELLED";
        controller.abort();
      };
      const timer = setTimeout(() => {
        abortCode = "QUOTA_EXCEEDED";
        controller.abort();
      }, CODE_MODE_LIMITS.callMs);
      sandboxSignal.addEventListener("abort", abort, { once: true });
      const audit: BrokerCallAuditState = {
        scope: options.scope,
        inputHash: sha256("invalid-code-mode-call"),
        inputBytes: 0,
        ruleIds: [],
        beforeWritten: false,
      };
      inFlight += 1;
      try {
        const operation = executeBrokerCall(message, controller.signal, audit);
        const output = await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            const rejectAbort = () => reject(new CodeModeExecutionError(fatalCode ?? generationFailure() ?? abortCode));
            if (controller.signal.aborted) rejectAbort();
            else controller.signal.addEventListener("abort", rejectAbort, { once: true });
          }),
        ]);
        calls.push({ tool: `repo.${message.tool}`, status: "completed" });
        return { ok: true, value: output };
      } catch (error) {
        let code = failureCode(error);
        code = auditBrokerFailure(message, audit, code);
        calls.push({ tool: `repo.${message.tool}`, status: fatalFailure(code) ? "error" : "denied" });
        if (fatalFailure(code)) {
          latch(code);
          throw new CodeModeExecutionError(code);
        }
        return { ok: false, error: { code, message: publicFailureMessage(code) } };
      } finally {
        clearTimeout(timer);
        sandboxSignal.removeEventListener("abort", abort);
        controllers.delete(controller);
        controller.abort();
        audit.resource?.close();
        inFlight -= 1;
      }
    },
    close() {
      latch(fatalCode ?? "CANCELLED");
    },
  };

  async function executeBrokerCall(
    message: WorkerCallMessage,
    signal: AbortSignal,
    audit: BrokerCallAuditState,
  ): Promise<CodeModeJson> {
    if (expectedIndex > CODE_MODE_LIMITS.maxToolCalls || inFlight > CODE_MODE_LIMITS.maxConcurrentCalls) {
      throw new CodeModeExecutionError("QUOTA_EXCEEDED");
    }
    if (!options.grant.tools.includes(message.tool)) throw new CodeModeExecutionError("TOOL_NOT_DISCOVERED");
    throwIfAborted(signal, fatalCode);
    let current = await resolveCodeModeScope(options.call, options.adapter);
    audit.scope = current;
    assertSameScope(options.scope, current);
    if (current.policyHash !== options.grant.scope.policyHash) throw new CodeModeExecutionError("POLICY_DRIFT");
    const stable = await requireStableCatalog(options.generation, options.catalogRuntime);
    if (stable.hash !== options.grant.catalogHash) throw new CodeModeExecutionError("CATALOG_DRIFT");
    const canonical = canonicalizeCallInput(message.tool, message.input, current.root);
    const boundary = sanitizeCodeModeBoundary(canonical.auditInput, {
      limits: boundaryLimits(CODE_MODE_LIMITS.callInputBytes),
      redactSecrets: false,
      dropHostMetadata: false,
      dropDangerousKeys: false,
      truncate: false,
    });
    audit.inputHash = sha256(canonicalCodeModeJson(boundary.value));
    audit.inputBytes = boundary.bytes;
    if (detectPayloadSecretKinds(JSON.stringify(canonical.auditInput)).length > 0) {
      throw new CodeModeExecutionError("INVALID_INPUT");
    }
    throwIfAborted(signal, fatalCode);
    const hook = await evaluateToolHook({
      sessionID: options.call.sessionID,
      agent: options.call.agent,
      messageID: options.call.messageID,
      id: `${options.call.id}:${message.index}`,
      tool: message.tool,
      input: canonical.hostInput,
    }, options.adapter);
    audit.ruleIds = hook.violations.map((violation) => violation.id);
    if (hook.decision !== "allow") throw new CodeModeExecutionError("PERMISSION_DENIED");
    throwIfAborted(signal, fatalCode);
    try {
      await options.permission.assert({
        sessionID: options.call.sessionID,
        agent: options.call.agent,
        source: { type: "tool", messageID: options.call.messageID, id: `${options.call.id}:${message.index}` },
        action: message.tool,
        resources: canonical.resources,
        save: [],
      });
    } catch {
      throw new CodeModeExecutionError("PERMISSION_DENIED");
    }
    throwIfAborted(signal, fatalCode);
    current = await resolveCodeModeScope(options.call, options.adapter);
    audit.scope = current;
    assertSameScope(options.scope, current);
    const afterPermissionCatalog = await requireStableCatalog(options.generation, options.catalogRuntime);
    if (afterPermissionCatalog.hash !== options.grant.catalogHash) throw new CodeModeExecutionError("CATALOG_DRIFT");
    if (sha256(canonicalCodeModeJson(boundary.value)) !== audit.inputHash) throw new CodeModeExecutionError("INVALID_INPUT");

    const before = writeCodeModeAudit(current.hookContext, {
      phase: "call.before",
      sessionID: options.call.sessionID,
      messageID: options.call.messageID,
      executionRef: options.executionRef,
      programHash: options.programHash,
      decision: "allow",
      tool: message.tool,
      index: message.index,
      inputHash: audit.inputHash,
      ruleIds: audit.ruleIds,
      inputBytes: audit.inputBytes,
    }, { required: true });
    if (!before.ok) throw new CodeModeExecutionError("AUDIT_UNAVAILABLE");
    audit.beforeWritten = true;

    const resource = validateEffectResource(message.tool, canonical, current.root);
    audit.resource = resource;
    try {
      const captured = options.generation.tools.get(message.tool);
      if (!captured) throw new CodeModeExecutionError("CATALOG_DRIFT");
      throwIfAborted(signal, fatalCode);
      const raw = await Promise.resolve(captured.definition.execute(
        canonical.hostInput,
        innerToolCall(options.call, message, signal),
      ));
      throwIfAborted(signal, fatalCode);
      resource.verify();
      const filtered = filterHostOutput(
        message.tool,
        captured.definition.outputAdapter,
        raw,
        current.root,
        canonical.limit,
      );
      const output = sanitizeCodeModeBoundary(filtered.value, {
        limits: boundaryLimits(CODE_MODE_LIMITS.callOutputBytes),
        projectRoot: current.root,
        redactSecrets: true,
        dropHostMetadata: true,
        dropDangerousKeys: true,
        truncate: true,
      });
      aggregateBytes += output.bytes;
      if (aggregateBytes > CODE_MODE_LIMITS.aggregateOutputBytes) throw new CodeModeExecutionError("QUOTA_EXCEEDED");
      wasRedacted ||= output.redacted;
      wasTruncated ||= output.truncated || filtered.truncated;

      const latest = await resolveCodeModeScope(options.call, options.adapter);
      assertSameScope(current, latest);
      const finalCatalog = await requireStableCatalog(options.generation, options.catalogRuntime);
      if (finalCatalog.hash !== options.grant.catalogHash) throw new CodeModeExecutionError("CATALOG_DRIFT");
      const after = writeCodeModeAudit(latest.hookContext, {
        phase: "call.after",
        sessionID: options.call.sessionID,
        messageID: options.call.messageID,
        executionRef: options.executionRef,
        programHash: options.programHash,
        decision: "completed",
        tool: message.tool,
        index: message.index,
        inputHash: audit.inputHash,
        outputHash: sha256(canonicalCodeModeJson(output.value)),
        resultClass: "success",
        inputBytes: audit.inputBytes,
        outputBytes: output.bytes,
        redacted: output.redacted,
      }, { required: true });
      if (!after.ok) throw new CodeModeExecutionError("AUDIT_UNAVAILABLE");
      audit.afterWritten = true;
      return output.value;
    } finally {
      resource.close();
      audit.resource = undefined;
    }
  }

  function auditBrokerFailure(
    message: WorkerCallMessage,
    state: BrokerCallAuditState,
    requested: CodeModeFailureCode,
  ): CodeModeFailureCode {
    if (requested === "AUDIT_UNAVAILABLE") return requested;
    const decision = requested === "CANCELLED" ? "cancelled" : fatalFailure(requested) ? "error" : "deny";
    if (!state.beforeWritten) {
      const before = writeCodeModeAudit(state.scope.hookContext, {
        phase: "call.before",
        sessionID: options.call.sessionID,
        messageID: options.call.messageID,
        executionRef: options.executionRef,
        programHash: options.programHash,
        decision,
        tool: message.tool,
        index: message.index,
        inputHash: state.inputHash,
        ruleIds: state.ruleIds,
        resultClass: requested,
        quota: requested === "QUOTA_EXCEEDED" ? "security-limit" : undefined,
        inputBytes: state.inputBytes,
      }, { required: true });
      if (!before.ok) return "AUDIT_UNAVAILABLE";
      state.beforeWritten = true;
    }
    if (state.afterWritten) return requested;
    const after = writeCodeModeAudit(state.scope.hookContext, {
      phase: "call.after",
      sessionID: options.call.sessionID,
      messageID: options.call.messageID,
      executionRef: options.executionRef,
      programHash: options.programHash,
      decision,
      tool: message.tool,
      index: message.index,
      inputHash: state.inputHash,
      ruleIds: state.ruleIds,
      resultClass: requested,
      quota: requested === "QUOTA_EXCEEDED" ? "security-limit" : undefined,
      inputBytes: state.inputBytes,
    }, { required: true });
    if (!after.ok) return "AUDIT_UNAVAILABLE";
    state.afterWritten = true;
    return requested;
  }

  function latch(code: CodeModeFailureCode): void {
    fatalCode ??= code;
    closed = true;
    for (const controller of controllers) controller.abort();
  }
}

export async function executeCodeModeSandbox(options: SandboxOptions): Promise<SandboxResult> {
  if (codeModeUtf8Bytes(options.code) > CODE_MODE_LIMITS.codeBytes) throw new CodeModeExecutionError("QUOTA_EXCEEDED");
  validateWorkerSource(options.source);
  if (options.signal?.aborted) throw new CodeModeExecutionError("CANCELLED");
  const sourceURL = new URL(`data:text/javascript;base64,${Buffer.from(options.source).toString("base64")}`);
  const worker = new Worker(sourceURL, {
    workerData: { role: "malahor-code-mode-worker", protocol: CODE_MODE_RPC_VERSION },
    argv: [],
    execArgv: [],
    env: {},
    stdout: true,
    stderr: true,
    resourceLimits: CODE_MODE_RESOURCE_LIMITS,
  });
  worker.stdout?.resume();
  worker.stderr?.resume();

  return new Promise<SandboxResult>((resolve, reject) => {
    const calls = new Set<Promise<void>>();
    const controller = new AbortController();
    let settling = false;
    const watchdog = setTimeout(() => void settleError(new CodeModeExecutionError("QUOTA_EXCEEDED")), CODE_MODE_LIMITS.watchdogMs);
    const outerAbort = () => void settleError(new CodeModeExecutionError("CANCELLED"));
    options.signal?.addEventListener("abort", outerAbort, { once: true });

    const cleanup = async (): Promise<void> => {
      clearTimeout(watchdog);
      options.signal?.removeEventListener("abort", outerAbort);
      controller.abort();
      try {
        worker.postMessage({ version: CODE_MODE_RPC_VERSION, type: "cancel", executionRef: options.executionRef });
      } catch { /* worker already closed */ }
      await worker.terminate().catch(() => 0);
      await waitForCallTasks(calls);
    };
    const settleError = async (error: Error): Promise<void> => {
      if (settling) return;
      settling = true;
      await cleanup();
      reject(error);
    };
    const settleResult = async (result: SandboxResult): Promise<void> => {
      if (settling) return;
      settling = true;
      await cleanup();
      resolve(result);
    };

    worker.on("message", (value: unknown) => {
      if (settling) return;
      const call = parseWorkerCall(value, options.executionRef);
      if (call) {
        const task = options.onCall(call, controller.signal).then((response) => {
          if (settling) return;
          worker.postMessage({
            version: CODE_MODE_RPC_VERSION,
            type: "result",
            executionRef: options.executionRef,
            callID: call.callID,
            index: call.index,
            ...response,
          });
        });
        calls.add(task);
        void task.then(
          () => { calls.delete(task); },
          (error) => {
            calls.delete(task);
            void settleError(error instanceof Error ? error : new CodeModeExecutionError("SANDBOX_FAILURE"));
          },
        );
        return;
      }
      const finish = parseWorkerFinish(value, options.executionRef);
      if (finish) {
        if (calls.size > 0) {
          void settleError(new CodeModeExecutionError("SANDBOX_FAILURE"));
          return;
        }
        void settleResult({
          result: finish.result,
          redacted: finish.redacted,
          redactions: finish.redactions,
          truncated: finish.truncated,
        });
        return;
      }
      void settleError(new CodeModeExecutionError("SANDBOX_FAILURE"));
    });
    worker.once("error", () => void settleError(new CodeModeExecutionError("SANDBOX_FAILURE")));
    worker.once("exit", () => {
      if (!settling) void settleError(new CodeModeExecutionError("SANDBOX_FAILURE"));
    });
    try {
      worker.postMessage({
        version: CODE_MODE_RPC_VERSION,
        type: "start",
        executionRef: options.executionRef,
        code: options.code,
        tools: options.tools,
      });
    } catch {
      void settleError(new CodeModeExecutionError("SANDBOX_FAILURE"));
    }
  });
}

function captureCatalog(value: unknown): CapturedCatalog {
  let definitions: Map<string, unknown>;
  try {
    definitions = listedToolDefinitions(value);
  } catch (error) {
    throw new CatalogCompatibilityError(error instanceof Error ? error.message : "ctx.tool.list incompatible.");
  }
  const tools = new Map<CodeModeLogicalTool, CapturedTool>();
  for (const logical of CODE_MODE_LOGICAL_TOOLS) {
    const raw = definitions.get(logical);
    if (!raw) throw new CatalogCompatibilityError(`Tool R0 ausente: ${logical}.`);
    const definition = hostToolDefinition(raw, logical);
    if (!definition) {
      throw new CatalogCompatibilityError(`Tool R0 incompatible: ${logical} (${hostToolCompatibilityIssue(raw, logical)}).`);
    }
    tools.set(logical, {
      logical,
      hostName: logical,
      definition,
      fingerprint: fingerprintTool(logical, definition),
    });
  }
  const hash = catalogHash(tools);
  return { tools, hash };
}

function captureEditorCatalog(editor: CodeModeToolEditor, baseline: CapturedCatalog): CapturedCatalog {
  if (typeof editor.list !== "function" || typeof editor.get !== "function"
    || typeof editor.add !== "function" || typeof editor.namespace !== "function") {
    throw new CatalogCompatibilityError("ctx.tool.transform no expone list/get/add/namespace.");
  }
  const catalog = captureCatalog(editor.list());
  for (const logical of CODE_MODE_LOGICAL_TOOLS) {
    const captured = catalog.tools.get(logical);
    const raw = editor.get(logical);
    const current = hostToolDefinition(raw, logical);
    if (!captured || !current || fingerprintTool(logical, current) !== captured.fingerprint) {
      const issue = current ? "catalog-drift" : hostToolCompatibilityIssue(raw, logical);
      throw new CatalogCompatibilityError(`Tool R0 incompatible: ${logical} (${issue}).`);
    }
    const expected = baseline.tools.get(logical);
    if (!expected || captured.fingerprint !== expected.fingerprint) {
      throw new CatalogCompatibilityError(`Tool R0 incompatible: ${logical} (catalog-drift).`);
    }
  }
  if (catalog.hash !== baseline.hash) throw new CatalogCompatibilityError("Tool R0 incompatible: catalogo (catalog-drift).");
  return catalog;
}

async function requireStableCatalog(
  catalog: CatalogGeneration,
  runtime: CatalogRuntime,
): Promise<CatalogGeneration> {
  try {
    assertCurrentGeneration(catalog, runtime);
    const current = captureCatalog(await runtime.readCurrent());
    assertCurrentGeneration(catalog, runtime);
    for (const name of CODE_MODE_LOGICAL_TOOLS) {
      const captured = catalog.tools.get(name);
      const projected = current.tools.get(name);
      if (!captured || !projected || projected.fingerprint !== captured.fingerprint) {
        throw new CodeModeExecutionError("CATALOG_DRIFT");
      }
    }
    if (current.hash !== catalog.hash) throw new CodeModeExecutionError("CATALOG_DRIFT");
    if (catalogHash(catalog.tools) !== catalog.hash) throw new CodeModeExecutionError("CATALOG_DRIFT");
    return catalog;
  } catch (error) {
    if (error instanceof CodeModeExecutionError) throw error;
    throw new CodeModeExecutionError("CATALOG_DRIFT");
  }
}

function assertCurrentGeneration(catalog: CatalogGeneration, runtime: CatalogRuntime): void {
  if (!catalog.active || runtime.current !== catalog) {
    throw new CodeModeExecutionError(catalog.retiredCode ?? "CATALOG_DRIFT");
  }
}

async function resolveCodeModeScope(call: CodeModeToolCall, options: PluginAdapterOptions): Promise<CodeModeScope> {
  if (!validToolCall(call) || !options.resolveSessionProject) throw new CodeModeExecutionError("SCOPE_DRIFT");
  const project = await options.resolveSessionProject(call.sessionID);
  if (!project) throw new CodeModeExecutionError("SCOPE_DRIFT");
  const root = path.resolve(project.root);
  let rootStat: fs.Stats;
  let realRoot: string;
  try {
    rootStat = fs.lstatSync(root);
    realRoot = fs.realpathSync(root);
  } catch {
    throw new CodeModeExecutionError("SCOPE_DRIFT");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || path.resolve(realRoot) !== root) {
    throw new CodeModeExecutionError("SCOPE_DRIFT");
  }
  const env = { ...options.env ?? process.env, MALAHOR_OPENCODE_DETECT: "0" };
  const paths = resolvePaths(env, root);
  const loaded = loadHookPolicy(paths, project.canonicalKey);
  return {
    sessionID: call.sessionID,
    project: project.canonicalKey,
    root,
    realRoot,
    policyHash: loaded.policyHash,
    hookContext: {
      event: "tool.execute.before",
      harness: "opencode",
      profile: loaded.policy.profile,
      cwd: root,
      projectRoot: root,
      malahorHome: paths.malahorHome,
      project: project.canonicalKey,
      policy: loaded.policy,
      security: loaded.security,
      policyMeta: loaded.policyMeta,
      audit: { enabled: true, required: true },
      metadata: { origin: "opencode-v2", tool: "malahor_code_execute", codeMode: "read-only" },
    },
  };
}

interface CanonicalCallInput {
  hostInput: Record<string, unknown>;
  auditInput: Record<string, CodeModeJson>;
  resources: string[];
  limit: number;
  absolute: string;
  relative: string;
}

function canonicalizeCallInput(tool: CodeModeLogicalTool, value: unknown, root: string): CanonicalCallInput {
  const allowed = tool === "read" ? ["path", "offset", "limit"]
    : tool === "glob" ? ["pattern", "path", "limit"]
      : ["pattern", "path", "include", "literal", "caseSensitive", "limit"];
  if (!exactRecord(value, allowed, true)) throw new CodeModeExecutionError("INVALID_INPUT");
  const input = value as Record<string, unknown>;
  const basePath = optionalString(input.path, "path") ?? ".";
  const relative = canonicalRelativePath(basePath);
  const absolute = path.resolve(root, relative);
  assertInsideRoot(absolute, root);
  assertNoSymlinkPath(absolute, root);
  const stat = safeLstat(absolute);
  if (!stat) throw new CodeModeExecutionError("INVALID_INPUT");

  if (tool === "read") {
    if (typeof input.path !== "string" || !input.path.trim() || !stat.isFile() || isPotentialSecretPath(relative)
      || classifyInfrastructurePath(root, absolute).protected || isHiddenOrGitPath(relative)) {
      throw new CodeModeExecutionError("R0_ONLY");
    }
    const offset = optionalInteger(input.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
    const limit = optionalInteger(input.limit, "limit", 1, CODE_MODE_LIMITS.readLines) ?? CODE_MODE_LIMITS.readLines;
    const hostInput: Record<string, unknown> = { path: absolute, limit };
    const auditInput: Record<string, CodeModeJson> = { path: relative, limit };
    if (offset !== undefined) { hostInput.offset = offset; auditInput.offset = offset; }
    return { hostInput, auditInput, resources: [absolute], limit, absolute, relative };
  }

  if (!stat.isDirectory() && !stat.isFile()) throw new CodeModeExecutionError("R0_ONLY");
  if (isPotentialSecretPath(relative) || classifyInfrastructurePath(root, absolute).protected || isHiddenOrGitPath(relative)) {
    throw new CodeModeExecutionError("R0_ONLY");
  }
  const pattern = requiredString(input.pattern, "pattern", 2_048);
  assertSafePattern(pattern, root);
  const maximum = tool === "glob" ? CODE_MODE_LIMITS.globResults : CODE_MODE_LIMITS.grepResults;
  const limit = optionalInteger(input.limit, "limit", 1, maximum) ?? maximum;
  const hostInput: Record<string, unknown> = { pattern, path: absolute, limit };
  const auditInput: Record<string, CodeModeJson> = { pattern, path: relative, limit };
  if (tool === "grep") {
    const include = optionalString(input.include, "include", 512);
    if (include !== undefined) { assertSafePattern(include, root); hostInput.include = include; auditInput.include = include; }
    for (const key of ["literal", "caseSensitive"] as const) {
      if (input[key] !== undefined && typeof input[key] !== "boolean") throw new CodeModeExecutionError("INVALID_INPUT");
      if (typeof input[key] === "boolean") { hostInput[key] = input[key]; auditInput[key] = input[key]; }
    }
  }
  return { hostInput, auditInput, resources: [pattern], limit, absolute, relative };
}

interface FilteredHostOutput {
  value: CodeModeJson;
  truncated: boolean;
}

function filterHostOutput(
  tool: CodeModeLogicalTool,
  adapter: HostOutputAdapter,
  input: unknown,
  root: string,
  limit: number,
): FilteredHostOutput {
  const payload = extractHostPayload(tool, adapter, input);
  if (adapter.kind === "glob-paths") return normalizeGlobItems(payload, root, limit);
  if (adapter.kind === "grep-matches") return normalizeGrepItems(payload, root, limit);
  const text = adapter.kind === "text-parts" ? extractTextParts(payload) : requireHostText(payload);
  if (codeModeUtf8Bytes(text) > CODE_MODE_LIMITS.callOutputBytes) {
    return { value: { truncated: true, value: "<truncated:output-limit>" }, truncated: true };
  }
  if (tool === "read") {
    const lines = text.split(/\r?\n/);
    const truncated = lines.length > limit;
    return { value: truncated ? lines.slice(0, limit).join("\n") : text, truncated };
  }
  if (tool === "glob") return normalizeGlobOutput(text, root, limit);
  return normalizeGrepOutput(text, root, limit);
}

function extractHostPayload(tool: CodeModeLogicalTool, adapter: HostOutputAdapter, value: unknown): unknown {
  if (adapter.source === "direct") return value;
  if (adapter.source === "grep-entries") {
    if (!Array.isArray(value) || value.length > CODE_MODE_LIMITS.maxItems) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    let submatchCount = 0;
    let byteCount = 0;
    for (const item of value) {
      if (!exactRecord(item, ["entry", "line", "offset", "submatches", "text"], true)
        || !exactRecord(item.entry, ["path", "type"]) || !Number.isSafeInteger(item.line) || (item.line as number) < 1
        || (item.offset !== undefined && (!Number.isSafeInteger(item.offset) || (item.offset as number) < 0))
        || typeof item.text !== "string"
        || (item.submatches !== undefined && !Array.isArray(item.submatches))) {
        throw new CodeModeExecutionError("REDACTION_UNSAFE");
      }
      if (typeof item.entry.type === "string" && adapter.deniedVariants?.includes(item.entry.type)) {
        throw new CodeModeExecutionError("R0_ONLY");
      }
      if (item.entry.type !== adapter.variant || typeof item.entry.path !== "string") {
        throw new CodeModeExecutionError("REDACTION_UNSAFE");
      }
      byteCount += codeModeUtf8Bytes(item.entry.path) + codeModeUtf8Bytes(item.text);
      for (const submatch of item.submatches ?? []) {
        submatchCount += 1;
        if (submatchCount > CODE_MODE_LIMITS.maxItems || !exactRecord(submatch, ["end", "start", "text"])
          || !Number.isSafeInteger(submatch.start) || (submatch.start as number) < 0
          || !Number.isSafeInteger(submatch.end) || (submatch.end as number) < (submatch.start as number)
          || typeof submatch.text !== "string") throw new CodeModeExecutionError("REDACTION_UNSAFE");
        byteCount += codeModeUtf8Bytes(submatch.text);
      }
      if (byteCount > CODE_MODE_LIMITS.callOutputBytes) throw new CodeModeExecutionError("QUOTA_EXCEEDED");
      matches.push({ path: item.entry.path, line: item.line as number, preview: item.text });
    }
    return matches;
  }
  if (adapter.source === "glob-entries") {
    if (!Array.isArray(value) || value.length > CODE_MODE_LIMITS.maxItems) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    const paths: string[] = [];
    for (const item of value) {
      if (!exactRecord(item, ["path", "type"])) throw new CodeModeExecutionError("REDACTION_UNSAFE");
      if (typeof item.type === "string" && adapter.deniedVariants?.includes(item.type)) {
        throw new CodeModeExecutionError("R0_ONLY");
      }
      if (item.type !== adapter.variant || typeof item.path !== "string") {
        throw new CodeModeExecutionError("REDACTION_UNSAFE");
      }
      paths.push(item.path);
    }
    return paths;
  }
  if (adapter.source === "read-text") {
    if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    const type = Object.getOwnPropertyDescriptor(value, "type");
    if (!type || type.get || type.set) throw new CodeModeExecutionError("REDACTION_UNSAFE");
    if (typeof type.value === "string" && adapter.deniedVariants?.includes(type.value)) {
      throw new CodeModeExecutionError("R0_ONLY");
    }
    const keys = Object.keys(value);
    if (type.value !== adapter.variant || keys.some((key) => !adapter.allowedKeys.includes(key))
      || !["type", "content", "mime", "offset", "truncated"].every((key) => keys.includes(key))) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    const content = dataProperty(value, "content");
    const mime = dataProperty(value, "mime");
    const offset = dataProperty(value, "offset");
    const next = Object.hasOwn(value, "next") ? dataProperty(value, "next") : undefined;
    const truncated = dataProperty(value, "truncated");
    if (typeof content !== "string" || typeof mime !== "string"
      || !/^text\/[a-z0-9.+-]{1,64}(?:\s*;\s*charset=[a-z0-9._-]{1,32})?$/i.test(mime)
      || !Number.isSafeInteger(offset) || (offset as number) < 0
      || (next !== undefined && next !== null && (!Number.isSafeInteger(next) || (next as number) < 0))
      || typeof truncated !== "boolean") {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    return content;
  }
  if (adapter.source === "tagged-text") {
    if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    const type = Object.getOwnPropertyDescriptor(value, "type");
    if (!type || type.get || type.set) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    if (typeof type.value === "string" && adapter.deniedVariants?.includes(type.value)) {
      throw new CodeModeExecutionError("R0_ONLY");
    }
    if (Object.keys(value).some((key) => !adapter.allowedKeys.includes(key))) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    const content = Object.getOwnPropertyDescriptor(value, "content");
    if (!content || content.get || content.set) throw new CodeModeExecutionError("REDACTION_UNSAFE");
    if (type.value !== adapter.variant || typeof content.value !== "string") {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    return content.value;
  }
  if (adapter.source === "runtime-default" && typeof value === "string") return value;
  if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw new CodeModeExecutionError("REDACTION_UNSAFE");
  }
  const keys = Object.keys(value);
  const field = adapter.source === "runtime-default"
    ? (["output", "content"] as const).filter((candidate) => Object.hasOwn(value, candidate))[0]
    : adapter.field;
  const fields = adapter.source === "runtime-default"
    ? ["output", "content"].filter((candidate) => Object.hasOwn(value, candidate))
    : field ? [field] : [];
  if (!field || fields.length !== 1 || keys.some((key) => !adapter.allowedKeys.includes(key))) {
    throw new CodeModeExecutionError("REDACTION_UNSAFE");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || descriptor.value === undefined) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    if (key === "title" && (typeof descriptor.value !== "string"
      || codeModeUtf8Bytes(descriptor.value) > 4_096
      || /[\u0000-\u001f\u007f-\u009f]/.test(descriptor.value))) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    if (key === "attachments" && (!Array.isArray(descriptor.value) || descriptor.value.length !== 0)) {
      throw new CodeModeExecutionError("R0_ONLY");
    }
    if (key === "metadata") validateDiscardedHostMetadata(tool, descriptor.value);
  }
  const payload = Object.getOwnPropertyDescriptor(value, field)?.value;
  return adapter.source === "runtime-default" && field === "content" && Array.isArray(payload)
    ? extractTextParts(payload)
    : payload;
}

function dataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || descriptor.get || descriptor.set || descriptor.value === undefined) {
    throw new CodeModeExecutionError("REDACTION_UNSAFE");
  }
  return descriptor.value;
}

function requireHostText(value: unknown): string {
  if (typeof value !== "string") throw new CodeModeExecutionError("REDACTION_UNSAFE");
  return value;
}

function extractTextParts(value: unknown): string {
  if (!Array.isArray(value)) throw new CodeModeExecutionError("REDACTION_UNSAFE");
  const parts: string[] = [];
  for (const item of value) {
    if (!exactRecord(item, ["type", "text"]) || item.type !== "text" || typeof item.text !== "string") {
      throw new CodeModeExecutionError("R0_ONLY");
    }
    parts.push(item.text);
  }
  return parts.join("\n");
}

function validateDiscardedHostMetadata(tool: CodeModeLogicalTool, value: unknown): void {
  if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw new CodeModeExecutionError("REDACTION_UNSAFE");
  }
  const common = ["truncated"];
  const allowed = tool === "read"
    ? [...common, "preview", "lineCount", "offset", "limit", "loaded", "size"]
    : tool === "glob"
      ? [...common, "count"]
      : [...common, "count", "matches"];
  const keys = Object.keys(value);
  if (keys.length > 8 || keys.some((key) => !allowed.includes(key))) {
    throw new CodeModeExecutionError("REDACTION_UNSAFE");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || descriptor.value === undefined) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    if (key === "truncated" && typeof descriptor.value !== "boolean") {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    if (key === "preview" && (typeof descriptor.value !== "string" || codeModeUtf8Bytes(descriptor.value) > 4_096)) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    if (!["truncated", "preview"].includes(key)
      && (!Number.isSafeInteger(descriptor.value) || (descriptor.value as number) < 0)) {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
  }
}

function normalizeGlobItems(value: unknown, root: string, limit: number): FilteredHostOutput {
  if (!Array.isArray(value) || value.length > CODE_MODE_LIMITS.maxItems) {
    throw new CodeModeExecutionError("REDACTION_UNSAFE");
  }
  const paths: string[] = [];
  let truncated = false;
  for (const item of value) {
    if (typeof item !== "string") throw new CodeModeExecutionError("REDACTION_UNSAFE");
    const relative = safeResultRelative(item, root, true);
    if (!relative) throw new CodeModeExecutionError("REDACTION_UNSAFE");
    if (paths.length >= limit) {
      truncated = true;
      continue;
    }
    paths.push(relative);
  }
  return { value: paths, truncated };
}

function normalizeGrepItems(value: unknown, root: string, limit: number): FilteredHostOutput {
  if (!Array.isArray(value) || value.length > CODE_MODE_LIMITS.maxItems) {
    throw new CodeModeExecutionError("REDACTION_UNSAFE");
  }
  const matches: CodeModeJson[] = [];
  let truncated = false;
  for (const item of value) {
    if (!exactRecord(item, ["path", "line", "preview"]) || typeof item.path !== "string"
      || !Number.isSafeInteger(item.line) || (item.line as number) < 1 || typeof item.preview !== "string") {
      throw new CodeModeExecutionError("REDACTION_UNSAFE");
    }
    const relative = safeResultRelative(item.path, root, true);
    if (!relative) throw new CodeModeExecutionError("REDACTION_UNSAFE");
    if (matches.length >= limit) {
      truncated = true;
      continue;
    }
    matches.push({ path: relative, line: item.line as number, preview: item.preview });
  }
  return { value: matches, truncated };
}

function normalizeGlobOutput(text: string, root: string, limit: number): FilteredHostOutput {
  const paths: string[] = [];
  let truncated = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Found \d+ files?$/i.test(line) || /^No files found\.?$/i.test(line)) continue;
    if (/^(?:(?:\(|\[)?Results? (?:are )?truncated|\[Output truncated|\.\.\.)/i.test(line)) {
      truncated = true;
      continue;
    }
    const relative = safeResultRelative(line, root, true);
    if (!relative) throw new CodeModeExecutionError("REDACTION_UNSAFE");
    if (paths.length >= limit) {
      truncated = true;
      continue;
    }
    paths.push(relative);
  }
  return { value: paths, truncated };
}

function normalizeGrepOutput(text: string, root: string, limit: number): FilteredHostOutput {
  const matches: CodeModeJson[] = [];
  let currentPath: string | undefined;
  let truncated = false;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || /^Found \d+ matches?$/i.test(trimmed) || /^No matches found\.?$/i.test(trimmed)) continue;
    if (/^(?:(?:\(|\[)?Results? (?:are )?truncated|\[Output truncated|\.\.\.)/i.test(trimmed)) {
      truncated = true;
      continue;
    }
    const nested = /^Line\s+(\d+):\s?(.*)$/i.exec(trimmed);
    if (nested) {
      if (!currentPath) throw new CodeModeExecutionError("REDACTION_UNSAFE");
      if (matches.length >= limit) {
        truncated = true;
        continue;
      }
      matches.push({ path: currentPath, line: Number(nested[1]), preview: nested[2] ?? "" });
      continue;
    }
    const direct = /^(.*?):(\d+)(?::\d+)?:\s?(.*)$/.exec(trimmed);
    if (direct) {
      const relative = safeResultRelative(direct[1] ?? "", root, true);
      if (!relative) throw new CodeModeExecutionError("REDACTION_UNSAFE");
      if (matches.length >= limit) {
        truncated = true;
        continue;
      }
      matches.push({ path: relative, line: Number(direct[2]), preview: direct[3] ?? "" });
      continue;
    }
    if (trimmed.endsWith(":")) {
      const relative = safeResultRelative(trimmed.slice(0, -1), root, true);
      if (!relative) throw new CodeModeExecutionError("REDACTION_UNSAFE");
      currentPath = relative;
      continue;
    }
    throw new CodeModeExecutionError("REDACTION_UNSAFE");
  }
  return { value: matches, truncated };
}

function safeResultRelative(value: string, root: string, requireFile: boolean): string | undefined {
  try {
    const cleaned = value.trim();
    if (!cleaned) return undefined;
    const absolute = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(root, canonicalRelativePath(cleaned));
    assertInsideRoot(absolute, root);
    const relative = path.relative(root, absolute).replaceAll("\\", "/") || ".";
    if (relative === ".") return undefined;
    if (isPotentialSecretPath(relative) || isHiddenOrGitPath(relative)
      || classifyInfrastructurePath(root, absolute).protected) return undefined;
    assertNoSymlinkPath(absolute, root);
    const stat = safeLstat(absolute);
    if (!stat) return undefined;
    if (requireFile && !stat.isFile()) {
      if (stat.isDirectory()) throw new CodeModeExecutionError("R0_ONLY");
      return undefined;
    }
    if (!stat.isFile() && !stat.isDirectory()) return undefined;
    return relative;
  } catch (error) {
    if (error instanceof CodeModeExecutionError) throw error;
    return undefined;
  }
}

function sandboxToPublicResult(
  sandbox: SandboxResult,
  executionRef: string,
  calls: PublicCall[],
  brokerRedacted: boolean,
  brokerTruncated: boolean,
): PublicExecutionResult {
  if (!isRecord(sandbox.result) || typeof sandbox.result.ok !== "boolean") {
    return failureResult(executionRef, "SANDBOX_FAILURE", calls, true);
  }
  if (sandbox.result.ok === true) {
    return {
      ok: true,
      value: (sandbox.result.value ?? null) as CodeModeJson,
      executionRef,
      calls: [...calls],
      redacted: brokerRedacted || sandbox.redacted,
      truncated: brokerTruncated || sandbox.truncated || sandbox.result.truncated === true,
    };
  }
  const diagnostic = isRecord(sandbox.result.error) ? sandbox.result.error : {};
  const code = diagnosticFailureCode(typeof diagnostic.kind === "string" ? diagnostic.kind : "");
  return failureResult(executionRef, code, calls, brokerRedacted || sandbox.redacted, brokerTruncated || sandbox.truncated === true);
}

function sanitizePublicResult(
  result: PublicExecutionResult,
  root: string,
): { value: PublicExecutionResult; json: CodeModeJson; redacted: boolean } {
  const sanitized = sanitizeCodeModeBoundary(result, {
    limits: boundaryLimits(CODE_MODE_LIMITS.resultBytes),
    projectRoot: root,
    redactSecrets: true,
    dropHostMetadata: true,
    dropDangerousKeys: true,
    truncate: false,
  });
  return { value: sanitized.value as unknown as PublicExecutionResult, json: sanitized.value, redacted: sanitized.redacted };
}

function parseWorkerCall(value: unknown, executionRef: string): WorkerCallMessage | undefined {
  if (!exactRecord(value, ["version", "type", "executionRef", "callID", "index", "tool", "input"])) return undefined;
  if (value.version !== CODE_MODE_RPC_VERSION || value.type !== "call" || value.executionRef !== executionRef
    || typeof value.callID !== "string" || !/^call_[0-9]+$/.test(value.callID)
    || !Number.isSafeInteger(value.index) || (value.index as number) < 0
    || typeof value.tool !== "string" || !CODE_MODE_LOGICAL_TOOLS.includes(value.tool as CodeModeLogicalTool)) return undefined;
  return value as unknown as WorkerCallMessage;
}

function parseWorkerFinish(value: unknown, executionRef: string): WorkerFinishMessage | undefined {
  if (!exactRecord(value, ["version", "type", "executionRef", "result", "redacted", "redactions", "truncated"])) return undefined;
  if (value.version !== CODE_MODE_RPC_VERSION || value.type !== "finish" || value.executionRef !== executionRef
    || typeof value.redacted !== "boolean" || typeof value.truncated !== "boolean"
    || !Array.isArray(value.redactions) || value.redactions.some((item) => typeof item !== "string" || item.length > 80)) return undefined;
  return value as unknown as WorkerFinishMessage;
}

function readWorkerArtifact(moduleURL: string): string {
  let filePath: string;
  try {
    const url = new URL(moduleURL);
    if (url.protocol !== "file:") throw new Error("protocol");
    filePath = fileURLToPath(url);
  } catch {
    throw new CodeModeExecutionError("SANDBOX_FAILURE");
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_WORKER_ARTIFACT_BYTES) {
    throw new CodeModeExecutionError("SANDBOX_FAILURE");
  }
  const source = fs.readFileSync(filePath, "utf8");
  if (!source.includes("malahor-code-mode-worker")) throw new CodeModeExecutionError("SANDBOX_FAILURE");
  return source;
}

function validateWorkerSource(source: string): void {
  if (!source || codeModeUtf8Bytes(source) > MAX_WORKER_ARTIFACT_BYTES
    || !source.includes("malahor-code-mode-worker")) {
    throw new CodeModeExecutionError("SANDBOX_FAILURE");
  }
}

async function probeCodeModeSandbox(source: string, runSandbox: typeof executeCodeModeSandbox): Promise<void> {
  const probe = await runSandbox({
    source,
    code: "return { health: true };",
    executionRef: "exec_probe_0000000000000000",
    tools: ["read"],
    onCall: async () => { throw new CodeModeExecutionError("SANDBOX_FAILURE"); },
  });
  if (!isRecord(probe.result) || probe.result.ok !== true || !isRecord(probe.result.value)
    || probe.result.value.health !== true || probe.redacted || probe.truncated) {
    throw new CodeModeExecutionError("SANDBOX_FAILURE");
  }
}

function createActiveExecution(outer: AbortSignal | undefined, generationID: number): ActiveExecution {
  const controller = new AbortController();
  let resolveSettled: () => void = () => undefined;
  let finished = false;
  let failure: CodeModeFailureCode | undefined;
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
  const outerAbort = () => {
    failure ??= "CANCELLED";
    controller.abort();
  };
  outer?.addEventListener("abort", outerAbort, { once: true });
  if (outer?.aborted) outerAbort();
  return {
    generationID,
    controller,
    get failure() { return failure; },
    settled,
    abort(code) {
      failure ??= code;
      controller.abort();
    },
    finish() {
      if (finished) return;
      finished = true;
      outer?.removeEventListener("abort", outerAbort);
      resolveSettled();
    },
  };
}

async function waitForActiveExecutions(active: Map<string, ActiveExecution>): Promise<void> {
  await waitForPromises([...active.values()].map((item) => item.settled), CODE_MODE_LIMITS.watchdogMs + 1_000);
}

async function waitForCallTasks(tasks: Set<Promise<void>>): Promise<void> {
  await waitForPromises([...tasks], CODE_MODE_LIMITS.callMs + 250);
}

async function waitForPromises(promises: Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(promises).then(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
}

function throwIfAborted(signal: AbortSignal, fallback?: CodeModeFailureCode): void {
  if (signal.aborted) throw new CodeModeExecutionError(fallback ?? "CANCELLED");
}

function validateSearchInput(value: unknown): string {
  if (!exactRecord(value, ["query"]) || typeof value.query !== "string") throw new CodeModeExecutionError("INVALID_INPUT");
  const query = value.query.trim().replace(/\s+/g, " ");
  if (!query || query.length > 160 || /[\u0000-\u001f\u007f-\u009f]/.test(query)) {
    throw new CodeModeExecutionError("INVALID_INPUT");
  }
  return query;
}

function validateExecuteInput(value: unknown): { catalogRef: string; code: string } {
  if (!exactRecord(value, ["catalogRef", "code"]) || typeof value.catalogRef !== "string"
    || !/^cat_[A-Za-z0-9_-]{16,128}$/.test(value.catalogRef) || typeof value.code !== "string" || !value.code.trim()) {
    throw new CodeModeExecutionError("INVALID_INPUT");
  }
  return { catalogRef: value.catalogRef, code: value.code };
}

function searchCatalog(query: string): CodeModeLogicalTool[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return CODE_MODE_LOGICAL_TOOLS.map((name) => {
    const text = `${name} ${TOOL_DESCRIPTIONS[name]} ${TOOL_SIGNATURES[name]}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (name === term ? 20 : name.includes(term) ? 12 : text.includes(term) ? 4 : 0), 0);
    return { name, score };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, 3).map((item) => item.name);
}

function visibleLimits() {
  return {
    codeBytes: CODE_MODE_LIMITS.codeBytes,
    timeoutMs: CODE_MODE_LIMITS.interpreterMs,
    maxToolCalls: CODE_MODE_LIMITS.maxToolCalls,
    maxConcurrentCalls: CODE_MODE_LIMITS.maxConcurrentCalls,
    readLines: CODE_MODE_LIMITS.readLines,
    globResults: CODE_MODE_LIMITS.globResults,
    grepResults: CODE_MODE_LIMITS.grepResults,
  };
}

function toolResult(value: unknown, kind: string, count: number) {
  return { content: JSON.stringify(value), metadata: { kind, version: 1, count } };
}

function executionToolResult(value: PublicExecutionResult) {
  return { content: JSON.stringify(value), metadata: { kind: "malahor.code.execution", version: 1, ok: value.ok, calls: value.calls.length } };
}

function failureResult(
  executionRef: string,
  code: CodeModeFailureCode,
  calls: PublicCall[] = [],
  redacted = false,
  truncated = false,
): PublicExecutionResult {
  return {
    ok: false,
    error: { kind: code, message: publicFailureMessage(code) },
    executionRef,
    calls: [...calls],
    redacted,
    truncated,
  };
}

function publicFailureMessage(code: CodeModeFailureCode): string {
  const messages: Record<CodeModeFailureCode, string> = {
    CATALOG_REF_INVALID: "La referencia de catalogo no es valida para este request.",
    CATALOG_DRIFT: "El catalogo R0 cambio; vuelve a descubrir las firmas.",
    SCOPE_DRIFT: "La sesion o el proyecto cambiaron durante la ejecucion.",
    POLICY_DRIFT: "La politica cambio durante la ejecucion.",
    TOOL_NOT_DISCOVERED: "El programa intento usar una tool no descubierta.",
    INVALID_INPUT: "La entrada no cumple el contrato R0.",
    R0_ONLY: "El recurso queda fuera del catalogo read-only.",
    PERMISSION_DENIED: "La llamada read-only no fue autorizada.",
    AUDIT_UNAVAILABLE: "La auditoria obligatoria no esta disponible.",
    REDACTION_UNSAFE: "El resultado no pudo sanearse de forma segura.",
    QUOTA_EXCEEDED: "La ejecucion excedio una cuota de seguridad.",
    CANCELLED: "La ejecucion fue cancelada y limpiada.",
    SANDBOX_FAILURE: "El sandbox no pudo completar el contrato confinado.",
  };
  return messages[code];
}

function diagnosticFailureCode(kind: string): CodeModeFailureCode {
  if (CODE_MODE_FAILURE_CODES.includes(kind as CodeModeFailureCode)) return kind as CodeModeFailureCode;
  if (kind === "UnknownTool") return "TOOL_NOT_DISCOVERED";
  if (kind === "InvalidToolInput") return "INVALID_INPUT";
  if (kind === "ToolCallLimitExceeded" || kind === "TimeoutExceeded" || kind === "Truncated") return "QUOTA_EXCEEDED";
  if (kind === "InvalidToolOutput" || kind === "InvalidDataValue") return "REDACTION_UNSAFE";
  return "SANDBOX_FAILURE";
}

class CodeModeExecutionError extends Error {
  constructor(readonly code: CodeModeFailureCode) {
    super(code);
    this.name = "CodeModeExecutionError";
  }
}

class CatalogCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogCompatibilityError";
  }
}

function failureCode(error: unknown): CodeModeFailureCode {
  if (error instanceof CodeModeExecutionError) return error.code;
  if (error instanceof CodeModeBoundaryError) {
    if (error.code === "QUOTA_EXCEEDED") return "QUOTA_EXCEEDED";
    if (error.code === "INVALID_INPUT") return "INVALID_INPUT";
    return "REDACTION_UNSAFE";
  }
  return "SANDBOX_FAILURE";
}

function fatalFailure(code: CodeModeFailureCode): boolean {
  return [
    "AUDIT_UNAVAILABLE", "CATALOG_DRIFT", "SCOPE_DRIFT", "POLICY_DRIFT", "REDACTION_UNSAFE",
    "QUOTA_EXCEEDED", "SANDBOX_FAILURE", "CANCELLED",
  ].includes(code);
}

function assertSameScope(expected: CodeModeScope, current: CodeModeScope): void {
  if (expected.sessionID !== current.sessionID || expected.project !== current.project
    || expected.root !== current.root || expected.realRoot !== current.realRoot) throw new CodeModeExecutionError("SCOPE_DRIFT");
  if (expected.policyHash !== current.policyHash) throw new CodeModeExecutionError("POLICY_DRIFT");
}

function innerToolCall(outer: CodeModeToolCall, message: WorkerCallMessage, signal: AbortSignal): Record<string, unknown> {
  const id = `${outer.id}:${message.index}`;
  return {
    sessionID: outer.sessionID,
    agent: outer.agent,
    messageID: outer.messageID,
    id,
    callID: id,
    toolCallID: id,
    abort: signal,
    signal,
    progress: async () => undefined,
  };
}

function callSignal(call: CodeModeToolCall): AbortSignal | undefined {
  return isAbortSignal(call.abort) ? call.abort : isAbortSignal(call.signal) ? call.signal : undefined;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function";
}

function validToolCall(call: CodeModeToolCall): boolean {
  return [call.sessionID, call.agent, call.messageID, call.id]
    .every((value) => typeof value === "string" && value.length > 0 && value.length <= 256);
}

function normalizedCall(call: CodeModeToolCall): CodeModeToolCall {
  if (!validToolCall(call)) throw new CodeModeExecutionError("SCOPE_DRIFT");
  return { sessionID: call.sessionID, agent: call.agent, messageID: call.messageID, id: call.id };
}

function sameRequest(left: CodeModeToolCall, right: CodeModeToolCall): boolean {
  return validToolCall(right) && left.sessionID === right.sessionID && left.agent === right.agent
    && left.messageID === right.messageID;
}

function pruneGrants(grants: Map<string, CatalogGrant>, call: CodeModeToolCall): void {
  for (const [key, grant] of grants) {
    if (grant.call.sessionID === call.sessionID && grant.call.messageID !== call.messageID) grants.delete(key);
  }
  while (grants.size >= CATALOG_CAPACITY) grants.delete(grants.keys().next().value as string);
}

function defaultRandomRef(prefix: "cat" | "exec"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function listedToolDefinitions(value: unknown): Map<string, unknown> {
  if (!Array.isArray(value)) throw new Error("ctx.tool.list no devolvio un catalogo.");
  const output = new Map<string, unknown>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || output.has(item.id)) {
      throw new Error("ctx.tool.list contiene una definicion incompatible.");
    }
    output.set(item.id, item);
  }
  return output;
}

function hostToolDefinition(value: unknown, expected: CodeModeLogicalTool): HostToolDefinition | undefined {
  if (!isRecord(value) || typeof value.execute !== "function"
    || typeof value.description !== "string" || !value.description.trim() || value.description.length > 4_096) {
    return undefined;
  }
  const id = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  if ((!id && !name) || (id !== undefined && id !== expected) || (name !== undefined && name !== expected)) {
    return undefined;
  }
  const inputContract = compatibleHostInput(expected, value.input);
  const output = compatibleHostOutput(expected, value.output);
  const optionsContract = compatibleHostOptions(expected, value.options);
  if (!inputContract || !output || !optionsContract) return undefined;
  const receiver = value;
  const executeIdentity = value.execute as HostToolDefinition["executeIdentity"];
  return {
    id: expected,
    name: expected,
    description: value.description,
    inputContract,
    outputContract: output.contract,
    outputAdapter: output.adapter,
    optionsContract,
    executeIdentity,
    execute: (input, call) => executeIdentity.call(receiver, input, call),
  };
}

function hostToolCompatibilityIssue(value: unknown, expected: CodeModeLogicalTool): string {
  if (!isRecord(value)) return "definition";
  if (typeof value.execute !== "function") return "execute";
  if (typeof value.description !== "string" || !value.description.trim() || value.description.length > 4_096) {
    return "description";
  }
  const id = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  if ((!id && !name) || (id !== undefined && id !== expected) || (name !== undefined && name !== expected)) return "identity";
  if (!compatibleHostInput(expected, value.input)) return "input";
  if (!compatibleHostOutput(expected, value.output)) return `output:${hostOutputCompatibilityIssue(value.output)}`;
  if (!compatibleHostOptions(expected, value.options)) return "options";
  return "unknown";
}

function hostOutputCompatibilityIssue(value: unknown): string {
  if (value === undefined) return "missing";
  if (Schema.isSchema(value)) {
    try {
      const document = normalizeSchemaDocument(value);
      return document
        ? `effect-${schemaDocumentShape(document.root, document)}-${taggedTextOutputIssue(document)}-${grepEntriesOutputIssue(document)}`
        : "effect-unsupported";
    } catch {
      return "effect-unconvertible";
    }
  }
  return `json-${schemaShape(value)}`;
}

function schemaDocumentShape(
  value: unknown,
  document: NormalizedSchemaDocument,
  depth = 0,
): string {
  if (depth > 4) return "deep";
  const node = dereferenceSchema(value, document);
  if (!node) return schemaShape(value);
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (union) {
    const aliases = new Map<string, number>();
    return `union[${union.slice(0, 8).map((item) => {
      const branch = selectSchemaNode(item, document, "object");
      const properties = branch && isRecord(branch.properties) ? branch.properties : undefined;
      const literal = properties ? singleStringLiteral(properties.type, document) : undefined;
      let alias = "none";
      if (literal) {
        if (!aliases.has(literal)) aliases.set(literal, aliases.size + 1);
        alias = `v${aliases.get(literal)}`;
      }
      return `${schemaDocumentShape(item, document, depth + 1)}@${alias}`;
    }).join(",")}]`;
  }
  return schemaNodeShape(node, document);
}

function schemaShape(value: unknown): string {
  if (!isRecord(value)) return typeof value;
  const union = Array.isArray(value.anyOf) ? value.anyOf : Array.isArray(value.oneOf) ? value.oneOf : undefined;
  if (union) return `union[${union.slice(0, 8).map((item) => schemaNodeShape(item)).join(",")}]`;
  return schemaNodeShape(value);
}

function schemaNodeShape(value: unknown, document?: NormalizedSchemaDocument): string {
  if (!isRecord(value)) return typeof value;
  const knownTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
  const type = typeof value.type === "string" && knownTypes.has(value.type) ? value.type : "none";
  if (type === "array") {
    const itemShape = document ? schemaDocumentShape(value.items, document, 1) : schemaShape(value.items);
    return `array-${itemShape}`;
  }
  const properties = isRecord(value.properties) ? value.properties : undefined;
  const propertyNames = properties ? Object.keys(properties).sort() : [];
  const fields = !properties ? "none"
    : propertyNames.length <= 16 && propertyNames.every((name) => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name))
      ? propertyNames.join("+") || "empty"
      : `unsafe-${propertyNames.length}`;
  const typeProperty = properties?.type;
  const typeNode = document ? dereferenceSchema(typeProperty, document) : isRecord(typeProperty) ? typeProperty : undefined;
  const rawVariant = typeNode?.const ?? (Array.isArray(typeNode?.enum) && typeNode.enum.length === 1 ? typeNode.enum[0] : undefined);
  const variant = typeof rawVariant === "string" && ["text", "json", "image", "resource", "binary", "error"].includes(rawVariant)
    ? rawVariant : "none";
  const discriminatorShape = !typeNode ? "missing"
    : typeNode.const !== undefined ? `const-${typeof typeNode.const}`
      : Array.isArray(typeNode.enum) ? `enum-${typeNode.enum.length}`
        : Array.isArray(typeNode.anyOf) ? `anyOf-${typeNode.anyOf.length}`
          : Array.isArray(typeNode.oneOf) ? `oneOf-${typeNode.oneOf.length}`
            : typeof typeNode.type === "string" ? `type-${typeNode.type}` : "opaque";
  const contentNode = properties?.content;
  const contentShape = contentNode === undefined ? "none"
    : document ? schemaDocumentShape(contentNode, document, 1) : schemaShape(contentNode);
  const submatchesNode = properties?.submatches;
  const submatchesShape = submatchesNode === undefined ? "none"
    : document ? schemaDocumentShape(submatchesNode, document, 1) : schemaShape(submatchesNode);
  const entryNode = properties?.entry;
  const entryShape = entryNode === undefined ? "none"
    : document ? schemaDocumentShape(entryNode, document, 1) : schemaShape(entryNode);
  const closed = value.additionalProperties === false ? "closed" : "open";
  return `${type}-${fields}-${variant}-${discriminatorShape}-${contentShape}-${submatchesShape}-${entryShape}-${closed}`;
}

interface NormalizedSchemaDocument {
  root: Record<string, unknown>;
  definitions: Record<string, unknown>;
}

interface CompatibleHostOutput {
  contract: CodeModeJson;
  adapter: HostOutputAdapter;
}

interface InputScalarSpec {
  kind: "string" | "integer" | "boolean";
  minimum?: number;
  maximum?: number;
  maximumLength?: number;
}

const SCHEMA_ANNOTATION_KEYS = new Set([
  "$id", "$schema", "default", "deprecated", "description", "examples", "readOnly", "title", "writeOnly",
]);
const SCHEMA_DEFINITION_KEYS = new Set(["$defs", "definitions"]);
const MAX_HOST_SCHEMA_BYTES = 256 * 1024;
const MAX_HOST_SCHEMA_DEPTH = 24;
const MAX_HOST_SCHEMA_PROPERTIES = 512;
const MAX_HOST_SCHEMA_ITEMS = 2_048;

function compatibleHostInput(tool: CodeModeLogicalTool, value: unknown): CodeModeJson | undefined {
  const document = normalizeSchemaDocument(value);
  const root = document && selectSchemaNode(document.root, document, "object");
  if (!document || !root || !schemaKeysAllowed(root, ["type", "properties", "required", "additionalProperties"])
    || root.additionalProperties !== false || !isRecord(root.properties) || !Array.isArray(root.required)) {
    return undefined;
  }
  const expected = tool === "read" ? ["path", "offset", "limit"]
    : tool === "glob" ? ["pattern", "path", "hidden", "limit"]
      : ["pattern", "path", "include", "literal", "caseSensitive", "limit"];
  const properties = root.properties as Record<string, unknown>;
  if (Object.keys(properties).some((key) => !expected.includes(key))) return undefined;
  const required = root.required.filter((item): item is string => typeof item === "string");
  const requiredName = tool === "read" ? "path" : "pattern";
  if (required.length !== root.required.length || required.length !== 1 || required[0] !== requiredName
    || !expected.filter((property) => property !== "hidden").every((property) => Object.hasOwn(properties, property))) {
    return undefined;
  }

  const maximum = tool === "read" ? CODE_MODE_LIMITS.readLines
    : tool === "glob" ? CODE_MODE_LIMITS.globResults : CODE_MODE_LIMITS.grepResults;
  const specs: Record<string, InputScalarSpec> = {
    path: { kind: "string", maximumLength: 4_096 },
    pattern: { kind: "string", maximumLength: 2_048 },
    include: { kind: "string", maximumLength: 512 },
    offset: { kind: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { kind: "integer", minimum: 1, maximum },
    hidden: { kind: "boolean" },
    literal: { kind: "boolean" },
    caseSensitive: { kind: "boolean" },
  };
  const normalizedProperties: Record<string, CodeModeJson> = Object.create(null) as Record<string, CodeModeJson>;
  for (const property of expected) {
    if (!Object.hasOwn(properties, property)) continue;
    const normalized = normalizeInputScalar(properties[property], document, specs[property]!);
    if (!normalized) return undefined;
    normalizedProperties[property] = normalized;
  }
  return {
    type: "object",
    properties: normalizedProperties,
    required: [requiredName],
    additionalProperties: false,
  };
}

function compatibleHostOptions(tool: CodeModeLogicalTool, value: unknown): CodeModeJson | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some((key) => !["namespace", "permission", "codemode", "pinned"].includes(key))) {
    return undefined;
  }
  if (value.namespace !== undefined || (value.permission !== undefined && value.permission !== tool)) return undefined;
  if (value.codemode !== undefined && typeof value.codemode !== "boolean") return undefined;
  if (value.pinned !== undefined && typeof value.pinned !== "boolean") return undefined;
  return {
    ...(value.permission === undefined ? {} : { permission: value.permission as string }),
    ...(value.codemode === undefined ? {} : { codemode: value.codemode as boolean }),
  };
}

function compatibleHostOutput(tool: CodeModeLogicalTool, value: unknown): CompatibleHostOutput | undefined {
  if (value === undefined) {
    return {
      contract: {
        source: "runtime-default",
        kind: "text",
        fields: ["output", "content"],
        allowedKeys: ["attachments", "content", "metadata", "output", "title"],
      },
      adapter: {
        source: "runtime-default",
        kind: "text",
        allowedKeys: ["attachments", "content", "metadata", "output", "title"],
      },
    };
  }
  const document = normalizeSchemaDocument(value);
  if (!document) return undefined;
  const direct = outputValueContract(tool, document.root, document);
  if (direct) {
    return {
      contract: { source: "direct", kind: direct.kind, shape: direct.contract },
      adapter: { source: "direct", kind: direct.kind, allowedKeys: [] },
    };
  }

  const globEntries = tool === "glob" ? globEntriesOutputContract(document) : undefined;
  if (globEntries) return globEntries;
  const grepEntries = tool === "grep" ? grepEntriesOutputContract(document) : undefined;
  if (grepEntries) return grepEntries;

  const tagged = taggedTextOutputContract(document);
  const readText = tool === "read" ? readTextOutputContract(document) : undefined;
  if (readText) return readText;
  if (tagged) return tagged;

  const root = selectSchemaNode(document.root, document, "object");
  if (!root || !schemaKeysAllowed(root, ["type", "properties", "required", "additionalProperties"])
    || root.additionalProperties !== false || !isRecord(root.properties) || !Array.isArray(root.required)) {
    return undefined;
  }
  const properties = root.properties as Record<string, unknown>;
  const allowed = ["output", "content", "title", "metadata", "attachments"];
  if (Object.keys(properties).some((key) => !allowed.includes(key))) return undefined;
  const fields = ["output", "content"].filter((field) => Object.hasOwn(properties, field)) as Array<"output" | "content">;
  if (fields.length !== 1) return undefined;
  const field = fields[0]!;
  const required = root.required.filter((item): item is string => typeof item === "string");
  if (required.length !== root.required.length || !required.includes(field)
    || required.some((name) => !Object.hasOwn(properties, name))) return undefined;
  const primary = outputValueContract(tool, properties[field], document, field);
  if (!primary) return undefined;
  if (properties.title !== undefined && !selectSchemaNode(properties.title, document, "string")) return undefined;
  if (properties.attachments !== undefined && !selectSchemaNode(properties.attachments, document, "array")) return undefined;
  if (properties.metadata !== undefined && !schemaCanBeDiscarded(properties.metadata, document)) return undefined;
  return {
    contract: { source: "field", field, kind: primary.kind, shape: primary.contract },
    adapter: {
      source: "field",
      field,
      kind: primary.kind,
      allowedKeys: Object.keys(properties).sort(),
    },
  };
}

function grepEntriesOutputContract(document: NormalizedSchemaDocument): CompatibleHostOutput | undefined {
  const root = selectSchemaNode(document.root, document, "array");
  if (!root || !schemaKeysAllowed(root, ["type", "items", "minItems", "maxItems"]) || root.items === undefined) {
    return undefined;
  }
  const item = selectSchemaNode(root.items, document, "object");
  if (!item || !schemaKeysAllowed(item, ["type", "properties", "required", "additionalProperties"])
    || item.additionalProperties !== false || !isRecord(item.properties) || !Array.isArray(item.required)) {
    return undefined;
  }
  const properties = item.properties as Record<string, unknown>;
  const expected = ["entry", "line", "offset", "submatches", "text"];
  const required = item.required.filter((entry): entry is string => typeof entry === "string");
  if (Object.keys(properties).sort().join(",") !== expected.join(",") || required.length !== item.required.length
    || ["entry", "line", "text"].some((name) => !required.includes(name))
    || !selectSchemaNode(properties.line, document, "integer")
    || !selectSchemaNode(properties.offset, document, "integer")
    || !selectSchemaNode(properties.text, document, "string")) return undefined;
  const entry = fileEntryOutputSchema(properties.entry, document);
  if (!entry) return undefined;

  const submatches = selectSchemaNode(properties.submatches, document, "array");
  if (!submatches || !schemaKeysAllowed(submatches, ["type", "items", "minItems", "maxItems"])
    || submatches.items === undefined) return undefined;
  const submatch = selectSchemaNode(submatches.items, document, "object");
  if (!submatch || !schemaKeysAllowed(submatch, ["type", "properties", "required", "additionalProperties"])
    || submatch.additionalProperties !== false || !isRecord(submatch.properties) || !Array.isArray(submatch.required)) {
    return undefined;
  }
  const submatchProperties = submatch.properties as Record<string, unknown>;
  const submatchExpected = ["end", "start", "text"];
  const submatchRequired = submatch.required.filter((entry): entry is string => typeof entry === "string");
  if (Object.keys(submatchProperties).sort().join(",") !== submatchExpected.join(",")
    || submatchRequired.length !== submatch.required.length
    || !selectSchemaNode(submatchProperties.start, document, "integer")
    || !selectSchemaNode(submatchProperties.end, document, "integer")
    || !selectSchemaNode(submatchProperties.text, document, "string")) return undefined;

  return {
    contract: {
      source: "grep-entries",
      kind: "grep-matches",
      variant: "file",
      deniedVariants: entry.deniedVariants,
    },
    adapter: {
      source: "grep-entries",
      kind: "grep-matches",
      allowedKeys: expected,
      variant: "file",
      deniedVariants: entry.deniedVariants,
    },
  };
}

function fileEntryOutputSchema(
  value: unknown,
  document: NormalizedSchemaDocument,
): { deniedVariants: string[] } | undefined {
  const entry = selectSchemaNode(value, document, "object");
  if (!entry || !schemaKeysAllowed(entry, ["type", "properties", "required", "additionalProperties"])
    || entry.additionalProperties !== false || !isRecord(entry.properties) || !Array.isArray(entry.required)) {
    return undefined;
  }
  const properties = entry.properties as Record<string, unknown>;
  const required = entry.required.filter((item): item is string => typeof item === "string");
  if (Object.keys(properties).sort().join(",") !== "path,type" || required.length !== entry.required.length
    || required.length !== 2 || !required.includes("path") || !required.includes("type")
    || !selectSchemaNode(properties.path, document, "string")) return undefined;
  const variants = stringEnumValues(properties.type, document);
  if (!variants || variants.length !== 2 || !variants.includes("file")
    || variants.some((variant) => !["directory", "dir", "file"].includes(variant))) return undefined;
  return { deniedVariants: variants.filter((variant) => variant !== "file").sort() };
}

function grepEntriesOutputIssue(document: NormalizedSchemaDocument): string {
  const root = selectSchemaNode(document.root, document, "array");
  if (!root) return "grep-root";
  if (!schemaKeysAllowed(root, ["type", "items", "minItems", "maxItems"]) || root.items === undefined) return "grep-array";
  const item = selectSchemaNode(root.items, document, "object");
  if (!item) return "grep-item";
  if (!schemaKeysAllowed(item, ["type", "properties", "required", "additionalProperties"])
    || item.additionalProperties !== false || !isRecord(item.properties) || !Array.isArray(item.required)) return "grep-item-shape";
  const properties = item.properties as Record<string, unknown>;
  const expected = ["entry", "line", "offset", "submatches", "text"];
  const required = item.required.filter((entry): entry is string => typeof entry === "string");
  if (Object.keys(properties).sort().join(",") !== expected.join(",")) return "grep-item-fields";
  if (required.length !== item.required.length) return "grep-item-required-types";
  if (["entry", "line", "text"].some((name) => !required.includes(name))) return "grep-item-required";
  if (!selectSchemaNode(properties.entry, document, "string")) return "grep-entry";
  if (!selectSchemaNode(properties.line, document, "integer")) return "grep-line";
  if (!selectSchemaNode(properties.offset, document, "integer")) return "grep-offset";
  if (!selectSchemaNode(properties.text, document, "string")) return "grep-text";
  const submatches = selectSchemaNode(properties.submatches, document, "array");
  if (!submatches) return "grep-submatches";
  if (!schemaKeysAllowed(submatches, ["type", "items", "minItems", "maxItems"]) || submatches.items === undefined) {
    return "grep-submatches-shape";
  }
  const submatch = selectSchemaNode(submatches.items, document, "object");
  if (!submatch) return "grep-submatch";
  if (!schemaKeysAllowed(submatch, ["type", "properties", "required", "additionalProperties"])
    || submatch.additionalProperties !== false || !isRecord(submatch.properties) || !Array.isArray(submatch.required)) {
    return "grep-submatch-shape";
  }
  const submatchProperties = submatch.properties as Record<string, unknown>;
  if (Object.keys(submatchProperties).sort().join(",") !== "end,start,text") return "grep-submatch-fields";
  if (!selectSchemaNode(submatchProperties.start, document, "integer")) return "grep-start";
  if (!selectSchemaNode(submatchProperties.end, document, "integer")) return "grep-end";
  if (!selectSchemaNode(submatchProperties.text, document, "string")) return "grep-submatch-text";
  return "grep-compatible";
}

function globEntriesOutputContract(document: NormalizedSchemaDocument): CompatibleHostOutput | undefined {
  const root = selectSchemaNode(document.root, document, "array");
  if (!root || !schemaKeysAllowed(root, ["type", "items", "minItems", "maxItems"]) || root.items === undefined) {
    return undefined;
  }
  const item = selectSchemaNode(root.items, document, "object");
  if (!item || !schemaKeysAllowed(item, ["type", "properties", "required", "additionalProperties"])
    || item.additionalProperties !== false || !isRecord(item.properties) || !Array.isArray(item.required)) {
    return undefined;
  }
  const properties = item.properties as Record<string, unknown>;
  const required = item.required.filter((entry): entry is string => typeof entry === "string");
  if (Object.keys(properties).sort().join(",") !== "path,type" || required.length !== item.required.length
    || required.length !== 2 || !required.includes("path") || !required.includes("type")
    || !selectSchemaNode(properties.path, document, "string")) return undefined;
  const variants = stringEnumValues(properties.type, document);
  if (!variants || variants.length !== 2 || !variants.includes("file")
    || variants.some((variant) => !["directory", "dir", "file"].includes(variant))) return undefined;
  const deniedVariants = variants.filter((variant) => variant !== "file").sort();
  return {
    contract: {
      source: "glob-entries",
      kind: "glob-paths",
      variant: "file",
      deniedVariants,
    },
    adapter: {
      source: "glob-entries",
      kind: "glob-paths",
      allowedKeys: ["path", "type"],
      variant: "file",
      deniedVariants,
    },
  };
}

function readTextOutputContract(document: NormalizedSchemaDocument): CompatibleHostOutput | undefined {
  const root = dereferenceSchema(document.root, document);
  if (!root || !schemaKeysAllowed(root, ["anyOf", "oneOf"])) return undefined;
  const union = Array.isArray(root.anyOf) ? root.anyOf : Array.isArray(root.oneOf) ? root.oneOf : undefined;
  if (!union || union.length < 2 || union.length > 16) return undefined;

  const variants: string[] = [];
  let textVariant: string | undefined;
  const expectedKeys = ["content", "mime", "next", "offset", "truncated", "type"];
  for (const item of union) {
    const node = selectSchemaNode(item, document, "object");
    if (!node || !schemaKeysAllowed(node, ["type", "properties", "required", "additionalProperties"])
      || node.additionalProperties !== false || !isRecord(node.properties) || !Array.isArray(node.required)) {
      return undefined;
    }
    const properties = node.properties as Record<string, unknown>;
    const required = node.required.filter((entry): entry is string => typeof entry === "string");
    if (required.length !== node.required.length || required.some((name) => !Object.hasOwn(properties, name))
      || !Object.hasOwn(properties, "type") || !required.includes("type")) return undefined;
    const variant = singleStringLiteral(properties.type, document);
    if (!variant || variants.includes(variant)) return undefined;
    variants.push(variant);

    const keys = Object.keys(properties).sort();
    if (keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
      && ["type", "content", "mime", "offset", "truncated"].every((key) => required.includes(key))
      && Boolean(selectSchemaNode(properties.content, document, "string"))
      && Boolean(selectSchemaNode(properties.mime, document, "string"))
      && Boolean(selectSchemaNode(properties.offset, document, "integer"))
      && Boolean(selectSchemaNode(properties.next, document, "integer"))
      && Boolean(selectSchemaNode(properties.truncated, document, "boolean"))) {
      if (textVariant !== undefined) return undefined;
      textVariant = variant;
    }
  }
  if (textVariant === undefined) return undefined;
  const deniedVariants = variants.filter((variant) => variant !== textVariant).sort();
  return {
    contract: {
      source: "read-text",
      kind: "text",
      variant: textVariant,
      deniedVariants,
      allowedKeys: expectedKeys,
    },
    adapter: {
      source: "read-text",
      kind: "text",
      allowedKeys: expectedKeys,
      variant: textVariant,
      deniedVariants,
    },
  };
}

function taggedTextOutputContract(document: NormalizedSchemaDocument): CompatibleHostOutput | undefined {
  const root = dereferenceSchema(document.root, document);
  if (!root || !schemaKeysAllowed(root, ["anyOf", "oneOf"])) return undefined;
  const union = Array.isArray(root.anyOf) ? root.anyOf : Array.isArray(root.oneOf) ? root.oneOf : undefined;
  if (!union || union.length < 2 || union.length > 16) return undefined;

  const variants: string[] = [];
  const textVariants = new Set<string>();
  const incompatibleTextVariants = new Set<string>();
  for (const item of union) {
    const node = selectSchemaNode(item, document, "object");
    if (!node || !schemaKeysAllowed(node, ["type", "properties", "required", "additionalProperties"])
      || node.additionalProperties !== false || !isRecord(node.properties) || !Array.isArray(node.required)) {
      return undefined;
    }
    const properties = node.properties as Record<string, unknown>;
    const required = node.required.filter((entry): entry is string => typeof entry === "string");
    if (required.length !== node.required.length || required.some((name) => !Object.hasOwn(properties, name))
      || !Object.hasOwn(properties, "type") || !required.includes("type")) return undefined;
    const variant = singleStringLiteral(properties.type, document);
    if (!variant) return undefined;
    if (!variants.includes(variant)) variants.push(variant);

    const keys = Object.keys(properties).sort();
    const textShaped = keys.length === 2 && keys[0] === "content" && keys[1] === "type"
      && Boolean(selectSchemaNode(properties.content, document, "string"));
    if (textShaped) textVariants.add(variant);
    else incompatibleTextVariants.add(variant);
  }
  if (textVariants.size !== 1) return undefined;
  const textVariant = [...textVariants][0]!;
  if (incompatibleTextVariants.has(textVariant)) return undefined;
  const deniedVariants = variants.filter((variant) => variant !== textVariant).sort();
  return {
    contract: {
      source: "tagged-text",
      kind: "text",
      variant: textVariant,
      deniedVariants,
      allowedKeys: ["content", "type"],
    },
    adapter: {
      source: "tagged-text",
      kind: "text",
      allowedKeys: ["content", "type"],
      variant: textVariant,
      deniedVariants,
    },
  };
}

function taggedTextOutputIssue(document: NormalizedSchemaDocument): string {
  const root = dereferenceSchema(document.root, document);
  if (!root || !schemaKeysAllowed(root, ["anyOf", "oneOf"])) return "tagged-root";
  const union = Array.isArray(root.anyOf) ? root.anyOf : Array.isArray(root.oneOf) ? root.oneOf : undefined;
  if (!union || union.length < 2 || union.length > 16) return "tagged-union";
  const textVariants = new Set<string>();
  const incompatible = new Set<string>();
  const shapes: string[] = [];
  for (const [index, item] of union.entries()) {
    const node = selectSchemaNode(item, document, "object");
    if (!node) return `tagged-branch-${index}-object`;
    if (!schemaKeysAllowed(node, ["type", "properties", "required", "additionalProperties"])) {
      return `tagged-branch-${index}-keys`;
    }
    if (node.additionalProperties !== false || !isRecord(node.properties) || !Array.isArray(node.required)) {
      return `tagged-branch-${index}-shape`;
    }
    const properties = node.properties as Record<string, unknown>;
    const required = node.required.filter((entry): entry is string => typeof entry === "string");
    if (required.length !== node.required.length || required.some((name) => !Object.hasOwn(properties, name))
      || !Object.hasOwn(properties, "type") || !required.includes("type")) {
      return `tagged-branch-${index}-required`;
    }
    const variant = singleStringLiteral(properties.type, document);
    if (!variant) return `tagged-branch-${index}-literal`;
    const keys = Object.keys(properties).sort();
    const stringContent = Boolean(selectSchemaNode(properties.content, document, "string"));
    const textShaped = keys.length === 2 && keys[0] === "content" && keys[1] === "type" && stringContent;
    shapes.push(`${keys.length}${stringContent ? "s" : "x"}`);
    if (textShaped) textVariants.add(variant);
    else incompatible.add(variant);
  }
  if (textVariants.size !== 1) return `tagged-text-variants-${textVariants.size}-${shapes.join("_")}`;
  return incompatible.has([...textVariants][0]!) ? "tagged-variant-collision" : "tagged-compatible";
}

function singleStringLiteral(value: unknown, document: NormalizedSchemaDocument): string | undefined {
  const node = dereferenceSchema(value, document);
  if (!node || !schemaKeysAllowed(node, ["type", "const", "enum"])
    || (node.type !== undefined && node.type !== "string")) return undefined;
  const literal = node.const ?? (Array.isArray(node.enum) && node.enum.length === 1 ? node.enum[0] : undefined);
  return typeof literal === "string" && literal.length > 0 && literal.length <= 128 ? literal : undefined;
}

function stringEnumValues(value: unknown, document: NormalizedSchemaDocument): string[] | undefined {
  const node = dereferenceSchema(value, document);
  if (!node || !schemaKeysAllowed(node, ["type", "const", "enum"])
    || (node.type !== undefined && node.type !== "string")) return undefined;
  const values = node.const !== undefined ? [node.const] : node.enum;
  if (!Array.isArray(values) || values.length < 1 || values.length > 16
    || values.some((item) => typeof item !== "string" || item.length < 1 || item.length > 128)) return undefined;
  const output = values as string[];
  return new Set(output).size === output.length ? [...output].sort() : undefined;
}

function normalizeInputScalar(
  value: unknown,
  document: NormalizedSchemaDocument,
  spec: InputScalarSpec,
): CodeModeJson | undefined {
  const node = selectSchemaNode(value, document, spec.kind);
  if (!node) return undefined;
  if (spec.kind === "string") {
    if (!schemaKeysAllowed(node, ["type", "minLength", "maxLength"])) return undefined;
    const minimum = nonNegativeInteger(node.minLength);
    const maximum = nonNegativeInteger(node.maxLength);
    if ((node.minLength !== undefined && minimum === undefined) || (node.maxLength !== undefined && maximum === undefined)
      || (minimum !== undefined && minimum > 1)
      || (maximum !== undefined && maximum < (spec.maximumLength ?? 0))) return undefined;
    return {
      type: "string",
      ...(minimum === undefined ? {} : { minLength: minimum }),
      ...(maximum === undefined ? {} : { maxLength: maximum }),
    };
  }
  if (spec.kind === "boolean") {
    return schemaKeysAllowed(node, ["type"]) ? { type: "boolean" } : undefined;
  }
  if (!schemaKeysAllowed(node, [
    "type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  ])) return undefined;
  const minimum = finiteNumber(node.minimum);
  const maximum = finiteNumber(node.maximum);
  const exclusiveMinimum = finiteNumber(node.exclusiveMinimum);
  const exclusiveMaximum = finiteNumber(node.exclusiveMaximum);
  const multipleOf = finiteNumber(node.multipleOf);
  if ((node.minimum !== undefined && minimum === undefined) || (node.maximum !== undefined && maximum === undefined)
    || (node.exclusiveMinimum !== undefined && exclusiveMinimum === undefined)
    || (node.exclusiveMaximum !== undefined && exclusiveMaximum === undefined)
    || (node.multipleOf !== undefined && (multipleOf === undefined || !integerCompatibleMultiple(multipleOf)))
    || (minimum !== undefined && minimum > (spec.minimum ?? Number.NEGATIVE_INFINITY))
    || (exclusiveMinimum !== undefined && exclusiveMinimum >= (spec.minimum ?? Number.NEGATIVE_INFINITY))
    || (maximum !== undefined && maximum < (spec.maximum ?? Number.POSITIVE_INFINITY))
    || (exclusiveMaximum !== undefined && exclusiveMaximum <= (spec.maximum ?? Number.POSITIVE_INFINITY))) {
    return undefined;
  }
  return {
    type: "integer",
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
    ...(exclusiveMinimum === undefined ? {} : { exclusiveMinimum }),
    ...(exclusiveMaximum === undefined ? {} : { exclusiveMaximum }),
    ...(multipleOf === undefined ? {} : { multipleOf }),
  };
}

function outputValueContract(
  tool: CodeModeLogicalTool,
  value: unknown,
  document: NormalizedSchemaDocument,
  field?: "output" | "content",
): { kind: HostOutputKind; contract: CodeModeJson } | undefined {
  const text = selectSchemaNode(value, document, "string");
  if (text && schemaKeysAllowed(text, ["type", "minLength", "maxLength", "pattern", "format"])) {
    const minimum = nonNegativeInteger(text.minLength);
    const maximum = nonNegativeInteger(text.maxLength);
    if ((text.minLength !== undefined && minimum === undefined) || (text.maxLength !== undefined && maximum === undefined)
      || (text.pattern !== undefined && typeof text.pattern !== "string")
      || (text.format !== undefined && typeof text.format !== "string")) return undefined;
    return {
      kind: "text",
      contract: {
        type: "string",
        ...(minimum === undefined ? {} : { minLength: minimum }),
        ...(maximum === undefined ? {} : { maxLength: maximum }),
        ...(text.pattern === undefined ? {} : { pattern: text.pattern as string }),
        ...(text.format === undefined ? {} : { format: text.format as string }),
      },
    };
  }

  const array = selectSchemaNode(value, document, "array");
  if (!array || !schemaKeysAllowed(array, ["type", "items", "minItems", "maxItems"])
    || array.items === undefined) return undefined;
  const minimum = nonNegativeInteger(array.minItems);
  const maximum = nonNegativeInteger(array.maxItems);
  if ((array.minItems !== undefined && minimum === undefined) || (array.maxItems !== undefined && maximum === undefined)) {
    return undefined;
  }
  const bounds = {
    ...(minimum === undefined ? {} : { minItems: minimum }),
    ...(maximum === undefined ? {} : { maxItems: maximum }),
  };
  if (tool === "glob" && selectSchemaNode(array.items, document, "string")) {
    return { kind: "glob-paths", contract: { type: "array", items: "string", ...bounds } };
  }
  if (tool === "grep" && grepMatchItemSchema(array.items, document)) {
    return { kind: "grep-matches", contract: { type: "array", items: "grep-match", ...bounds } };
  }
  if (field === "content" && textPartItemSchema(array.items, document)) {
    return { kind: "text-parts", contract: { type: "array", items: "text-part", ...bounds } };
  }
  return undefined;
}

function textPartItemSchema(value: unknown, document: NormalizedSchemaDocument): boolean {
  const node = selectSchemaNode(value, document, "object");
  if (!node || !schemaKeysAllowed(node, ["type", "properties", "required", "additionalProperties"])
    || node.additionalProperties !== false || !isRecord(node.properties) || !Array.isArray(node.required)) return false;
  const properties = node.properties as Record<string, unknown>;
  const required = node.required.filter((item): item is string => typeof item === "string");
  return Object.keys(properties).length === 2 && Object.hasOwn(properties, "type") && Object.hasOwn(properties, "text")
    && required.length === node.required.length && required.length === 2
    && required.includes("type") && required.includes("text")
    && literalSchema(properties.type, document, "text")
    && Boolean(selectSchemaNode(properties.text, document, "string"));
}

function grepMatchItemSchema(value: unknown, document: NormalizedSchemaDocument): boolean {
  const node = selectSchemaNode(value, document, "object");
  if (!node || !schemaKeysAllowed(node, ["type", "properties", "required", "additionalProperties"])
    || node.additionalProperties !== false || !isRecord(node.properties) || !Array.isArray(node.required)) return false;
  const properties = node.properties as Record<string, unknown>;
  const required = node.required.filter((item): item is string => typeof item === "string");
  return Object.keys(properties).length === 3 && ["path", "line", "preview"].every((name) => Object.hasOwn(properties, name))
    && required.length === node.required.length && required.length === 3
    && ["path", "line", "preview"].every((name) => required.includes(name))
    && Boolean(selectSchemaNode(properties.path, document, "string"))
    && Boolean(selectSchemaNode(properties.line, document, "integer"))
    && Boolean(selectSchemaNode(properties.preview, document, "string"));
}

function literalSchema(value: unknown, document: NormalizedSchemaDocument, literal: string): boolean {
  const node = dereferenceSchema(value, document);
  return Boolean(node && schemaKeysAllowed(node, ["type", "const", "enum"])
    && (node.const === literal || (Array.isArray(node.enum) && node.enum.length === 1 && node.enum[0] === literal)));
}

function schemaCanBeDiscarded(value: unknown, document: NormalizedSchemaDocument): boolean {
  const node = dereferenceSchema(value, document);
  if (!node) return false;
  return codeModeUtf8Bytes(JSON.stringify(node)) <= MAX_HOST_SCHEMA_BYTES;
}

function normalizeSchemaDocument(value: unknown): NormalizedSchemaDocument | undefined {
  try {
    let rootValue: unknown;
    let definitionValue: unknown = {};
    if (Schema.isSchema(value)) {
      const generated = Schema.toJsonSchemaDocument(value, { onExcessProperty: "error" });
      rootValue = generated.schema;
      definitionValue = generated.definitions;
    } else if (isPlainRecord(value) && typeof value.dialect === "string"
      && Object.hasOwn(value, "schema") && Object.hasOwn(value, "definitions")) {
      if (!["draft-2020-12", "draft-07", "openapi-3.1"].includes(value.dialect)) return undefined;
      rootValue = value.schema;
      definitionValue = value.definitions;
    } else {
      rootValue = value;
    }
    const root = cloneSchemaRecord(rootValue);
    const generatedDefinitions = cloneSchemaRecord(definitionValue);
    if (!root || !generatedDefinitions) return undefined;
    const definitions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const source of [generatedDefinitions, root.$defs, root.definitions]) {
      if (source === undefined) continue;
      const record = cloneSchemaRecord(source);
      if (!record) return undefined;
      for (const [key, item] of Object.entries(record)) {
        if (Object.hasOwn(definitions, key) && JSON.stringify(definitions[key]) !== JSON.stringify(item)) return undefined;
        definitions[key] = item;
      }
    }
    if (codeModeUtf8Bytes(JSON.stringify({ root, definitions })) > MAX_HOST_SCHEMA_BYTES) return undefined;
    return { root, definitions };
  } catch {
    return undefined;
  }
}

function cloneSchemaRecord(value: unknown): Record<string, unknown> | undefined {
  const cloned = cloneSchemaValue(value, 0, { items: 0 });
  return isRecord(cloned) ? cloned : undefined;
}

function cloneSchemaValue(value: unknown, depth: number, state: { items: number }): unknown {
  if (depth > MAX_HOST_SCHEMA_DEPTH || state.items > MAX_HOST_SCHEMA_ITEMS) throw new Error("Schema host fuera de limites.");
  state.items += 1;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_HOST_SCHEMA_ITEMS) throw new Error("Schema host fuera de limites.");
    return value.map((item) => cloneSchemaValue(item, depth + 1, state));
  }
  if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw new Error("Schema host no serializable.");
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_HOST_SCHEMA_PROPERTIES || keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key))) {
    throw new Error("Schema host inseguro.");
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || descriptor.value === undefined
      || typeof descriptor.value === "function" || typeof descriptor.value === "symbol" || typeof descriptor.value === "bigint") {
      throw new Error("Schema host no serializable.");
    }
    output[key] = cloneSchemaValue(descriptor.value, depth + 1, state);
  }
  return output;
}

function selectSchemaNode(
  value: unknown,
  document: NormalizedSchemaDocument,
  expected: "string" | "integer" | "boolean" | "object" | "array",
): Record<string, unknown> | undefined {
  const node = dereferenceSchema(value, document);
  if (!node) return undefined;
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (union) {
    const candidates = union.filter((item) => !isNullSchema(item, document));
    if (candidates.length !== 1 || candidates.length + union.filter((item) => isNullSchema(item, document)).length !== union.length) {
      return undefined;
    }
    return selectSchemaNode(candidates[0], document, expected);
  }
  const types = Array.isArray(node.type) ? node.type : typeof node.type === "string" ? [node.type] : [];
  const accepted = expected === "integer" ? new Set(["integer", "number", "null"]) : new Set([expected, "null"]);
  if (types.length === 0 || types.some((type) => typeof type !== "string" || !accepted.has(type))
    || !types.some((type) => expected === "integer" ? type === "integer" || type === "number" : type === expected)) {
    return undefined;
  }
  return node;
}

function dereferenceSchema(
  value: unknown,
  document: NormalizedSchemaDocument,
  seen: Set<string> = new Set(),
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.$ref === "string") {
    const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(value.$ref);
    if (!match || !schemaKeysAllowed(value, ["$ref"])) return undefined;
    const key = match[1]!.replaceAll("~1", "/").replaceAll("~0", "~");
    if (seen.has(key) || !Object.hasOwn(document.definitions, key)) return undefined;
    const next = new Set(seen);
    next.add(key);
    return dereferenceSchema(document.definitions[key], document, next);
  }
  if (Array.isArray(value.allOf)) {
    if (value.allOf.length !== 1 || !schemaKeysAllowed(value, ["allOf"])) return undefined;
    return dereferenceSchema(value.allOf[0], document, seen);
  }
  return value;
}

function isNullSchema(value: unknown, document: NormalizedSchemaDocument): boolean {
  const node = dereferenceSchema(value, document);
  if (!node) return false;
  return node.const === null || node.type === "null"
    || (Array.isArray(node.type) && node.type.length === 1 && node.type[0] === "null");
}

function schemaKeysAllowed(value: Record<string, unknown>, semantic: readonly string[]): boolean {
  const allowed = new Set([...semantic, ...SCHEMA_ANNOTATION_KEYS, ...SCHEMA_DEFINITION_KEYS]);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerCompatibleMultiple(value: number): boolean {
  return value > 0 && value <= 1 && Number.isSafeInteger(1 / value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fingerprintTool(name: string, tool: HostToolDefinition): string {
  return sha256(canonicalCodeModeJson({
    id: tool.id || name,
    name: tool.name || name,
    input: tool.inputContract,
    output: tool.outputContract,
    outputAdapter: canonicalOutputAdapter(tool.outputAdapter),
    options: tool.optionsContract,
  }));
}

function canonicalOutputAdapter(adapter: HostOutputAdapter): CodeModeJson {
  return {
    source: adapter.source,
    kind: adapter.kind,
    allowedKeys: [...adapter.allowedKeys].sort(),
    ...(adapter.field === undefined ? {} : { field: adapter.field }),
    ...(adapter.variant === undefined ? {} : { variant: adapter.variant }),
    ...(adapter.deniedVariants === undefined ? {} : { deniedVariants: [...adapter.deniedVariants].sort() }),
  };
}

function catalogHash(tools: Map<CodeModeLogicalTool, CapturedTool>): string {
  return sha256([...tools.values()].sort((a, b) => a.logical.localeCompare(b.logical))
    .map((tool) => `${tool.logical}:${tool.fingerprint}`).join("\n"));
}

function requiredString(value: unknown, name: string, max = 4_096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new CodeModeExecutionError("INVALID_INPUT");
  }
  return value;
}

function optionalString(value: unknown, name: string, max = 4_096): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, max);
}

function optionalInteger(value: unknown, _name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CodeModeExecutionError("INVALID_INPUT");
  }
  return value as number;
}

function canonicalRelativePath(value: string): string {
  const normalized = requiredString(value, "path").replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) throw new CodeModeExecutionError("INVALID_INPUT");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) throw new CodeModeExecutionError("INVALID_INPUT");
  const relative = path.posix.normalize(normalized).replace(/^\.\//, "");
  if (relative === ".." || relative.startsWith("../")) throw new CodeModeExecutionError("INVALID_INPUT");
  return relative || ".";
}

function assertSafePattern(pattern: string, root: string): void {
  if (pattern.includes("\0") || path.isAbsolute(pattern) || /(^|[\\/])\.\.([\\/]|$)/.test(pattern)) {
    throw new CodeModeExecutionError("INVALID_INPUT");
  }
  const prefix = pattern.replaceAll("\\", "/").split(/[?*[\]{}!]/, 1)[0]?.replace(/\/$/, "") ?? "";
  if (prefix) {
    const relative = canonicalRelativePath(prefix);
    const absolute = path.resolve(root, relative);
    if (isPotentialSecretPath(relative) || isHiddenOrGitPath(relative)
      || classifyInfrastructurePath(root, absolute).protected) throw new CodeModeExecutionError("R0_ONLY");
  }
}

function assertInsideRoot(target: string, root: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new CodeModeExecutionError("INVALID_INPUT");
}

function assertNoSymlinkPath(target: string, root: string): void {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = safeLstat(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new CodeModeExecutionError("R0_ONLY");
  }
}

function safeLstat(target: string): fs.Stats | undefined {
  try { return fs.lstatSync(target); } catch { return undefined; }
}

function validateEffectResource(
  tool: CodeModeLogicalTool,
  canonical: CanonicalCallInput,
  root: string,
): ResourceLease {
  assertInsideRoot(canonical.absolute, root);
  assertNoSymlinkPath(canonical.absolute, root);
  if (isPotentialSecretPath(canonical.relative) || isHiddenOrGitPath(canonical.relative)
    || classifyInfrastructurePath(root, canonical.absolute).protected) {
    throw new CodeModeExecutionError("R0_ONLY");
  }
  const before = pathIdentity(canonical.absolute);
  if (!before || (tool === "read" && before.kind !== "file")
    || (tool !== "read" && before.kind !== "file" && before.kind !== "directory")) {
    throw new CodeModeExecutionError("R0_ONLY");
  }

  let descriptor: number | undefined;
  if (tool === "read") {
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(canonical.absolute, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || !sameFileIdentity(before, identityFromStat(opened, "file"), true)
        || !looksLikeTextDescriptor(descriptor, opened.size)) {
        throw new CodeModeExecutionError("R0_ONLY");
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
        descriptor = undefined;
      }
      if (error instanceof CodeModeExecutionError) throw error;
      throw new CodeModeExecutionError("R0_ONLY");
    }
  }

  let closed = false;
  return {
    verify() {
      assertInsideRoot(canonical.absolute, root);
      assertNoSymlinkPath(canonical.absolute, root);
      const after = pathIdentity(canonical.absolute);
      if (!after || !sameFileIdentity(before, after, tool === "read")) throw new CodeModeExecutionError("R0_ONLY");
      if (descriptor !== undefined) {
        const opened = identityFromStat(fs.fstatSync(descriptor), "file");
        if (!sameFileIdentity(before, opened, true)) throw new CodeModeExecutionError("R0_ONLY");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* cleanup best effort */ }
        descriptor = undefined;
      }
    },
  };
}

interface PathIdentity {
  kind: "file" | "directory";
  device: number;
  inode: number;
  size: number;
  modified: number;
  real: string;
}

function pathIdentity(target: string): PathIdentity | undefined {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return undefined;
    return {
      ...identityFromStat(stat, stat.isFile() ? "file" : "directory"),
      real: fs.realpathSync(target),
    };
  } catch {
    return undefined;
  }
}

function identityFromStat(stat: fs.Stats, kind: PathIdentity["kind"]): PathIdentity {
  return {
    kind,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modified: stat.mtimeMs,
    real: "",
  };
}

function sameFileIdentity(left: PathIdentity, right: PathIdentity, includeContentState: boolean): boolean {
  return left.kind === right.kind && left.device === right.device && left.inode === right.inode
    && (!left.real || !right.real || left.real === right.real)
    && (!includeContentState || (left.size === right.size && left.modified === right.modified));
}

function looksLikeTextDescriptor(descriptor: number, size: number): boolean {
  try {
    const bytes = Buffer.alloc(Math.min(8_192, Math.max(1, size)));
    const read = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const sample = bytes.subarray(0, read);
    if (sample.includes(0)) return false;
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: size > read });
    return true;
  } catch {
    return false;
  }
}

function isHiddenOrGitPath(relative: string): boolean {
  return relative.replaceAll("\\", "/").split("/").some((segment) => segment === ".git" || (segment.startsWith(".") && segment !== "."));
}

function boundaryLimits(maxBytes: number) {
  return {
    maxDepth: CODE_MODE_LIMITS.maxDepth,
    maxProperties: CODE_MODE_LIMITS.maxProperties,
    maxItems: CODE_MODE_LIMITS.maxItems,
    maxBytes,
  };
}

function exactRecord(value: unknown, keys: readonly string[], optional = false): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const own = Object.keys(value);
  return own.every((key) => keys.includes(key)) && (optional || keys.every((key) => Object.hasOwn(value, key)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
