import fs from "node:fs";
import path from "node:path";

export type InfrastructureSurface = "ci-cd" | "iac" | "deployment" | "release";

export interface InfrastructureClassification {
  protected: boolean;
  surface?: InfrastructureSurface;
  evidence?: string;
  relativePath?: string;
}

const CI_DIRECTORIES = [
  ".github/workflows",
  ".github/actions",
  ".gitlab/ci",
  ".circleci",
  ".buildkite",
  ".azure-pipelines",
  ".drone",
  ".tekton",
  "tekton",
] as const;

const INFRASTRUCTURE_DIRECTORIES = new Map<string, InfrastructureSurface>([
  ["infra", "iac"],
  ["infrastructure", "iac"],
  ["terraform", "iac"],
  ["tofu", "iac"],
  ["pulumi", "iac"],
  ["cloudformation", "iac"],
  ["cdk", "iac"],
  ["deploy", "deployment"],
  ["deployment", "deployment"],
  ["k8s", "deployment"],
  ["kubernetes", "deployment"],
  ["helm", "deployment"],
  ["charts", "deployment"],
  ["argocd", "deployment"],
  [".argocd", "deployment"],
  ["flux", "deployment"],
  [".flux", "deployment"],
]);

const CI_FILES = [
  /^\.gitlab-ci\.ya?ml$/,
  /^azure-pipelines(?:[._-].*)?\.ya?ml$/,
  /^jenkinsfile(?:\..*)?$/,
  /^bitbucket-pipelines\.ya?ml$/,
  /^\.drone\.ya?ml$/,
  /^\.travis\.ya?ml$/,
  /^cloudbuild(?:[._-].*)?\.ya?ml$/,
  /^appveyor\.ya?ml$/,
] as const;

const IAC_FILES = [
  /\.tf(?:\.json)?$/,
  /\.tfvars(?:\.json)?$/,
  /\.bicep$/,
  /^\.terraform\.lock\.hcl$/,
  /^pulumi(?:\..+)?\.ya?ml$/,
  /^cdk\.json$/,
  /^samconfig\.toml$/,
] as const;

const DEPLOYMENT_FILES = [
  /^chart\.ya?ml$/,
  /^kustomization\.ya?ml$/,
  /^skaffold\.ya?ml$/,
  /^tiltfile$/,
  /^serverless\.ya?ml$/,
  /^helmfile\.ya?ml$/,
  /^values(?:[._-].*)?\.ya?ml$/,
  /^dockerfile(?:\..*)?$/,
  /^containerfile(?:\..*)?$/,
  /^(?:docker-)?compose(?:[._-].*)?\.ya?ml$/,
  /^vercel\.json$/,
  /^netlify\.toml$/,
  /^fly\.toml$/,
  /^firebase\.json$/,
  /^railway\.(?:json|toml)$/,
  /^appspec\.ya?ml$/,
  /^render\.ya?ml$/,
] as const;

const RELEASE_FILES = [
  /^\.npmrc$/,
  /^\.releaserc(?:\..*)?$/,
  /^release\.config\.[a-z0-9]+$/,
  /^\.changeset\/config\.json$/,
] as const;

const DEPLOYMENT_SCRIPT = /^(?:deploy|release|publish)(?:[._-].*)?\.(?:sh|bash|zsh|ps1|cmd|bat|js|mjs|cjs|ts|py|rb)$/;

export function classifyInfrastructurePath(
  projectRoot: string,
  targetPath: string,
): InfrastructureClassification {
  for (const relativePath of relativeCandidates(projectRoot, targetPath)) {
    const classification = classifyRelativePath(relativePath);
    if (classification.protected) return { ...classification, relativePath };
  }
  const markerScoped = classifyMarkerScopedPath(projectRoot, targetPath);
  if (markerScoped.protected) return markerScoped;
  return { protected: false };
}

export function classifyInfrastructureCommand(command: string): InfrastructureClassification {
  for (const segment of commandSegments(command)) {
    const classification = classifyCommandSegment(segment);
    if (classification.protected) return classification;
  }
  return { protected: false };
}

