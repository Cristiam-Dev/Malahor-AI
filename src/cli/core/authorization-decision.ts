import {
  DEFAULT_PLANNING_AUTHORITY,
  validState,
  type PlanScope,
  type PlanState,
} from "./planning";
import type { PlanningAuthority } from "./planning-authority";
import type { ActionIntentV1 } from "./action-intent";

export const AUTHORIZATION_DENIAL_CODES = [
  "NO_ACTIVE_PLAN",
  "PLAN_INVALID",
  "PLAN_NOT_RUNNING",
  "PLAN_SCHEMA_UPGRADE_REQUIRED",
  "SESSION_MISMATCH",
  "PROJECT_MISMATCH",
  "MODE_MISMATCH",
  "POLICY_CHANGED",
  "ACTION_NOT_DECLARED",
  "ACTION_NOT_CANONICALIZABLE",
  "ACTION_SERIALIZATION_MISMATCH",
  "ACTION_REPAIR_EXHAUSTED",
  "RESOURCE_OUTSIDE_SCOPE",
  "PROTECTED_APPROVAL_REQUIRED",
  "HOST_ASK",
  "HOST_DENY",
  "CRITICAL_CONTROL_UNAVAILABLE",
] as const;

export type AuthorizationDenialCode = typeof AUTHORIZATION_DENIAL_CODES[number];

export type AuthorizationDecision =
  | { effect: "allow"; code: "AUTHORIZED"; actionID: string }
  | { effect: "defer"; code: "DEFER_TO_TOOL_HOOK" }
  | { effect: "deny"; code: AuthorizationDenialCode; safeDetail?: string };

export interface AuthorizationDecisionInput {
  state?: unknown;
  scope?: PlanScope;
  action?: Partial<ActionIntentV1>;
  declaredActionIDs?: readonly string[];
  canonicalization?: { status?: "ok" | "error"; code?: string };
  serialization?: { matches?: boolean };
  resourceScope?: { inside?: boolean };
  protectedApproval?: { required?: boolean; approved?: boolean };
  host?: { effect?: "allow" | "warn" | "ask" | "deny" };
  criticalControls?: Record<string, boolean | undefined>;
  deferToToolHook?: boolean;
  now?: number;
  authority?: PlanningAuthority;
}

export class PlanningAuthorizationError extends Error {
  readonly code: AuthorizationDenialCode;

  constructor(code: AuthorizationDenialCode, safeDetail?: string) {
    super(authorizationMessage(code, safeDetail));
    this.name = "PlanningAuthorizationError";
    this.code = code;
  }
}

/** Policy Decision Point único para permission/tool hooks. */
export function decideAuthorization(raw: AuthorizationDecisionInput | Record<string, unknown>): AuthorizationDecision {
  const input = raw as AuthorizationDecisionInput;
  const state = input.state;
  if (state === undefined || state === null) return deny("NO_ACTIVE_PLAN");

  // Un V4 activo nunca se ejecuta ni se convierte. La comprobación precede a
  // la firma para devolver siempre un bloqueo seguro y accionable incluso si
  // el caller no dispone todavía de la autoridad que creó el estado legado.
  if (record(state)?.version === 4 && !isTerminalPhase(record(state)?.phase)) {
    return deny("PLAN_SCHEMA_UPGRADE_REQUIRED");
  }

  const authority = input.authority ?? DEFAULT_PLANNING_AUTHORITY;
  if (!validState(state, authority)) return deny("PLAN_INVALID");
  if (state.version !== 5) return deny("PLAN_NOT_RUNNING");
  if (state.phase !== "running" || state.mode === "advisor") return deny("PLAN_NOT_RUNNING");
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || state.createdAt > now || state.updatedAt > now) return deny("PLAN_INVALID");

  const scope = input.scope;
  if (!scope || state.sessionID !== scope.sessionID) return deny("SESSION_MISMATCH");
  if (state.project !== scope.project) return deny("PROJECT_MISMATCH");
  if (state.mode !== scope.mode) return deny("MODE_MISMATCH");
  if (state.policyRevision !== scope.policyRevision) return deny("POLICY_CHANGED");

  if (input.canonicalization?.status === "error") {
    return deny(isDenialCode(input.canonicalization.code)
      ? input.canonicalization.code
      : "ACTION_NOT_CANONICALIZABLE");
  }
  if (input.serialization?.matches === false) return deny("ACTION_SERIALIZATION_MISMATCH");
  if (input.resourceScope?.inside === false) return deny("RESOURCE_OUTSIDE_SCOPE");
  if (input.protectedApproval?.required === true && input.protectedApproval.approved !== true) {
    return deny("PROTECTED_APPROVAL_REQUIRED");
  }
  if (input.host?.effect === "deny") return deny("HOST_DENY");
  if (input.host?.effect === "ask") return deny("HOST_ASK");

  const controls = input.criticalControls;
  if (controls && Object.values(controls).some((available) => available !== true)) {
    return deny("CRITICAL_CONTROL_UNAVAILABLE");
  }
  if (input.deferToToolHook === true) {
    return controls?.toolHook === true
      ? { effect: "defer", code: "DEFER_TO_TOOL_HOOK" }
      : deny("CRITICAL_CONTROL_UNAVAILABLE");
  }

  const actionID = input.action?.actionID;
  if (typeof actionID !== "string" || !/^[a-f0-9]{64}$/.test(actionID)) return deny("ACTION_NOT_DECLARED");
  const declared = input.declaredActionIDs ?? state.actionIntents.map((intent) => intent.actionID);
  if (!declared.includes(actionID)) return deny("ACTION_NOT_DECLARED");
  return { effect: "allow", code: "AUTHORIZED", actionID };
}

