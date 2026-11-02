import { consumeApproval } from "./approvals";
import { writeAudit } from "./audit";
import { builtInHookRules } from "./rules";
import type {
  HookContext,
  HookDecision,
  HookRemediation,
  HookRemovalReason,
  HookResult,
  HookRule,
  HookViolation,
} from "./types";

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
      // Un error de control puede contener command, paths, payloads o datos del
      // proveedor. El resultado cruza hacia UI/auditoria: falla cerrado sin
      // propagar el detalle no confiable.
      void error;
      return [{
        id: critical ? "MAL-HOOK-CONTROL-ERROR" : "MAL-HOOK-CONTROL-WARN",
        decision: critical ? "deny" : "warn",
        message: `El control ${rule.id} no pudo evaluarse; detalle omitido por seguridad.`,
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
    const remediation = formatHookRemediations(violation.remediations ?? []);
    if (remediation) lines.push(...remediation.split("\n"));
  }

  if (result.violations.length === 0) {
    lines.push("- OK: sin hallazgos.");
  }

  if (result.decision === "ask") {
    lines.push("- ASK pendiente: no autoriza ejecutar; requiere aprobacion humana verificable.");
  }

  return lines.join("\n");
}

export function formatHookRemediations(remediations: readonly HookRemediation[]): string {
  return remediations.slice(0, 5).flatMap((remediation) => {
    const target = `${safeOutput(remediation.path, 512)}:${remediation.startLine}`;
    if (remediation.kind === "replace-block") {
      return [
        "  Remediacion manual segura:",
        `  1. Abre ${target}.`,
        `  2. Localiza la linea por el texto ${safeOutput(remediation.anchor, 128)}.`,
        "  3. Referencia saneada (el valor bloqueado no se muestra):",
        ...remediation.before.map((line) => `     ${safeOutput(line, 1_000)}`),
        "  4. Reemplaza esa linea o bloque completo por:",
        ...remediation.replacement.map((line) => `     ${safeOutput(line, 1_000)}`),
        "  5. Guarda el archivo y pide a Malahor revalidar. No continues hasta obtener ALLOW.",
      ];
    }
    const eligibility = remediation.reason ? removalReasonMessage(remediation.reason) : undefined;
    return [
      "  Accion manual segura:",
      ...(eligibility ? [`  Motivo seguro (${remediation.reason}): ${eligibility}`] : []),
      `  1. Abre ${target}; no copies ni compartas el valor detectado.`,
      "  2. Retira la credencial del archivo y usa una variable segura o un gestor de secretos.",
      "  3. Si el valor pudo ser real, rotalo antes de continuar.",
      "  4. Guarda el archivo y pide a Malahor revalidar. No continues hasta obtener ALLOW.",
    ];
  }).join("\n");
}

function removalReasonMessage(reason: HookRemovalReason): string {
  const messages: Record<HookRemovalReason, string> = {
    "unsupported-file-type": "el archivo no es un fixture JavaScript/TypeScript elegible",
    "line-too-long": "la linea supera el limite seguro para construir una receta",
    "multiple-findings": "la linea contiene varios hallazgos y seria ambiguo transformarla",
    "value-not-demonstrably-synthetic": "el valor no demuestra ser un dato sintetico permitido",
    "unsupported-syntax": "la sintaxis no pertenece al subconjunto que el hook puede reescribir con seguridad",
  };
  return messages[reason];
}

function safeOutput(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, maxLength);
}

function strongestDecision(violations: HookViolation[]): HookDecision {
  return violations.reduce<HookDecision>((current, violation) => (
    DECISION_WEIGHT[violation.decision] > DECISION_WEIGHT[current] ? violation.decision : current
  ), "allow");
}