function classifyRelativePath(relativePath: string): InfrastructureClassification {
  const normalized = normalizeRelative(relativePath);
  if (!normalized) return { protected: false };

  if (CI_DIRECTORIES.some((directory) => normalized === directory || normalized.startsWith(`${directory}/`))) {
    return protectedMatch("ci-cd", "directorio de automatizacion CI/CD");
  }

  const segments = normalized.split("/");
  const first = segments[0] ?? "";
  const base = segments.at(-1) ?? "";
  const directorySurface = INFRASTRUCTURE_DIRECTORIES.get(first);
  if (directorySurface) return protectedMatch(directorySurface, `directorio raiz ${first}`);

  if (CI_FILES.some((pattern) => pattern.test(base))) {
    return protectedMatch("ci-cd", `definicion CI/CD ${base}`);
  }
  if (segments.length === 1 && /^template\.(?:ya?ml|json)$/.test(base)) {
    return protectedMatch("iac", `plantilla declarativa ${base}`);
  }
  if (IAC_FILES.some((pattern) => pattern.test(base))) {
    return protectedMatch("iac", `infraestructura como codigo ${base}`);
  }
  if (DEPLOYMENT_FILES.some((pattern) => pattern.test(base))) {
    return protectedMatch("deployment", `configuracion de despliegue ${base}`);
  }
  if (RELEASE_FILES.some((pattern) => pattern.test(normalized) || pattern.test(base))) {
    return protectedMatch("release", `configuracion de publicacion ${normalized}`);
  }
  if ((segments.length === 1 || (segments.length === 2 && segments[0] === "scripts")) && DEPLOYMENT_SCRIPT.test(base)) {
    return protectedMatch("deployment", `script operativo ${normalized}`);
  }

  return { protected: false };
}

function classifyCommandSegment(segment: string): InfrastructureClassification {
  const normalized = segment.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return { protected: false };

  const dryRun = /(?:^|\s)--dry-run(?:=(?:true|client|server))?(?:\s|$)/.test(normalized);
  if (isDirectPublish(normalized) && !dryRun) return protectedMatch("release", "publicacion de paquete o artefacto");
  if (isCiOrReleaseTrigger(normalized)) return protectedMatch("ci-cd", "disparo o modificacion de workflow/release");
  if (isContainerPublish(normalized)) return protectedMatch("release", "publicacion de imagen o chart");
  if (isTerraformMutation(normalized)) return protectedMatch("iac", "operacion mutante de Terraform/OpenTofu");
  if (isPulumiMutation(normalized)) return protectedMatch("iac", "operacion mutante de Pulumi");
  if (isKubectlMutation(normalized) && !dryRun) return protectedMatch("deployment", "operacion mutante de kubectl");
  if (isHelmMutation(normalized) && !dryRun) return protectedMatch("deployment", "operacion mutante de Helm");
  if (isCloudDeployment(normalized)) return protectedMatch("deployment", "operacion de despliegue cloud");
  if (isDeploymentTask(normalized) && !(dryRun && isDirectPublish(normalized))) {
    return protectedMatch("deployment", "tarea o script de deploy/release/publish");
  }

  return { protected: false };
}

function isDirectPublish(command: string): boolean {
  return /\b(?:npm|pnpm|bun)\b[^;&|]*\bpublish\b/.test(command)
    || /\byarn\b[^;&|]*\bpublish\b/.test(command)
    || /\bsemantic-release\b/.test(command)
    || /\bchangeset\s+publish\b/.test(command)
    || /\bcargo\s+publish\b/.test(command)
    || /\bmvn(?:w)?\b[^;&|]*\bdeploy\b/.test(command)
    || /\bgradle(?:w)?\b[^;&|]*\bpublish\b/.test(command)
    || /\bdotnet\s+nuget\s+push\b/.test(command)
    || /\btwine\s+upload\b/.test(command)
    || /\bgem\s+push\b/.test(command);
}

function isCiOrReleaseTrigger(command: string): boolean {
  return /\bgh\b[^;&|]*\bworkflow\s+run\b/.test(command)
    || /\bgh\b[^;&|]*\brun\s+rerun\b/.test(command)
    || /\bgh\b[^;&|]*\brelease\s+(?:create|upload|edit|delete)\b/.test(command)
    || /\bglab\b[^;&|]*\b(?:ci\s+run|pipeline\s+(?:run|retry|cancel))\b/.test(command);
}

function isContainerPublish(command: string): boolean {
  return /\b(?:docker|podman)\b[^;&|]*\bpush\b/.test(command)
    || /\bdocker\b[^;&|]*\bbuildx\s+build\b[^;&|]*\s--push(?:\s|$)/.test(command)
    || /\bhelm\b[^;&|]*\bpush\b/.test(command);
}

function isTerraformMutation(command: string): boolean {
  if (!/\b(?:terraform|tofu)\b/.test(command)) return false;
  if (/\bfmt\b/.test(command)) return !/(?:^|\s)-(?:check|-check)(?:\s|$)/.test(command);
  if (/\binit\b/.test(command)) {
    return /(?:^|\s)-(?:upgrade|-upgrade|migrate-state|-migrate-state|reconfigure|-reconfigure)(?:\s|$)/.test(command);
  }
  return /\b(?:apply|destroy|import|taint|untaint|force-unlock)\b/.test(command)
    || /\bstate\s+(?:mv|rm|push|replace-provider)\b/.test(command)
    || /\bworkspace\s+(?:new|delete)\b/.test(command);
}

