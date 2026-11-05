import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadProjectsFile } from "../context";
import { filesystemTargetPaths, hookResourceIssues } from "./resources";
import {
  CODE_MODE_TOOL_NAMES,
  MALAHOR_CODE_MODE_TOOL_NAMES,
  isMcpToolName,
  type HookContext,
  type HookEvent,
  type HookProfile,
  type HookRemediation,
  type HookRule,
  type HookViolation,
} from "./types";
import {
  classifyInfrastructureCommand,
  classifyInfrastructurePath,
  type InfrastructureClassification,
} from "../infrastructure-boundary";
import {
  classifyDocumentationPath,
  isRemovalOperation,
  type DocumentationOperation,
} from "../documentation-boundary";
import { classifyGitCommand, loadGitAliases, type GitOperation } from "../git-command-policy";
import { intentAuthorizes, type GitIntent } from "../git-intent";
import { isValidCommitSubject } from "../git-commit-message";
import {
  detectFileSecretCounts,
  detectFileSecretFindings,
  isPotentialSecretPath,
  parseSecretPatchSummary,
  revalidateSecretPatchSummary,
  secretKinds,
  type SecretFileFinding,
  type SecretPatchSummary,
} from "./secret-scan";

export const builtInHookRules: HookRule[] = [
  { id: "policy-integrity", run: policyIntegrityGuard },
  { id: "resource-contract", run: resourceContractGuard },
  { id: "repo-boundary", run: repoBoundaryGuard },
  { id: "infrastructure-boundary", run: infrastructureBoundaryGuard },
  { id: "documentation-boundary", run: documentationBoundaryGuard },
  { id: "destructive-memory", run: destructiveMemoryGuard },
  { id: "policy-safety", run: policySafetyGuard },
  { id: "git-remote", run: remoteGitGuard },
  { id: "git-intent-scope", run: gitIntentScopeGuard },
  { id: "dangerous-git", run: dangerousGitGuard },
  { id: "git-consent", run: gitConsentGuard },
  { id: "commit-message", run: commitMessageGuard },
  { id: "secret-scan", run: secretScanGuard },
  { id: "shell-policy", run: shellPolicyGuard },
  { id: "file-boundary", run: fileBoundaryGuard },
  { id: "tool-policy", run: toolPolicyGuard },
  { id: "plugin-permission", run: pluginPermissionGuard },
  { id: "egress-policy", run: egressPolicyGuard },
  { id: "programming-quality", critical: false, run: programmingQualityGuard },
];

function resourceContractGuard(context: HookContext): HookViolation[] {
  return hookResourceIssues(context).map((issue) => ({
    id: "MAL-HOOK-RESOURCE-KIND",
    decision: "deny",
    message: issue.message,
    fix: "Usa filesystem para rutas fisicas. Los agentes operan documentacion exclusivamente mediante docs_*.",
  }));
}

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
  const targets = filesystemTargetPaths(context);
  if (!writesMalahorData || targets.length === 0) return [];

  const unsafe = targets
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

interface InfrastructureTargetResolution {
  paths: string[];
  unresolved: boolean;
}

