import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CODE_MODE_TOOL_NAMES, type HookContext, type HookEvent, type HookProfile, type HookRule, type HookViolation } from "./types";

export const builtInHookRules: HookRule[] = [
  { id: "policy-integrity", run: policyIntegrityGuard },
  { id: "repo-boundary", run: repoBoundaryGuard },
  { id: "destructive-memory", run: destructiveMemoryGuard },
  { id: "policy-safety", run: policySafetyGuard },
  { id: "dangerous-git", run: dangerousGitGuard },
  { id: "git-consent", run: gitConsentGuard },
  { id: "commit-message", run: commitMessageGuard },
  { id: "secret-scan", run: secretScanGuard },
  { id: "push-checks", run: pushChecksGuard },
  { id: "shell-policy", run: shellPolicyGuard },
  { id: "file-boundary", run: fileBoundaryGuard },
  { id: "tool-policy", run: toolPolicyGuard },
  { id: "plugin-permission", run: pluginPermissionGuard },
  { id: "egress-policy", run: egressPolicyGuard },
  { id: "programming-quality", critical: false, run: programmingQualityGuard },
];

function policyIntegrityGuard(context: HookContext): HookViolation[] {
  const meta = context.policyMeta;
  if (!meta) return [];

  if (meta.corporateStatus === "invalid" || meta.corporateStatus === "untrusted" || meta.corporateStatus === "required-missing" || meta.corporateStatus === "unsupported") {
    return [{
      id: "MAL-HOOK-POLICY-CORPORATE",
      decision: "deny",
      message: `Politica corporativa no evaluable (${meta.corporateStatus}); la operacion sensible no puede ejecutarse.`,
      fix: "Corrige la politica corporativa administrada o solicita intervencion del host; no uses un bypass local.",
    }];
  }

  const relevant = meta.criticalGaps.filter((gap) => controlAffectsEvent(gap, context.event));
  if (relevant.length > 0) {
    return [{
      id: "MAL-HOOK-POLICY-GAP",
      decision: "deny",
      message: `Controles exigidos sin mediacion real para ${context.event}: ${relevant.join(", ")}`,
      fix: "Implementa el adaptador de mediacion antes del efecto o retira el control de la politica efectiva.",
    }];
  }

  return [];
}

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
  const requirePreview = context.security?.destructive?.requirePreview
    ?? context.policy?.memory.destructiveRequiresPreview;
  if (requirePreview === false) return [];
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
  const blockDestructive = context.security?.git?.blockDestructive
    ?? context.policy?.git.blockDestructiveCommands;
  if (blockDestructive === false) return [];
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

  const shell = context.event === "shell.exec.before";
  if ((context.event === "git.commit.before" || shell) && /\bgit\s+commit\b/.test(command) && !hasConsent(context, "USER_REQUESTED_COMMIT", "userExplicitlyRequestedCommit")) {
    return [{
      id: "MAL-HOOK-GIT-CONSENT",
      decision: shell ? "ask" : "deny",
      message: "git commit requiere pedido explicito del usuario; 'continuar', 'cerrar fase' o 'implementar' no autorizan commitear.",
      fix: "No ejecutes el commit. Pide confirmacion explicita o valida con confirmacion USER_REQUESTED_COMMIT si el usuario pidio commitear.",
    }];
  }

  if ((context.event === "file.stage.before" || shell) && /\bgit\s+add\b/.test(command) && !hasConsent(context, "USER_REQUESTED_STAGE", "userExplicitlyRequestedStage")) {
    return [{
      id: "MAL-HOOK-GIT-STAGE-CONSENT",
      decision: shell ? "ask" : "deny",
      message: "git add/stage requiere pedido explicito del usuario; preparar cambios no equivale a staging.",
      fix: "No ejecutes git add. Pide confirmacion explicita o valida con confirmacion USER_REQUESTED_STAGE si el usuario pidio stagear.",
    }];
  }

  return [];
}