function isPulumiMutation(command: string): boolean {
  return /\bpulumi\b[^;&|]*\b(?:up|destroy|import|refresh|cancel)\b/.test(command)
    || /\bpulumi\b[^;&|]*\bstate\s+(?:delete|move|repair|unprotect)\b/.test(command);
}

function isKubectlMutation(command: string): boolean {
  return /\bkubectl\b[^;&|]*\b(?:apply|create|delete|replace|patch|edit|set|scale|rollout|annotate|label|taint|drain|cordon|uncordon|expose|autoscale|exec|cp)\b/.test(command);
}

function isHelmMutation(command: string): boolean {
  return /\bhelm\b[^;&|]*\b(?:install|upgrade|uninstall|rollback)\b/.test(command);
}

function isCloudDeployment(command: string): boolean {
  return /\baws\b[^;&|]*\bcloudformation\s+(?:deploy|create-stack|update-stack|delete-stack|create-change-set|execute-change-set)\b/.test(command)
    || /\baz\b[^;&|]*\bdeployment\b[^;&|]*\b(?:create|delete)\b/.test(command)
    || /\bgcloud\b[^;&|]*\b(?:run\s+deploy|app\s+deploy|functions\s+deploy|deploy\s+releases\s+create)\b/.test(command)
    || /\b(?:firebase|vercel|netlify|fly|flyctl|railway|serverless|sls|sam|cdk)\b[^;&|]*\b(?:deploy|remove|destroy|up|promote|rollback|publish)\b/.test(command)
    || /\bheroku\b[^;&|]*\b(?:container:(?:push|release)|releases:rollback)\b/.test(command);
}

function isDeploymentTask(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\b[^;&|]*\b(?:run\s+)?(?:deploy|release|publish)(?::[a-z0-9._-]+)?\b/.test(command)
    || /\b(?:make|just|task)\s+(?:deploy|release|publish)(?::[a-z0-9._-]+)?\b/.test(command)
    || /(?:^|\s)(?:\.\/)?(?:scripts\/)?(?:deploy|release|publish)(?:[._-][^\s;&|]+)?(?:\s|$)/.test(command);
}

function commandSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|\n])/).map((segment) => segment.trim()).filter(Boolean);
}

function protectedMatch(surface: InfrastructureSurface, evidence: string): InfrastructureClassification {
  return { protected: true, surface, evidence };
}

function relativeCandidates(projectRoot: string, targetPath: string): string[] {
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalTarget = path.resolve(targetPath);
  const canonicalRoot = canonicalPlannedPath(lexicalRoot);
  const canonicalTarget = canonicalPlannedPath(lexicalTarget);
  const candidates = [
    relativeInside(lexicalRoot, lexicalTarget),
    relativeInside(canonicalRoot, canonicalTarget),
  ].filter((value): value is string => value !== undefined);
  return [...new Set(candidates)];
}

function classifyMarkerScopedPath(projectRoot: string, targetPath: string): InfrastructureClassification {
  const pairs = [
    [path.resolve(projectRoot), path.resolve(targetPath)],
    [canonicalPlannedPath(projectRoot), canonicalPlannedPath(targetPath)],
  ] as const;

  for (const [root, target] of pairs) {
    if (relativeInside(root, target) === undefined) continue;
    let current = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
    while (relativeInside(root, current) !== undefined) {
      if (fileExistsAny(current, ["Chart.yaml", "Chart.yml"])) {
        return { ...protectedMatch("deployment", "archivo dentro de un chart Helm"), relativePath: normalizeRelative(path.relative(root, target)) };
      }
      if (fileExistsAny(current, ["Pulumi.yaml", "Pulumi.yml"])) {
        return { ...protectedMatch("iac", "archivo dentro de un proyecto Pulumi"), relativePath: normalizeRelative(path.relative(root, target)) };
      }
      if (fs.existsSync(path.join(current, "cdk.json"))) {
        const relative = normalizeRelative(path.relative(current, target));
        const first = relative.split("/")[0] ?? "";
        if (["bin", "lib", "src", "stacks"].includes(first)) {
          return { ...protectedMatch("iac", "codigo de infraestructura AWS CDK"), relativePath: normalizeRelative(path.relative(root, target)) };
        }
      }
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return { protected: false };
}

function fileExistsAny(directory: string, names: string[]): boolean {
  return names.some((name) => {
    try {
      return fs.statSync(path.join(directory, name)).isFile();
    } catch {
      return false;
    }
  });
}

function relativeInside(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  if (relative === "") return "";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative;
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
  try {
    return path.resolve(fs.realpathSync(current), ...suffix);
  } catch {
    return resolved;
  }
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "").toLowerCase();
}