function infrastructureBoundaryGuard(context: HookContext): HookViolation[] {
  const relevant = context.event === "plugin.permission.before"
    ? context.metadata?.deferredToToolHook === true
    : context.event === "file.write.before"
      || context.event === "file.stage.before"
      || context.event === "git.commit.before"
      || context.event === "git.push.before"
      || context.event === "shell.exec.before"
      || context.event === "tool.execute.before";
  if (!relevant) return [];

  if (context.event === "git.commit.before"
    && context.metadata?.validationOnly === true
    && filesystemTargetPaths(context).length === 0) {
    return [];
  }

  const command = (context.command ?? "").trim();
  const commandMatch = context.event === "shell.exec.before" || context.event === "tool.execute.before"
    ? classifyInfrastructureCommand(command)
    : { protected: false } satisfies InfrastructureClassification;
  const resolution = infrastructureTargetPaths(context, command);
  const pathMatches = resolution.paths
    .map((targetPath) => classifyInfrastructurePath(context.projectRoot, path.resolve(context.cwd, targetPath)))
    .filter((classification) => classification.protected);

  if (!commandMatch.protected && pathMatches.length === 0 && !resolution.unresolved) return [];

  const evidence = [...new Set([
    ...(commandMatch.evidence ? [commandMatch.evidence] : []),
    ...pathMatches.map((classification) => classification.relativePath ?? classification.evidence ?? "recurso protegido"),
    ...(resolution.unresolved ? ["recursos no delimitables de forma segura"] : []),
  ])];
  return [{
    id: "MAL-HOOK-INFRA-APPROVAL",
    decision: "ask",
    message: `CI/CD, IaC, publicacion y despliegue son solo lectura sin aprobacion separada: ${evidence.join(", ")}`,
    fix: "Solicita un ASK humano específico y vinculado a esta operacion y recursos. Plan, implementacion, stage, commit, push, confirmaciones Git o Allow always no lo sustituyen.",
  }];
}

function infrastructureTargetPaths(context: HookContext, command: string): InfrastructureTargetResolution {
  const explicit = filesystemTargetPaths(context);
  if (explicit.length > 0) return { paths: explicit, unresolved: false };

  if (context.event === "plugin.permission.before" && context.metadata?.deferredToToolHook === true) {
    return { paths: [], unresolved: true };
  }
  if (context.event === "file.write.before") return { paths: [], unresolved: true };
  if (context.event === "file.stage.before") return gitResolution(changedPaths(context.projectRoot));
  if (context.event === "git.commit.before") return gitResolution(stagedPaths(context.projectRoot));
  if (context.event === "git.push.before" || context.event === "git.remote.before") return { paths: [], unresolved: false };
  if (context.event === "tool.execute.before") return { paths: [], unresolved: false };
  if (context.event !== "shell.exec.before" || !command) return { paths: [], unresolved: false };

  if (isGitCommandOperation(command, "add")) return gitAddResolution(context, command);
  if (isGitCommandOperation(command, "commit")) return gitResolution(stagedPaths(context.projectRoot));
  if (isGitCommandOperation(command, "push")) return { paths: [], unresolved: false };
  if (isPotentialFilesystemMutation(command)) {
    return { paths: shellPathCandidates(command), unresolved: false };
  }
  return { paths: [], unresolved: false };
}