function commitMessageGuard(context: HookContext): HookViolation[] {
  if (context.policy?.git.validateCommitMessage === false) return [];
  if ((context.event !== "git.commit.before" && context.event !== "shell.exec.before") || !context.command) return [];

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
  const scan = context.security
    ? context.security.git?.scanStagedContent !== false || context.security.persistence?.blockSecrets !== false
    : context.policy?.secrets.scanBeforeCommit !== false;
  if (!scan) return [];
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

function pushChecksGuard(context: HookContext): HookViolation[] {
  const requireChecks = context.security?.git?.requireChecksBeforePush
    ?? context.policy?.git.requireChecksBeforePush;
  if (requireChecks === false || context.event !== "git.push.before") return [];

  return [{
    id: "MAL-HOOK-PUSH-CHECKS",
    decision: strictness(context.profile, "ask"),
    message: "Push sin evidencia de checks vinculada a la revision.",
    fix: "Corre tests/build y registra evidencia verificable; CHECKS_OK no autoriza por si solo.",
  }];
}

function shellPolicyGuard(context: HookContext): HookViolation[] {
  if (context.event !== "shell.exec.before") return [];

  const command = (context.command ?? "").trim();
  if (!command) {
    return [{
      id: "MAL-HOOK-SHELL-EMPTY",
      decision: "deny",
      message: "El hook de shell no recibio un comando evaluable.",
      fix: "Ejecuta el comando por una ruta que exponga argv/comando al control previo.",
    }];
  }

  const controls = context.security?.shell;
  const violations: HookViolation[] = [];

  if (controls) {
    const denied = controls.deniedCommands?.find((pattern) => commandMatches(pattern, command));
    if (denied) {
      violations.push({
        id: "MAL-HOOK-SHELL-DENY",
        decision: "deny",
        message: `Comando bloqueado por denylist: ${denied}`,
        fix: "Usa un comando permitido o solicita una excepcion administrada; no hay bypass local.",
      });
    }

    if (controls.enforceCommandAllowlist === true) {
      const allowed = controls.allowedCommands ?? [];
      if (allowed.length === 0 || !allowed.some((pattern) => commandMatches(pattern, command))) {
        violations.push({
          id: "MAL-HOOK-SHELL-ALLOWLIST",
          decision: "deny",
          message: "Comando fuera de la allowlist efectiva.",
          fix: "Agrega el comando a la politica administrada o usa una herramienta aprobada.",
        });
      }
    }

    if ((controls.inspectIndirectExecution === true || controls.blockUnapprovedScripts === true) && isIndirectExecution(command)) {
      violations.push({
        id: "MAL-HOOK-SHELL-INDIRECT",
        decision: "deny",
        message: "Ejecucion indirecta (intérprete, wrapper, script o pipe a shell) no aprobada.",
        fix: "Ejecuta el comando directo o registra el script con aprobacion vinculada antes del efecto.",
      });
    }

    if (controls.enforceTimeout === true) {
      const timeout = typeof context.metadata?.timeoutSeconds === "number" ? context.metadata.timeoutSeconds : 0;
      const max = controls.timeoutSeconds ?? 0;
      if (!Number.isFinite(timeout) || timeout <= 0 || (max > 0 && timeout > max)) {
        violations.push({
          id: "MAL-HOOK-SHELL-TIMEOUT",
          decision: "deny",
          message: `Timeout ausente o fuera del maximo (${max > 0 ? max : "sin maximo"}s).`,
          fix: "Ejecuta con timeout explicito dentro del limite de la politica.",
        });
      }
    }
  }

  if (/\bgit\s+push\b/.test(command) && context.metadata?.checksVerified !== true) {
    violations.push({
      id: "MAL-HOOK-PUSH-CLI-EVIDENCE",
      decision: "ask",
      message: "Push desde el plugin sin evidencia de checks vinculada a la revision.",
      fix: "Ejecuta prepush por CLI con evidencia verificable; la aprobacion de UI no sustituye checks.",
    });
  }

  if (/\bgit\s+commit\b/.test(command) && context.security?.git?.scanStagedContent !== false) {
    const staged = scanStagedSecrets(context.cwd, /\s(?:-a|--all)\b/.test(command));
    if (staged === null) {
      violations.push({
        id: "MAL-HOOK-GIT-STAGED",
        decision: "deny",
        message: "No se pudo verificar el contenido staged antes del commit.",
        fix: "Ejecuta el commit desde la CLI con evidencia o corrige el repositorio; no se presume ausencia de secretos.",
      });
    } else if (staged.length > 0) {
      violations.push({
        id: "MAL-HOOK-SECRETS",
        decision: "deny",
        message: `Posibles secretos en staged: ${staged.slice(0, 5).join(", ")}`,
        fix: "Remueve/rota el secreto antes de commitear; no uses `--no-verify`.",
      });
    }
  }

  return violations;
}

function fileBoundaryGuard(context: HookContext): HookViolation[] {
  if (context.event !== "file.read.before" && context.event !== "file.write.before") return [];

  const controls = context.security?.files;
  const paths = (context.targetPaths ?? []).map((target) => path.resolve(context.cwd, target));
  if (paths.length === 0) return [];

  const violations: HookViolation[] = [];
  const write = context.event === "file.write.before";
  const roots = (write ? controls?.allowedWriteRoots : controls?.allowedReadRoots) ?? [];
  const resolvedRoots = (roots.length > 0 ? roots : [context.projectRoot])
    .map((root) => path.resolve(context.cwd, root));
  const enforceRoots = controls?.enforceRoots === true;

  for (const target of paths) {
    const canonical = resolveTargetPath(target, controls?.resolveSymlinks !== false);
    if (!canonical) {
      violations.push({
        id: "MAL-HOOK-FILE-UNRESOLVED",
        decision: "deny",
        message: `No se pudo resolver la ruta: ${target}`,
        fix: "Usa una ruta existente y canonica; no operes sobre symlinks/junctions no verificables.",
      });
      continue;
    }

    const outsideRoots = !resolvedRoots.some((root) => isWithin(canonical, root));
    if (outsideRoots && (enforceRoots || controls?.requireApprovalOutsideRoots === true)) {
      violations.push({
        id: "MAL-HOOK-FILE-ROOT",
        decision: controls?.requireApprovalOutsideRoots === true ? "ask" : "deny",
        message: `Ruta fuera de las raices autorizadas: ${canonical}`,
        fix: "Limita la operacion al proyecto/raiz aprobada o genera aprobacion vinculada.",
      });
    }

    const denied = controls?.deniedPathGlobs?.find((pattern) => globMatches(pattern, canonical) || globMatches(pattern, path.basename(canonical)));
    if (denied) {
      violations.push({
        id: "MAL-HOOK-FILE-DENYLIST",
        decision: "deny",
        message: `Ruta bloqueada por denylist: ${denied}`,
        fix: "No accedas a esa ruta desde el agente; usa un canal autorizado.",
      });
    }

    if (!write && isSecretPath(canonical)
      && (controls?.excludeSecretsFromContext === true || controls?.excludeSecretsFromIndex === true)) {
      violations.push({
        id: "MAL-HOOK-FILE-SECRET",
        decision: "deny",
        message: "Lectura de archivo potencialmente secreto bloqueada.",
        fix: "No leas/indexes secretos; usa un gestor de secretos y minimiza la exposicion.",
      });
    }
  }

  return violations;
}

function toolPolicyGuard(context: HookContext): HookViolation[] {
  if (context.event !== "tool.execute.before") return [];

  const tool = typeof context.metadata?.tool === "string" ? context.metadata.tool.trim() : "";
  if (!tool) {
    return [{
      id: "MAL-HOOK-TOOL-EMPTY",
      decision: "deny",
      message: "El hook de tool no recibio identificador de herramienta.",
      fix: "Bloquea la llamada hasta que el host exponga la herramienta y sus argumentos.",
    }];
  }

  const violations: HookViolation[] = [];
  if (CODE_MODE_TOOL_NAMES.has(tool.toLowerCase())) {
    violations.push({
      id: "MAL-HOOK-CODE-MODE",
      decision: "deny",
      message: `Code Mode/REPL no mediable: ${tool}`,
      fix: "Usa tools directas que pasen por permission/tool/shell hooks; Code Mode queda bloqueado hasta T-5.5.5.",
    });
    return violations;
  }

  const controls = context.security?.integrations;
  if (!controls) return violations;

  const mcp = isMcpTool(tool);
  if (mcp && (controls.enforceMcpToolAllowlist === true || controls.blockUnapprovedIntegrations === true)) {
    const allowed = controls.allowedMcpTools ?? [];
    if (allowed.length === 0 || !allowed.some((pattern) => commandMatches(pattern, tool))) {
      violations.push({
        id: "MAL-HOOK-MCP-ALLOWLIST",
        decision: "deny",
        message: `Tool MCP fuera de allowlist: ${tool}`,
        fix: "Agrega la tool al servidor/politica aprobada; no la invoques desde el agente.",
      });
    }
  }

  if (!mcp && controls.blockUnapprovedIntegrations === true && !KNOWN_OPENCODE_TOOLS.has(tool)) {
    violations.push({
      id: "MAL-HOOK-TOOL-UNKNOWN",
      decision: "deny",
      message: `Tool no reconocida con integraciones bloqueadas: ${tool}`,
      fix: "Aprueba e integra la herramienta antes de usarla; no hay cobertura implicita.",
    });
  }

  return violations;
}

function pluginPermissionGuard(context: HookContext): HookViolation[] {
  if (context.event !== "plugin.permission.before") return [];
  if (context.metadata?.genericPermission === true || context.metadata?.knownTool === true) return [];

  const action = typeof context.metadata?.action === "string" ? context.metadata.action : "desconocida";
  return [{
    id: "MAL-HOOK-PLUGIN-UNMAPPED",
    decision: "ask",
    message: `Permiso V2 no mapeado a una operacion mediada: ${action}`,
    fix: "Mapea la accion a permission/tool/shell/sesion o deniega la capacidad; no asumas cobertura.",
  }];
}

function egressPolicyGuard(context: HookContext): HookViolation[] {
  if (!context.event.startsWith("session.")) return [];
  if (context.event === "session.http-response.after") return [];

  const violations: HookViolation[] = [];
  if (context.metadata?.secretDetected === true && context.security?.persistence?.blockSecrets !== false) {
    violations.push({
      id: "MAL-HOOK-EGRESS-SECRET",
      decision: "deny",
      message: "Posible secreto en el payload de sesion/egress.",
      fix: "Redacta o retira el secreto antes de enviar/compactar/guardar contexto.",
    });
  }

  const controls = context.security?.egress;
  if (!controls) return violations;

  const provider = typeof context.metadata?.providerID === "string" ? context.metadata.providerID : "";

  const providerRequired = context.event === "session.model-request.before" || context.event === "session.http-request.before";
  if (controls.enforceProviderAllowlist === true && (providerRequired || provider)) {
    const allowed = controls.allowedProviders ?? [];
    if (!provider || !allowed.some((pattern) => commandMatches(pattern, provider))) {
      violations.push({
        id: "MAL-HOOK-EGRESS-PROVIDER",
        decision: "deny",
        message: `Proveedor no autorizado o no evaluable: ${provider || "ausente"}`,
        fix: "Configura un proveedor permitido por la politica efectiva; no detectes modelos automaticamente.",
      });
    }
  }

  if (context.event === "session.http-request.before" || context.event === "session.model-request.before") {
    const url = typeof context.metadata?.url === "string" ? context.metadata.url : "";
    if (!url && context.event === "session.model-request.before") {
      // Sin baseURL explicito se evalua el proveedor; el endpoint lo cubre el host.
      return violations;
    }
    const parsed = parseHttpUrl(url);
    if (!parsed) {
      violations.push({
        id: "MAL-HOOK-EGRESS-URL",
        decision: "deny",
        message: "Solicitud HTTP sin URL valida/evaluable.",
        fix: "Usa una URL absoluta y un canal de red aprobado.",
      });
    } else {
      const protocols = controls.allowedProtocols ?? [];
      if (protocols.length > 0 && !protocols.includes(parsed.protocol.replace(/:$/, ""))) {
        violations.push({
          id: "MAL-HOOK-EGRESS-PROTOCOL",
          decision: "deny",
          message: `Protocolo no permitido: ${parsed.protocol}`,
          fix: "Usa un protocolo permitido por la politica de egress.",
        });
      }
      if (controls.requireTls === true && parsed.protocol !== "https:") {
        violations.push({
          id: "MAL-HOOK-EGRESS-TLS",
          decision: "deny",
          message: "El canal HTTP no usa TLS.",
          fix: "Usa HTTPS con verificacion de identidad.",
        });
      }
      const endpoints = controls.allowedEndpoints ?? [];
      const endpoint = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
      if (endpoints.length > 0 && !endpoints.some((pattern) => commandMatches(pattern, endpoint) || commandMatches(pattern, parsed.href))) {
        violations.push({
          id: "MAL-HOOK-EGRESS-ENDPOINT",
          decision: "deny",
          message: `Endpoint no permitido: ${endpoint}`,
          fix: "Limita el egress a endpoints aprobados por la politica.",
        });
      }
    }
  }

  return violations;
}

const KNOWN_OPENCODE_TOOLS = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "patch",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "todoread",
  "list",
  "question",
  "skill",
  "invalid",
]);

