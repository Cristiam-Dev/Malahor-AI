import fs from "node:fs";
import path from "node:path";
import type { HookContext, HookProfile, HookRule, HookViolation } from "./types";

export const builtInHookRules: HookRule[] = [
  { id: "repo-boundary", run: repoBoundaryGuard },
  { id: "destructive-memory", run: destructiveMemoryGuard },
  { id: "policy-safety", run: policySafetyGuard },
  { id: "dangerous-git", run: dangerousGitGuard },
  { id: "git-consent", run: gitConsentGuard },
  { id: "commit-message", run: commitMessageGuard },
  { id: "secret-scan", run: secretScanGuard },
  { id: "programming-quality", run: programmingQualityGuard },
];

function repoBoundaryGuard(context: HookContext): HookViolation[] {
  const writesMalahorData = Boolean(context.metadata?.writesMalahorData);
  if (!writesMalahorData || !context.targetPaths || context.targetPaths.length === 0) return [];

  const unsafe = context.targetPaths
    .map((targetPath) => path.resolve(context.cwd, targetPath))
    .filter((targetPath) => isInside(targetPath, context.projectRoot) && !isInside(targetPath, context.malahorHome));

  if (unsafe.length === 0) return [];

  return [{
    id: "MAL-HOOK-REPO-BOUNDARY",
    decision: "deny",
    message: `Malahor no debe escribir memoria/configuracion/grafos/assets dentro del repo: ${unsafe.join(", ")}`,
    fix: "Escribe datos operativos en ~/.malahor o usa MALAHOR_HOME fuera del repo.",
  }];
}

function destructiveMemoryGuard(context: HookContext): HookViolation[] {
  if (context.policy?.memory.destructiveRequiresPreview === false) return [];
  const destructiveEvents = new Set(["memory.delete.apply", "memory.move.apply", "memory.restore.apply"]);
  if (!destructiveEvents.has(context.event)) return [];

  const previewToken = typeof context.metadata?.previewToken === "string" ? context.metadata.previewToken : "";
  const expectedConfirmation = typeof context.metadata?.requiresConfirmation === "string" ? context.metadata.requiresConfirmation : "";
  const violations: HookViolation[] = [];

  if (!previewToken) {
    violations.push({
      id: "MAL-HOOK-MEM-PREVIEW",
      decision: "deny",
      message: "Operacion destructiva de memoria sin preview previo.",
      fix: "Ejecuta primero la herramienta *_preview correspondiente y muestra el impacto al usuario.",
    });
  }

  if (!expectedConfirmation || context.confirmation !== expectedConfirmation) {
    violations.push({
      id: "MAL-HOOK-MEM-CONFIRM",
      decision: "deny",
      message: "Confirmacion fuerte ausente o invalida para memoria destructiva.",
      fix: `Usa confirmacion exacta: ${expectedConfirmation || "<requiresConfirmation del preview>"}`,
    });
  }

  return violations;
}

function policySafetyGuard(context: HookContext): HookViolation[] {
  if (context.event !== "install.beforePolicy" && context.event !== "update.preflight") return [];

  const violations: HookViolation[] = [];
  if (context.policy?.policy.enforceDeferredPolicy !== false && context.metadata?.appliesPolicyBeforeValidation === true) {
    violations.push({
      id: "MAL-HOOK-POLICY-DEFER",
      decision: "deny",
      message: "La politica de agente no puede aplicarse antes de validar instalacion/update.",
      fix: "Ejecuta assets/Mnemo/comandos/Graphify/validateInstallation y aplica politica al final.",
    });
  }
  if (context.policy?.policy.blockTotalBashDeny !== false && context.metadata?.bashDenyTotal === true) {
    violations.push({
      id: "MAL-HOOK-POLICY-BASH-DENY",
      decision: "deny",
      message: "guiar/acompanar no pueden escribir bash:'deny' total.",
      fix: "Usa whitelist v2 con doctor/context/graphify allow e install/update ask.",
    });
  }

  return violations;
}

function dangerousGitGuard(context: HookContext): HookViolation[] {
  if (context.policy?.git.blockDestructiveCommands === false) return [];
  const command = (context.command ?? "").trim();
  if (!command && !context.event.startsWith("git.")) return [];

  const checks: Array<[RegExp, string, string]> = [
    [/\bgit\s+reset\s+--hard\b/, "git reset --hard descarta trabajo local.", "Pide confirmacion fuerte y respaldo; preferir reset no destructivo."],
    [/\bgit\s+clean\s+-[^\n]*[fd]/, "git clean -fd borra archivos no rastreados.", "Usa dry-run `git clean -nd` y confirmacion explicita antes."],
    [/\bgit\s+checkout\s+(--\s*)?\.\b/, "git checkout -- . descarta cambios del usuario.", "No revertir trabajo ajeno; limita el path y pide confirmacion fuerte."],
    [/\bgit\s+push\b[^\n]*(--force|-f)\b/, "push --force puede sobrescribir historia remota.", "Usa --force-with-lease solo con confirmacion fuerte y razon documentada."],
    [/\bgit\s+commit\b[^\n]*--amend\b/, "commit --amend reescribe historia local.", "Evitalo salvo pedido explicito del usuario."],
  ];

  return checks
    .filter(([pattern]) => pattern.test(command))
    .map(([, message, fix]) => ({ id: "MAL-HOOK-GIT-DESTRUCTIVE", decision: "deny", message, fix }));
}