function gitAddResolution(context: HookContext, command: string): InfrastructureTargetResolution {
  const segment = command.split(/(?:&&|\|\||[;|\n])/).find((item) => isGitCommandOperation(item, "add"));
  if (!segment || /\bgit\s+-c\b|\bgit\s+-C\b|--pathspec-from-file|(?:^|\s)-(?:p|i)(?:\s|$)/.test(segment)) {
    return { paths: [], unresolved: true };
  }

  const tokens = shellTokens(segment);
  const git = tokens.findIndex((token) => token === "git");
  const add = tokens.findIndex((token, index) => index > git && token === "add");
  if (git < 0 || add < 0) return { paths: [], unresolved: true };

  const args = tokens.slice(add + 1);
  if (args.some((token) => ["-a", "-A", "--all", "-u", "--update", ".", ":/"].includes(token))) {
    return gitResolution(changedPaths(context.projectRoot));
  }
  const targets = args.filter((token) => token !== "--" && !token.startsWith("-"));
  if (targets.some((target) => /[*?\[\]$`]/.test(target))) return { paths: [], unresolved: true };
  return { paths: targets, unresolved: targets.length === 0 };
}

function isGitCommandOperation(command: string, operation: "add" | "commit" | "push"): boolean {
  const classification = classifyGitCommand(command);
  if (operation === "add") return classification.operations.includes("stage");
  if (operation === "commit") {
    return classification.operations.includes("commit") || classification.operations.includes("amend");
  }
  return classification.remoteReasons.some((reason) => reason === "git-push");
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped || quote) return [];
  if (current) tokens.push(current);
  return tokens;
}

function isPotentialFilesystemMutation(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|mv|cp|install|touch|mkdir|truncate|chmod|chown|ln|tee)\b/.test(command)
    || /(?:^|[;&|]\s*)(?:sudo\s+)?(?:sed\s+-[^\s]*i|perl\s+-[^\s]*i)\b/.test(command)
    || /(^|[^<])>{1,2}(?!=)/.test(command);
}

function shellPathCandidates(command: string): string[] {
  const expanded = command.replace(/(>>?|<)/g, " $1 ");
  return shellTokens(expanded)
    .filter((token) => ![">", ">>", "<"].includes(token) && !token.startsWith("-"))
    .map((token) => token.includes("=") ? token.slice(token.indexOf("=") + 1) : token)
    .map((token) => token.replace(/^[([{]+|[\])},]+$/g, ""))
    .filter((token) => token.length > 0 && !token.includes("://"));
}

function gitResolution(paths: string[] | null): InfrastructureTargetResolution {
  return paths === null ? { paths: [], unresolved: true } : { paths, unresolved: false };
}

function documentationBoundaryGuard(context: HookContext): HookViolation[] {
  const commit = context.event === "git.commit.before"
    || (context.event === "shell.exec.before" && gitClassification(context).operations.some((operation) => operation === "commit" || operation === "amend"));
  const relevant = context.event === "file.write.before"
    || context.event === "file.stage.before"
    || commit;
  if (!relevant) return [];

  if (context.event === "file.write.before") {
    const directTargets = filesystemTargetPaths(context).map((targetPath) => path.resolve(context.cwd, targetPath));
    let docsRoots: string[];
    try {
      docsRoots = managedDocsRoots(context.malahorHome);
    } catch (error) {
      return [{
        id: "MAL-HOOK-DOCS-VERIFY",
        decision: "deny",
        message: `No se pudo resolver la frontera del vault documental: ${(error as Error).message}`,
        fix: "Repara projects.json con malahor-ai doctor antes de escribir archivos.",
      }];
    }
    const directVaultWrites = directTargets.filter((target) => docsRoots.some((root) => (
      isInside(target, root) || isInside(canonicalPlannedPath(target), canonicalPlannedPath(root))
    )));
    if (directVaultWrites.length > 0) {
      return [{
        id: "MAL-HOOK-DOCS-MCP-ONLY",
        decision: "deny",
        message: `Los agentes solo escriben el vault mediante docs_*: ${directVaultWrites.join(", ")}`,
        fix: "Usa docs_write, docs_append o docs_move; no uses write/edit/patch sobre rutas fisicas del vault.",
      }];
    }
  }

  let operations: DocumentationOperation[] = [];
  if (context.event === "file.write.before") {
    operations = metadataOperations(context.metadata?.fileOperations)
      ?? filesystemTargetPaths(context).map((targetPath) => ({ kind: "write", path: targetPath }));
  } else {
    const targets = filesystemTargetPaths(context);
    if (context.metadata?.validationOnly === true && targets.length === 0) {
      // Validar texto/forma de un commit no representa un commit real y no debe
      // depender del indice Git del proceso que ejecuta los tests o el preview.
      return [];
    }
    const persisted = targets.length > 0 ? targets : stagedPaths(context.projectRoot);
    if (persisted === null) {
      return [{
        id: "MAL-HOOK-DOCS-VERIFY",
        decision: "deny",
        message: "No se pudo verificar el contenido staged contra la frontera documental.",
        fix: "Corrige el repositorio y vuelve a ejecutar el flujo Git verificado.",
      }];
    }
    operations = persisted.map((targetPath) => {
      const removal = context.event === "file.stage.before"
        ? isExactUnstagedRemoval(context, targetPath)
        : commit && isExactStagedRemoval(context, targetPath);
      return { kind: removal ? "delete" : "write", path: targetPath };
    });
  }

  const unsafe = operations.filter((operation) => {
    if (isRemovalOperation(operation.kind)) return false;
    return classifyDocumentationPath(context.projectRoot, path.resolve(context.cwd, operation.path)).protected;
  });
  if (unsafe.length === 0) return [];
  return [{
    id: "MAL-HOOK-DOCS-EXTERNAL",
    decision: "deny",
    message: `La documentacion operativa debe vivir en el vault externo: ${unsafe.map((item) => item.path).join(", ")}`,
    fix: "Usa las tools docs_* del MCP first-party. Solo se permite borrar o mover fuera documentos historicos del repo.",
  }];
}

function managedDocsRoots(malahorHome: string): string[] {
  const projects = loadProjectsFile(path.join(malahorHome, "projects.json"));
  return [...new Set([
    path.join(malahorHome, "vault"),
    ...Object.values(projects).flatMap((entry) => entry.docs?.path ? [entry.docs.path] : []),
  ].map((value) => path.resolve(value)))];
}

function canonicalPlannedPath(value: string): string {
  const resolved = path.resolve(value);
  let current = resolved;
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  let canonical = current;
  try { canonical = fs.realpathSync(current); } catch { /* usa la ruta lexica */ }
  return path.resolve(canonical, ...suffix);
}

function metadataOperations(value: unknown): DocumentationOperation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.filter((item): item is DocumentationOperation => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record.path === "string" && typeof record.kind === "string"
      && ["add", "update", "delete", "move-in", "move-out", "write"].includes(record.kind);
  });
  return valid.length === value.length ? valid : undefined;
}

function stagedPaths(cwd: string): string[] | null {
  return gitPathQuery(cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "-z"]);
}

function changedPaths(cwd: string): string[] | null {
  const queries = [
    gitPathQuery(cwd, ["diff", "--name-only", "--diff-filter=ACMRD", "-z"]),
    gitPathQuery(cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "-z"]),
    gitPathQuery(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ];
  const available = queries.filter((items): items is string[] => items !== null);
  if (available.length === 0) return null;
  return [...new Set(available.flat())];
}

function gitPathQuery(cwd: string, args: string[]): string[] | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\0").map((item) => item.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function isExactUnstagedRemoval(context: HookContext, targetPath: string): boolean {
  return isExactGitRemoval(context, targetPath, false);
}

function isExactStagedRemoval(context: HookContext, targetPath: string): boolean {
  return isExactGitRemoval(context, targetPath, true);
}

function isExactGitRemoval(context: HookContext, targetPath: string, cached: boolean): boolean {
  const projectRoot = path.resolve(context.projectRoot);
  const absoluteTarget = path.resolve(context.cwd, targetPath);
  if (absoluteTarget === projectRoot || !isInside(absoluteTarget, projectRoot)) return false;

  const relativeTarget = path.relative(projectRoot, absoluteTarget);
  try {
    const output = execFileSync("git", [
      "diff",
      ...(cached ? ["--cached"] : []),
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      "--diff-filter=D",
      "--",
      relativeTarget,
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const removals = output.split("\0").filter(Boolean);
    return removals.length === 1 && path.resolve(projectRoot, removals[0]!) === absoluteTarget;
  } catch {
    return false;
  }
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
      fix: "Ejecuta assets/memoria/comandos/validateInstallation y aplica politica al final.",
    });
  }
  if (context.policy?.policy.blockTotalBashDeny !== false && context.metadata?.bashDenyTotal === true) {
    violations.push({
      id: "MAL-HOOK-POLICY-BASH-DENY",
      decision: "deny",
      message: "guiar/acompanar no pueden escribir bash:'deny' total.",
      fix: "Usa whitelist v2 con doctor/context allow e install/update ask.",
    });
  }

  return violations;
}

function remoteGitGuard(context: HookContext): HookViolation[] {
  const classification = gitClassification(context);
  const remoteEvent = context.event === "git.push.before" || context.event === "git.remote.before";
  if (!remoteEvent && !classification.remote) return [];

  const detail = classification.remoteReasons.length > 0
    ? classification.remoteReasons.join(", ")
    : context.event;
  return [{
    id: "MAL-HOOK-GIT-REMOTE-DENY",
    decision: "deny",
    blockClass: "hard-deny",
    message: `Operacion Git remota prohibida permanentemente (${detail}). Malahor solo opera Git local.`,
    fix: "No hay aprobacion, perfil, plan, token ni fallback que habilite red. Ejecuta fuera de Malahor bajo tu propia responsabilidad.",
  }];
}

function dangerousGitGuard(context: HookContext): HookViolation[] {
  const classification = gitClassification(context);
  if (!classification.hasGitCommand || classification.remote) return [];

  const unsupported = classification.operations.filter((operation) => (
    operation === "clean"
    || operation === "discard"
    || operation === "branch-delete"
    || operation === "implicit-stage"
    || operation === "unknown"
  ));
  if (classification.failClosed || unsupported.length > 0) {
    const detail = unsupported.length > 0 ? unsupported.join(", ") : "ejecucion indirecta no evaluable";
    return [{
      id: "MAL-HOOK-GIT-DESTRUCTIVE-DENY",
      decision: "deny",
      blockClass: "hard-deny",
      message: `Operacion local destructiva fuera del alcance permitido: ${detail}.`,
      fix: "No descartes, borres ni stages implicitamente con commit. Usa paths exactos y el flujo local especifico para cada efecto.",
    }];
  }
  if (!classification.destructive) return [];

  const target = classification.targets.length > 0 ? classification.targets.join(", ") : inferredGitTarget(classification.operations);
  return [{
    id: "MAL-HOOK-GIT-DESTRUCTIVE",
    decision: "ask",
    blockClass: "approval-required",
    message: `Operacion Git local destructiva: ${classification.operations.join(", ")}; target: ${target}.`,
    fix: "Muestra este preview y solicita una aprobacion humana de un solo uso vinculada al comando, proyecto, target y policy hash.",
  }];
}

function gitIntentScopeGuard(context: HookContext): HookViolation[] {
  if (context.metadata?.validationOnly === true) return [];
  const classification = gitClassification(context);
  if (!classification.hasGitCommand || classification.remote || context.gitIntentVerified === true) return [];
  const intent = contextGitIntent(context);
  if (!intent) return [];

  if (classification.operations.includes("stage") && intentAuthorizes(intent, "stage")) {
    const declared = normalizedGitPaths(context, filesystemTargetPaths(context));
    const commandPaths = normalizedGitPaths(context, classification.targets);
    const unsafe = declared.length === 0
      || commandPaths.length === 0
      || !sameStringSet(declared, commandPaths)
      || classification.targets.some(unsafeGitPathspec)
      || commandPaths.some((target) => unsafeStageTarget(context, target))
      || /(?:^|\s)(?:-[^-]*[Aipux][^-]*|--all|--interactive|--patch|--pathspec-from-file(?:=|\s)|--renormalize|--update)(?:\s|$)/.test(context.command ?? "");
    if (unsafe) {
      return [{
        id: "MAL-HOOK-GIT-INTENT-SCOPE",
        decision: "deny",
        message: "La intencion de stage/commit no esta vinculada a una lista exacta de archivos revisados.",
        fix: "Usa `git add -- <archivos exactos>` y declara esos mismos paths; no uses -A, directorios, globs, modo interactivo ni pathspecs indirectos.",
      }];
    }
  }

  if ((classification.operations.includes("commit") || classification.operations.includes("amend"))
    && (intentAuthorizes(intent, "commit") || intentAuthorizes(intent, "amend"))
    && filesystemTargetPaths(context).length === 0) {
    return [{
      id: "MAL-HOOK-GIT-INTENT-SCOPE",
      decision: "deny",
      message: "La intencion de commit no declara el staged exacto revisado.",
      fix: "Declara los paths staged verificados o usa la evidencia one-shot emitida por malahor_hook_check.",
    }];
  }

  return [];
}

function gitConsentGuard(context: HookContext): HookViolation[] {
  const command = (context.command ?? "").trim();
  if (!command || context.metadata?.validationOnly === true) return [];

  const classification = gitClassification(context);
  if (!classification.hasGitCommand || classification.remote) return [];
  const protectedOperations = classification.operations.filter(requiresGitIntent);
  if (protectedOperations.length === 0) return [];

  const intent = contextGitIntent(context);
  if (intent && protectedOperations.every((operation) => intentAuthorizes(intent, operation))) return [];

  return [{
    id: protectedOperations.includes("stage") ? "MAL-HOOK-GIT-STAGE-CONSENT" : "MAL-HOOK-GIT-CONSENT",
    decision: "ask",
    message: `Git local requiere intencion explicita para: ${protectedOperations.join(", ")}. Un pedido de commit solo autoriza stage exacto y commit ordinario.`,
    fix: "Propaga `gitIntent` desde el pedido explicito. No uses tokens humanos ni reutilices intenciones para otra operacion.",
  }];
}

function commitMessageGuard(context: HookContext): HookViolation[] {
  if (context.policy?.git.validateCommitMessage === false) return [];
  if ((context.event !== "git.commit.before" && context.event !== "shell.exec.before") || !context.command) return [];

  const message = extractCommitMessage(context.command);
  if (!message) return [];

  if (isValidCommitSubject(message)) return [];

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
  const writeTool = String(context.metadata?.tool);
  if (context.event === "file.write.before"
    && (writeTool === "patch"
      || (["edit", "write"].includes(writeTool) && context.metadata?.secretPatchSummary !== undefined))) {
    return patchSecretScanGuard(context);
  }
  if (!scan) return [];
  const paths = readableTargetPaths(context);
  const findings = paths.flatMap((targetPath) => scanTargetForSecretFindings(targetPath, context));

  if (findings.length === 0) return [];
  const leaks = findings.map((finding) => `${finding.path}:${finding.line}:${finding.kind}`);
  const remediations = findings.slice(0, 5).map((finding) => finding.remediation ?? removalRemediation(finding));

  return [{
    id: "MAL-HOOK-SECRETS",
    decision: "deny",
    blockClass: "remediable-deny",
    message: `Posibles secretos detectados: ${leaks.slice(0, 5).join(", ")}`,
    fix: "Remueve secretos, usa variables de entorno/secret manager y rota credenciales si fueron expuestas.",
    remediations,
  }];
}

function patchSecretScanGuard(context: HookContext): HookViolation[] {
  const evidence = context.metadata?.secretPatchSummary;
  const summary = parseSecretPatchSummary(evidence);
  const isPatch = String(context.metadata?.tool) === "patch";
  if (!summary?.evaluable || (isPatch && (!patchSummaryMatchesTargets(context, summary)
    || !revalidateSecretPatchSummary(evidence, context.cwd, {
      projectRoot: context.projectRoot,
      ...(context.project ? { project: context.project } : {}),
      ...(context.policyMeta?.policyHash ? { policyHash: context.policyMeta.policyHash } : {}),
    })))) {
    const unavailable = summary?.evaluable === true || context.metadata?.secretPatchControlUnavailable === true;
    const failure = summary?.failure ?? {
      code: unavailable ? "SECURITY_CONTROL_UNAVAILABLE" : "PATCH_NOT_EVALUABLE",
      reason: unavailable ? "file-unavailable" : "missing-evidence",
    } as const;
    const reason = {
      "invalid-structure": "estructura del cambio no reconocida",
      "unsupported-operation": "operación no verificable",
      "invalid-path": "ruta no verificable",
      "duplicate-target": "destino repetido",
      "file-unavailable": "archivo o control de lectura no disponible",
      "context-mismatch": "contexto o indentación que no coincide con el archivo vigente",
      "ambiguous-context": "contexto repetido sin posición única",
      "missing-evidence": "evidencia interna ausente",
    }[failure.reason];
    const hunk = "hunk" in failure ? failure.hunk : undefined;
    return [{
      id: "MAL-HOOK-PATCH-UNEVALUABLE",
      decision: "deny",
      blockClass: "control-unavailable",
      message: `No se pudo evaluar el patch: ${reason}${hunk ? ` (bloque ${hunk})` : ""}.`,
      fix: "Relee el archivo, comprueba contexto e indentación y solicita revalidación; el cambio sigue bloqueado. Si falla la lectura, repara el control antes de continuar.",
      diagnostic: failure,
    }];
  }

  const leaks = summary.files.flatMap((file) => secretKinds(file.after)
    .map((kind) => kind));
  if (leaks.length === 0) return [];
  return [{
    id: "MAL-HOOK-SECRETS",
    decision: "deny",
    blockClass: "remediable-deny",
    message: `El patch conservaria o introduciria posibles secretos: ${leaks.slice(0, 5).join(", ")}`,
    fix: "Retira todos los hallazgos del archivo y no agregues credenciales, tokens o llaves.",
    diagnostic: { code: "SECRET_PRESENT", reason: "secret-in-result" },
  }];
}

function patchSummaryMatchesTargets(context: HookContext, summary: SecretPatchSummary): boolean {
  const targets = new Set(filesystemTargetPaths(context).map((target) => path.resolve(context.cwd, target)));
  const summarized = new Set(summary.files.map((file) => path.resolve(context.cwd, file.path)));
  const operations = context.metadata?.fileOperations;
  if (!Array.isArray(operations) || operations.length !== summary.files.length) return false;
  const summarizedOperations = new Map(summary.files.map((file) => [path.resolve(context.cwd, file.path), file.operation]));
  const seenOperations = new Set<string>();
  if (operations.some((item: unknown) => {
    const operation = item as { kind?: unknown; path?: unknown };
    if (!operation || typeof operation.path !== "string" || typeof operation.kind !== "string") return true;
    const resolved = path.resolve(context.cwd, operation.path);
    if (seenOperations.has(resolved)) return true;
    seenOperations.add(resolved);
    return summarizedOperations.get(resolved) !== operation.kind;
  })) return false;
  return targets.size === summarized.size
    && targets.size === summary.files.length
    && [...targets].every((target) => summarized.has(target));
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

  const git = gitClassification(context);
  if ((git.operations.includes("commit") || git.operations.includes("amend")) && context.security?.git?.scanStagedContent !== false) {
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
  const paths = filesystemTargetPaths(context).map((target) => path.resolve(context.cwd, target));
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

    if (!write && isPotentialSecretPath(canonical)
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
      fix: "Usa tools directas que pasen por permission/tool/shell hooks; Code Mode permanece bloqueado sin mediacion verificable.",
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
    decision: "warn",
    message: `Permiso V2 no mapeado; se conserva la decision nativa del host: ${action}`,
    fix: "Mapea la accion si necesita un control critico de Malahor; las operaciones normales siguen los defaults de OpenCode.",
  }];
}

function egressPolicyGuard(context: HookContext): HookViolation[] {
  if (!context.event.startsWith("session.")) return [];
  if (context.event === "session.http-response.after") return [];

  const violations: HookViolation[] = [];
  if (context.metadata?.secretDetected === true && context.security?.persistence?.blockSecrets !== false) {
    const secretKinds = Array.isArray(context.metadata.secretKinds)
      ? context.metadata.secretKinds.filter((kind): kind is string => typeof kind === "string")
      : [];
    const classification = secretKinds.length > 0 ? ` (${secretKinds.join(", ")})` : "";
    violations.push({
      id: "MAL-HOOK-EGRESS-SECRET",
      decision: "deny",
      message: `Posible secreto${classification} en el payload de sesion/egress.`,
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
  "shell",
  "subagent",
  "malahor_plan",
  "malahor_run",
  "malahor_plan_control",
  "malahor_commit_prepare",
  "commit_prepare",
  "malahor_task_classify",
  "task_classify",
  "malahor_direct_prepare",
  "direct_prepare",
  ...MALAHOR_CODE_MODE_TOOL_NAMES,
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

function isMcpTool(tool: string): boolean {
  return isMcpToolName(tool);
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
  const files = filesystemTargetPaths(context);

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
  return filesystemTargetPaths(context)
    .map((targetPath) => path.resolve(context.cwd, targetPath))
    .filter((targetPath) => fs.existsSync(targetPath) && fs.statSync(targetPath).isFile() && fs.statSync(targetPath).size <= 512 * 1024);
}

function scanTargetForSecretFindings(filePath: string, context: HookContext): SecretFileFinding[] {
  const content = fs.readFileSync(filePath, "utf8");
  return detectFileSecretFindings(content, filePath, safeRelativePath(filePath, context.projectRoot));
}

function removalRemediation(finding: SecretFileFinding): HookRemediation {
  return {
    version: 1,
    kind: "remove-secret",
    path: finding.path,
    startLine: finding.line,
    endLine: finding.line,
    finding: finding.kind,
    revalidate: true,
  };
}

function safeRelativePath(filePath: string, projectRoot: string): string {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(filePath));
  const candidate = relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : path.basename(filePath);
  return candidate.replace(/[\r\n\t\u001b]/g, "?").slice(0, 512);
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

function scanFileForSecrets(filePath: string): string[] {
  const basename = path.basename(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  return secretKinds(detectFileSecretCounts(content, filePath)).map((kind) => `${basename}:${kind}`);
}

function extractCommitMessage(command: string): string | null {
  const match = /\s-m\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(command);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

const GIT_CLASSIFICATIONS = new WeakMap<HookContext, ReturnType<typeof classifyGitCommand>>();

function gitClassification(context: HookContext): ReturnType<typeof classifyGitCommand> {
  const cached = GIT_CLASSIFICATIONS.get(context);
  if (cached) return cached;
  const classification = classifyGitCommand(context.command ?? "", {
    aliases: loadGitAliases(context.projectRoot),
  });
  GIT_CLASSIFICATIONS.set(context, classification);
  return classification;
}

function requiresGitIntent(operation: GitOperation): boolean {
  return [
    "stage", "commit", "amend", "reset", "rebase", "cherry-pick", "merge",
    "branch-create", "branch-switch",
  ].includes(operation);
}

function contextGitIntent(context: HookContext): GitIntent | undefined {
  return context.gitIntent;
}

function inferredGitTarget(operations: GitOperation[]): string {
  if (operations.includes("amend")) return "HEAD";
  if (operations.includes("reset")) return "HEAD (por defecto)";
  if (operations.includes("rebase")) return "rebase en curso o upstream indicado";
  return "estado local actual";
}

function normalizedGitPaths(context: HookContext, values: string[]): string[] {
  return [...new Set(values.map((value) => {
    const absolute = path.resolve(context.cwd, value);
    const relative = path.relative(context.projectRoot, absolute);
    return (relative || ".").replaceAll("\\", "/");
  }))].sort();
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unsafeStageTarget(context: HookContext, target: string): boolean {
  if (target === "." || target === ":/" || /[*?\[\]$`]/.test(target)) return true;
  try {
    return fs.statSync(path.resolve(context.projectRoot, target)).isDirectory();
  } catch {
    return false;
  }
}

function unsafeGitPathspec(target: string): boolean {
  return target === "." || target.startsWith(":") || /[*?\[\]$`]/.test(target);
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
      || event === "codegraph.index.before"
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