function commandMatches(pattern: string, value: string): boolean {
  const normalized = pattern.trim();
  if (!normalized) return false;
  if (normalized === "*") return true;
  if (normalized.endsWith("*") && !normalized.slice(0, -1).includes("*")) {
    return value.startsWith(normalized.slice(0, -1));
  }
  const regex = globToRegExp(normalized);
  return regex.test(value);
}

function globMatches(pattern: string, value: string): boolean {
  return commandMatches(pattern, value) || commandMatches(pattern, value.replaceAll("\\", "/"));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/\\\\]*")
    .replaceAll("?", "[^/\\\\]")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`);
}

function isIndirectExecution(command: string): boolean {
  if (/(^|[\s;&|])(eval|exec|source)\s/.test(command)) return true;
  if (/\b(?:ba|z|k|da)?sh\s+-c\b/.test(command)) return true;
  if (/\b(?:node|bun|deno|python[0-9.]*|ruby|perl|php)\s+(?:-e|-c|--eval)\b/.test(command)) return true;
  if (/\|\s*(?:ba|z|k|da)?sh\b/.test(command)) return true;
  if (/(^|[\s;&|])(?:\/|\.{1,2}\/|~\/)[^\s]+\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php)\b/.test(command)) return true;
  if (/`|\$\(/.test(command)) return true;
  return false;
}

