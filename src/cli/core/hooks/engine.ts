import { builtInHookRules } from "./rules";
import type { HookContext, HookDecision, HookResult, HookViolation } from "./types";

const DECISION_WEIGHT: Record<HookDecision, number> = {
  allow: 0,
  warn: 1,
  ask: 2,
  deny: 3,
};

export function runHooks(context: HookContext): HookResult {
  if (context.profile === "off") {
    return { event: context.event, profile: context.profile, decision: "allow", violations: [] };
  }

  const violations = builtInHookRules.flatMap((rule) => rule.run(context));

  return {
    event: context.event,
    profile: context.profile,
    decision: strongestDecision(violations),
    violations,
  };
}

export function assertHooksAllowed(context: HookContext): HookResult {
  const result = runHooks(context);
  const denied = result.violations.filter((violation) => violation.decision === "deny");

  if (denied.length > 0) {
    throw new Error(formatHookResult(result));
  }

  return result;
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

  return lines.join("\n");
}

function strongestDecision(violations: HookViolation[]): HookDecision {
  return violations.reduce<HookDecision>((current, violation) => (
    DECISION_WEIGHT[violation.decision] > DECISION_WEIGHT[current] ? violation.decision : current
  ), "allow");
}