export function assertAuthorization(decision: AuthorizationDecision): asserts decision is Extract<AuthorizationDecision, { effect: "allow" }> {
  if (decision.effect === "deny") throw new PlanningAuthorizationError(decision.code, decision.safeDetail);
  if (decision.effect === "defer") {
    throw new PlanningAuthorizationError("CRITICAL_CONTROL_UNAVAILABLE", "La segunda frontera aún no evaluó la acción.");
  }
}

export function authorizationMessage(code: AuthorizationDenialCode, detail?: string): string {
  const base: Record<AuthorizationDenialCode, string> = {
    NO_ACTIVE_PLAN: "Malahor: no hay un plan activo para esta sesión.",
    PLAN_INVALID: "Malahor: el estado del plan no es verificable.",
    PLAN_NOT_RUNNING: "Malahor: el plan no está aprobado y en ejecución.",
    PLAN_SCHEMA_UPGRADE_REQUIRED: "Malahor: el plan activo usa un contrato anterior; presenta y revisa una revisión V5.",
    SESSION_MISMATCH: "Malahor: el plan pertenece a otra sesión.",
    PROJECT_MISMATCH: "Malahor: el plan pertenece a otro proyecto.",
    MODE_MISMATCH: "Malahor: el modo efectivo cambió desde la revisión.",
    POLICY_CHANGED: "Malahor: la política efectiva cambió desde la revisión.",
    ACTION_NOT_DECLARED: "Malahor: la acción no está declarada en la revisión aprobada.",
    ACTION_NOT_CANONICALIZABLE: "Malahor: la acción no puede representarse con el canonicalizador cerrado.",
    ACTION_SERIALIZATION_MISMATCH: "Malahor: la representación técnica no coincide con los intents firmados.",
    ACTION_REPAIR_EXHAUSTED: "Malahor: la reparación técnica equivalente ya fue consumida o dejó de ser verificable.",
    RESOURCE_OUTSIDE_SCOPE: "Malahor: un recurso queda fuera del alcance aprobado.",
    PROTECTED_APPROVAL_REQUIRED: "Malahor: la operación protegida requiere su aprobación específica.",
    HOST_ASK: "Malahor: el host requiere una aprobación humana específica.",
    HOST_DENY: "Malahor: el host denegó la operación.",
    CRITICAL_CONTROL_UNAVAILABLE: "Malahor: un control crítico de autorización no está disponible.",
  };
  return detail ? `${base[code]} ${detail}` : base[code];
}

function deny(code: AuthorizationDenialCode): AuthorizationDecision {
  return { effect: "deny", code };
}

function isDenialCode(value: unknown): value is AuthorizationDenialCode {
  return typeof value === "string" && (AUTHORIZATION_DENIAL_CODES as readonly string[]).includes(value);
}

function isTerminalPhase(value: unknown): boolean {
  return value === "completed" || value === "revoked" || value === "superseded";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

// Mantiene el import de PlanState comprobado por TypeScript cuando evolucione
// el contrato; evita que este PDP derive una forma paralela del estado.
type _PlanStateContract = PlanState;