function gitConsentGuard(context: HookContext): HookViolation[] {
  const command = (context.command ?? "").trim();
  if (!command || context.metadata?.validationOnly === true) return [];

  if (context.event === "git.commit.before" && /\bgit\s+commit\b/.test(command) && !hasConsent(context, "USER_REQUESTED_COMMIT", "userExplicitlyRequestedCommit")) {
    return [{
      id: "MAL-HOOK-GIT-CONSENT",
      decision: "deny",
      message: "git commit requiere pedido explicito del usuario; 'continuar', 'cerrar fase' o 'implementar' no autorizan commitear.",
      fix: "No ejecutes el commit. Pide confirmacion explicita o valida con confirmacion USER_REQUESTED_COMMIT si el usuario pidio commitear.",
    }];
  }

  if (context.event === "file.stage.before" && /\bgit\s+add\b/.test(command) && !hasConsent(context, "USER_REQUESTED_STAGE", "userExplicitlyRequestedStage")) {
    return [{
      id: "MAL-HOOK-GIT-STAGE-CONSENT",
      decision: "deny",
      message: "git add/stage requiere pedido explicito del usuario; preparar cambios no equivale a staging.",
      fix: "No ejecutes git add. Pide confirmacion explicita o valida con confirmacion USER_REQUESTED_STAGE si el usuario pidio stagear.",
    }];
  }

  return [];
}

function commitMessageGuard(context: HookContext): HookViolation[] {
  if (context.policy?.git.validateCommitMessage === false) return [];
  if (context.event !== "git.commit.before" || !context.command) return [];

  const message = extractCommitMessage(context.command);
  if (!message) return [];

  const valid = /^[^\w\s]\s+(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?:\s+\S.{0,80}$/u.test(message);
  if (valid) return [];

  return [{
    id: "MAL-HOOK-COMMIT-MESSAGE",
    decision: strictness(context.profile, "ask"),
    message: `Mensaje de commit fuera del formato Malahor: ${message}`,
    fix: "Usa icono + Conventional Commit en espanol, ej. `🧠 feat(memoria): agrega hooks seguros`.",
  }];
}

function secretScanGuard(context: HookContext): HookViolation[] {
  if (context.policy?.secrets.scanBeforeCommit === false) return [];
  const paths = readableTargetPaths(context);
  const leaks = paths.flatMap((targetPath) => scanFileForSecrets(targetPath));

  if (leaks.length === 0) return [];

  return [{
    id: "MAL-HOOK-SECRETS",
    decision: "deny",
    message: `Posibles secretos detectados: ${leaks.slice(0, 5).join(", ")}`,
    fix: "Remueve secretos, usa variables de entorno/secret manager y rota credenciales si fueron expuestas.",
  }];
}

function programmingQualityGuard(context: HookContext): HookViolation[] {
  const violations: HookViolation[] = [];
  const files = context.targetPaths ?? [];

  if (context.policy?.git.requireChecksBeforePush !== false && context.event === "git.push.before" && context.confirmation !== "CHECKS_OK") {
    violations.push({
      id: "MAL-HOOK-PUSH-CHECKS",
      decision: strictness(context.profile, "ask"),
      message: "Push sin evidencia de checks recientes.",
      fix: "Corre tests/build relevantes o pasa confirmacion CHECKS_OK si ya validaste.",
    });
  }

  const largeFiles = context.policy?.quality.warnLargeFiles === false ? [] : files.filter((file) => fileSize(path.resolve(context.cwd, file)) > 1024 * 1024);
  if (largeFiles.length > 0) {
    violations.push({
      id: "MAL-HOOK-LARGE-FILES",
      decision: "warn",
      message: `Archivos grandes en cambios: ${largeFiles.join(", ")}`,
      fix: "Verifica que no sean binarios/generados innecesarios antes de commit/push.",
    });
  }

  const genericModules = context.policy?.quality.warnGenericModules === false ? [] : files.filter((file) => /(^|\/)(utils|helpers|common|shared)\.(ts|js|tsx|jsx)$/.test(file));
  if (genericModules.length > 0) {
    violations.push({
      id: "MAL-HOOK-GENERIC-MODULE",
      decision: "warn",
      message: `Modulo generico modificado: ${genericModules.join(", ")}`,
      fix: "Prefiere nombres de dominio y responsabilidades claras; evita cajones de sastre.",
    });
  }

  return violations;
}

function readableTargetPaths(context: HookContext): string[] {
  return (context.targetPaths ?? [])
    .map((targetPath) => path.resolve(context.cwd, targetPath))
    .filter((targetPath) => fs.existsSync(targetPath) && fs.statSync(targetPath).isFile() && fs.statSync(targetPath).size <= 512 * 1024);
}

function scanFileForSecrets(filePath: string): string[] {
  const basename = path.basename(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const patterns: Array<[RegExp, string]> = [
    [/-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/, "private-key"],
    [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/, "aws-access-key"],
    [/(api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[:=]\s*["'][^"']{16,}["']/i, "credential-assignment"],
  ];

  const leaks = patterns.filter(([pattern]) => pattern.test(content)).map(([, name]) => `${basename}:${name}`);
  if (/^\.env(\.|$)/.test(basename)) leaks.push(`${basename}:env-file`);
  return leaks;
}

function extractCommitMessage(command: string): string | null {
  const match = /\s-m\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(command);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function hasConsent(context: HookContext, confirmation: string, metadataKey: string): boolean {
  return context.confirmation === confirmation || context.metadata?.[metadataKey] === true;
}

function strictness(profile: HookProfile, fallback: "warn" | "ask"): "warn" | "ask" | "deny" {
  if (profile === "strict" || profile === "release") return "ask";
  if (profile === "light") return "warn";
  return fallback;
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function isInside(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