function resolveTargetPath(target: string, followSymlinks: boolean): string | null {
  try {
    if (fs.existsSync(target)) {
      return followSymlinks ? fs.realpathSync(target) : path.resolve(target);
    }
    let parent = path.dirname(target);
    while (!fs.existsSync(parent)) {
      const next = path.dirname(parent);
      if (next === parent) return null;
      parent = next;
    }
    const canonicalParent = followSymlinks ? fs.realpathSync(parent) : path.resolve(parent);
    return path.join(canonicalParent, path.relative(parent, target));
  } catch {
    return null;
  }
}

function isSecretPath(target: string): boolean {
  const normalized = target.replaceAll("\\", "/");
  const base = path.basename(normalized);
  if (base === ".env.example") return false;
  return /(^|\/)\.env(\.|$)/.test(normalized)
    || /(^|\/)\.ssh\//.test(normalized)
    || /(^|\/)(id_rsa|id_ed25519|credentials|secrets?)(\.|$)/i.test(normalized)
    || /\.(pem|p12|pfx|key)$/i.test(base);
}

function isMcpTool(tool: string): boolean {
  return /^mcp[_.:-]/i.test(tool) || /^mcp$/i.test(tool);
}

function parseHttpUrl(value: string): URL | null {
  if (!value.trim()) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function programmingQualityGuard(context: HookContext): HookViolation[] {
  const violations: HookViolation[] = [];
  const files = context.targetPaths ?? [];

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

function scanStagedSecrets(cwd: string, includeWorktree = false): string[] | null {
  const commands = [
    ["diff", "--cached", "--name-only", "-z"],
    ...(includeWorktree ? [["diff", "--name-only", "-z"]] : []),
  ];
  const leaks: string[] = [];

  for (const args of commands) {
    let output: string;
    try {
      output = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }

    for (const relative of output.split("\0").filter(Boolean)) {
      const file = path.resolve(cwd, relative);
      if (!fs.existsSync(file)) continue;
      try {
        leaks.push(...scanFileForSecrets(file));
      } catch {
        return null;
      }
    }
  }
  return leaks;
}

const PRIVATE_KEY_PATTERN = new RegExp(["-----BEGIN", "(RSA |OPENSSH |EC |DSA )?PRIVATE", "KEY-----"].join(" "));

function scanFileForSecrets(filePath: string): string[] {
  const basename = path.basename(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const patterns: Array<[RegExp, string]> = [
    [PRIVATE_KEY_PATTERN, "private-key"],
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

function controlAffectsEvent(gap: string, event: HookEvent): boolean {
  const control = gap.replace(/^(built-in|corporate|project|local):/, "");

  if (control.startsWith("host.") || control.startsWith("approval.") || control.startsWith("audit.")) return true;
  if (control.startsWith("git.")) return event.startsWith("git.") || event === "file.stage.before" || event === "shell.exec.before";
  if (control.startsWith("destructive.")) {
    return event.includes(".apply") || event === "git.reset.before" || event === "git.checkout.before" || event === "git.rebase.before";
  }
  if (control.startsWith("persistence.") || control.startsWith("memory.")) {
    return event.startsWith("memory.") || event.startsWith("context.");
  }
  if (control.startsWith("files.")) {
    return event.startsWith("context.")
      || event.startsWith("memory.")
      || event.startsWith("file.")
      || event === "shell.exec.before"
      || event === "tool.execute.before"
      || event === "obsidian.write.before"
      || event === "graphify.generate.before"
      || event === "database.change.before";
  }
  if (control.startsWith("shell.")) return event === "shell.exec.before";
  if (control.startsWith("integrations.")) return event === "tool.execute.before";
  if (control.startsWith("egress.")) {
    return event.startsWith("session.")
      || (control === "egress.coverMcpShellFetch" && (event === "shell.exec.before" || event === "tool.execute.before"));
  }
  return true;
}

function isWithin(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isInside(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
