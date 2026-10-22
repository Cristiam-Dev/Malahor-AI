import { consumeApproval } from "./approvals";
import { writeAudit } from "./audit";
import { builtInHookRules } from "./rules";
import type { HookContext, HookDecision, HookResult, HookRule, HookViolation } from "./types";

const DECISION_WEIGHT: Record<HookDecision, number> = {
  allow: 0,
  warn: 1,
  ask: 2,
  deny: 3,
};

export function runHooks(context: HookContext): HookResult {
  const violations = evaluateHookRules(context);

  return {
    event: context.event,
    profile: context.profile,
    decision: strongestDecision(violations),
    violations,
    policy: context.policyMeta,
  };
}

export function evaluateHookRules(context: HookContext, rules: HookRule[] = builtInHookRules): HookViolation[] {
  return rules.flatMap((rule) => {
    try {
      return rule.run(context);
    } catch (error) {
      const critical = rule.critical !== false;
      const detail = error instanceof Error ? error.message : String(error);
      return [{
        id: critical ? "MAL-HOOK-CONTROL-ERROR" : "MAL-HOOK-CONTROL-WARN",
        decision: critical ? "deny" : "warn",
        message: `El control ${rule.id} no pudo evaluarse: ${detail}`,
        fix: critical
          ? "Corrige el control o la politica antes de ejecutar la operacion protegida."
          : "Revisa el control; la operacion auxiliar puede continuar con aviso.",
      }];
    }
  });
}

export function assertHooksAllowed(context: HookContext): HookResult {
  let result = runHooks(context);

  if (result.decision === "ask") {
    if (!context.approval) {
      result = auditHookResult(
        context,
        deniedResult(result, "MAL-HOOK-APPROVAL-MISSING", "ASK pendiente sin aprobacion humana verificable."),
      );
      throw new Error(formatHookResult(result));
    }

    const consumed = consumeApproval(context.approval, context);
    if (!consumed.ok) {
      result = auditHookResult(
        context,
        deniedResult(result, "MAL-HOOK-APPROVAL-INVALID", consumed.reason ?? "aprobacion invalida"),
      );
      throw new Error(formatHookResult(result));
    }

    result = {
      ...result,
      decision: "allow",
      approvalRef: context.approval,
      violations: [
        ...result.violations,
        {
          id: "MAL-HOOK-APPROVAL-OK",
          decision: "allow",
          message: "Aprobacion humana verificada y consumida para esta operacion.",
          fix: "No reutilices la aprobacion; si cambia la operacion, genera una nueva.",
        },
      ],
    };
  }

  result = auditHookResult(context, result);
  if (result.decision === "deny") {
    throw new Error(formatHookResult(result));
  }

  return result;
}

export function auditHookResult(context: HookContext, result: HookResult): HookResult {
  const audit = writeAudit(context, result);
  if (audit.required && !audit.ok) {
    return deniedResult(result, "MAL-HOOK-AUDIT", `Auditoria obligatoria no disponible: ${audit.error ?? "error desconocido"}`);
  }
  if (!audit.ok && !audit.skipped) {
    const violations: HookViolation[] = [
      ...result.violations,
      {
        id: "MAL-HOOK-AUDIT-WARN",
        decision: "warn",
        message: `Auditoria auxiliar no disponible: ${audit.error ?? "error desconocido"}`,
        fix: "Revisa permisos y espacio del directorio de auditoria local.",
      },
    ];
    return { ...result, decision: strongestDecision(violations), violations };
  }
  return result;
}

function deniedResult(result: HookResult, id: string, message: string): HookResult {
  return {
    ...result,
    decision: "deny",
    violations: [
      ...result.violations,
      {
        id,
        decision: "deny",
        message,
        fix: "Resuelve la aprobacion/auditoria antes de ejecutar la operacion.",
      },
    ],
  };
}

export function hookExitCode(decision: HookDecision): number {
  if (decision === "deny") return 2;
  if (decision === "ask") return 3;
  return 0;
}

export function formatHookResult(result: HookResult): string {
  const lines = [`Hooks: ${result.decision.toUpperCase()} ${result.event} (${result.profile})`];

  for (const violation of result.violations) {
    lines.push(`- ${violation.decision.toUpperCase()} ${violation.id}: ${violation.message}`);
    lines.push(`  Fix: ${violation.fix}`);
  }

  if (result.violations.length === 0) {
    lines.push("- OK: sin hallazgos.");
  }

  if (result.decision === "ask") {
    lines.push("- ASK pendiente: no autoriza ejecutar; requiere aprobacion humana verificable.");
  }

  return lines.join("\n");
}

function strongestDecision(violations: HookViolation[]): HookDecision {
  return violations.reduce<HookDecision>((current, violation) => (
    DECISION_WEIGHT[violation.decision] > DECISION_WEIGHT[current] ? violation.decision : current
  ), "allow");
}
