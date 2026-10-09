import fs from "node:fs";
import path from "node:path";

export interface StackSignal {
  signal: string;
  evidence: string;
}

export interface StackDetection {
  signals: StackSignal[];
  skills: string[];
}

const SKILL_BACKEND = "specialty-backend";
const SKILL_FRONTEND = "specialty-frontend";
const SKILL_DEVOPS = "specialty-devops";
const SKILL_AI = "specialty-ai-integration";
const SKILL_MOBILE = "specialty-mobile";
const SKILL_QUALITY = "specialty-quality";
const P_TYPESCRIPT = "programming/frontend/typescript";
const P_ANGULAR = "programming/frontend/angular";
const P_REACT = "programming/frontend/react";
const P_NEXTJS = "programming/frontend/nextjs";
const P_JAVA = "programming/backend/java";
const P_SPRING_BOOT = "programming/backend/spring-boot";
const P_NODE = "programming/backend/node";
const P_NESTJS = "programming/backend/nestjs";
const P_REST_API = "programming/backend/rest-api";
const P_DATABASE = "programming/backend/database";
const P_DOCKER = "programming/devops/docker";
const P_KUBERNETES = "programming/devops/kubernetes";
const P_CI_CD = "programming/devops/ci-cd";
const P_OBSERVABILITY = "programming/devops/observability";
const P_SONARQUBE = "programming/quality/sonarqube";
const P_TESTING = "programming/quality/testing";
const P_SECURITY = "programming/quality/security";
const P_AWS = "programming/cloud/aws";
const P_GCP = "programming/cloud/gcp";
const P_AZURE = "programming/cloud/azure";

interface PackageRule {
  signal: string;
  skill: string;
  test: (deps: string[]) => boolean;
}

const PACKAGE_RULES: PackageRule[] = [
  { signal: "react", skill: SKILL_FRONTEND, test: (deps) => deps.includes("react") },
  { signal: "next", skill: SKILL_FRONTEND, test: (deps) => deps.includes("next") },
  { signal: "angular", skill: SKILL_FRONTEND, test: (deps) => deps.includes("@angular/core") },
  { signal: "vue", skill: SKILL_FRONTEND, test: (deps) => deps.includes("vue") },
  { signal: "svelte", skill: SKILL_FRONTEND, test: (deps) => deps.includes("svelte") },
  { signal: "tailwind", skill: SKILL_FRONTEND, test: (deps) => deps.includes("tailwindcss") },
  { signal: "react-native", skill: SKILL_MOBILE, test: (deps) => deps.includes("react-native") },
  { signal: "expo", skill: SKILL_MOBILE, test: (deps) => deps.includes("expo") },
  { signal: "node-backend", skill: SKILL_BACKEND, test: (deps) => ["express", "fastify", "koa", "hapi", "@nestjs/core"].some((dep) => deps.includes(dep)) },
  { signal: "persistence", skill: SKILL_BACKEND, test: (deps) => ["prisma", "typeorm", "sequelize", "mongoose", "pg", "mysql2", "sqlite3", "redis"].some((dep) => deps.includes(dep)) },
  { signal: "ai-js", skill: SKILL_AI, test: (deps) => ["openai", "@anthropic-ai/sdk", "langchain", "@langchain/core"].some((dep) => deps.includes(dep)) },
  { signal: "testing-js", skill: SKILL_QUALITY, test: (deps) => ["vitest", "jest", "@playwright/test", "cypress", "testing-library", "@testing-library/react"].some((dep) => deps.includes(dep)) },
];

const DEVOPS_FILES = [
  "Dockerfile",
  "Containerfile",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  "Jenkinsfile",
];

const OPENAPI_FILES = ["openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.yml", "swagger.json"];
const NEXT_CONFIG_FILES = ["next.config.js", "next.config.mjs", "next.config.ts"];
const TERRAFORM_FILES = ["main.tf", "variables.tf", "providers.tf", "terraform.tfvars"];
const AZURE_IAC_FILES = ["main.bicep", "azure.yaml", "azure-pipelines.yml"];

const AI_PYTHON_MARKERS = ["langchain", "llama-index", "llamaindex", "openai", "anthropic", "sentence-transformers", "chromadb", "qdrant"];

export function detectStack(root = process.cwd()): StackDetection {
  const signals: StackSignal[] = [];
  const skills = new Set<string>();

  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) {
    const deps = collectDependencyNames(pkg);
    for (const rule of PACKAGE_RULES) {
      if (rule.test(deps)) {
        signals.push({ signal: rule.signal, evidence: "package.json" });
        skills.add(rule.skill);
      }
    }
    addPackageProgrammingSkills(deps, skills);
  }

  if (fs.existsSync(path.join(root, "tsconfig.json"))) {
    signals.push({ signal: "typescript", evidence: "tsconfig.json" });
    skills.add(P_TYPESCRIPT);
  }

  if (fs.existsSync(path.join(root, "angular.json"))) {
    signals.push({ signal: "angular-cli", evidence: "angular.json" });
    skills.add(SKILL_FRONTEND);
    skills.add(P_ANGULAR);
    skills.add(P_TYPESCRIPT);
  }

  if (fileExistsAny(root, NEXT_CONFIG_FILES)) {
    signals.push({ signal: "next-config", evidence: "next.config.*" });
    skills.add(SKILL_FRONTEND);
    skills.add(P_REACT);
    skills.add(P_NEXTJS);
    skills.add(P_TYPESCRIPT);
  }

  if (fs.existsSync(path.join(root, "nest-cli.json"))) {
    signals.push({ signal: "nestjs-cli", evidence: "nest-cli.json" });
    skills.add(SKILL_BACKEND);
    skills.add(P_NODE);
    skills.add(P_NESTJS);
    skills.add(P_TYPESCRIPT);
  }

  if (fileExistsAny(root, OPENAPI_FILES)) {
    signals.push({ signal: "openapi", evidence: "openapi|swagger" });
    skills.add(SKILL_BACKEND);
    skills.add(P_REST_API);
  }

  if (fs.existsSync(path.join(root, "pom.xml"))) {
    const pom = safeRead(path.join(root, "pom.xml"));
    const spring = pom.includes("spring-boot") || pom.includes("springframework");
    signals.push({ signal: spring ? "spring-boot" : "java", evidence: "pom.xml" });
    skills.add(SKILL_BACKEND);
    skills.add(P_JAVA);
    if (spring) skills.add(P_SPRING_BOOT);
    if (pom.includes("spring-boot-starter-web")) skills.add(P_REST_API);
    if (pom.includes("spring-boot-starter-data") || pom.includes("hibernate")) skills.add(P_DATABASE);
  }
  if (fs.existsSync(path.join(root, "mvnw"))) {
    signals.push({ signal: "maven-wrapper", evidence: "mvnw" });
    skills.add(SKILL_BACKEND);
    skills.add(P_JAVA);
  }
  if (fs.existsSync(path.join(root, "build.gradle")) || fs.existsSync(path.join(root, "build.gradle.kts"))) {
    const gradleFile = fs.existsSync(path.join(root, "build.gradle")) ? "build.gradle" : "build.gradle.kts";
    const gradle = safeRead(path.join(root, gradleFile));
    const spring = gradle.includes("spring-boot") || gradle.includes("org.springframework");
    signals.push({ signal: spring ? "spring-boot-gradle" : "java-gradle", evidence: gradleFile });
    skills.add(SKILL_BACKEND);
    skills.add(P_JAVA);
    if (spring) skills.add(P_SPRING_BOOT);
  }
  if (fs.existsSync(path.join(root, "gradlew"))) {
    signals.push({ signal: "gradle-wrapper", evidence: "gradlew" });
    skills.add(SKILL_BACKEND);
    skills.add(P_JAVA);
  }

  if (fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "requirements.txt"))) {
    signals.push({ signal: "python", evidence: "pyproject.toml|requirements.txt" });
    skills.add(SKILL_BACKEND);
    if (hasAnyFileContaining(root, ["pyproject.toml", "requirements.txt"], AI_PYTHON_MARKERS)) {
      signals.push({ signal: "ai-python", evidence: "deps" });
      skills.add(SKILL_AI);
    }
  }

  if (fs.existsSync(path.join(root, "go.mod"))) {
    signals.push({ signal: "go", evidence: "go.mod" });
    skills.add(SKILL_BACKEND);
  }

  if (fs.existsSync(path.join(root, "pubspec.yaml"))) {
    signals.push({ signal: "flutter", evidence: "pubspec.yaml" });
    skills.add(SKILL_MOBILE);
    skills.add("programming/frontend/mobile");
  }

  for (const file of DEVOPS_FILES) {
    if (fs.existsSync(path.join(root, file))) {
      const normalized = file.toLowerCase();
      const isDocker = normalized.includes("docker") || normalized === "dockerfile" || normalized === "containerfile" || normalized.startsWith("compose.");
      signals.push({ signal: isDocker ? "docker" : "ci", evidence: file });
      skills.add(SKILL_DEVOPS);
      if (isDocker) skills.add(P_DOCKER);
      if (file === "docker-compose.yml" || file === "docker-compose.yaml") skills.add(P_DOCKER);
      if (!isDocker) skills.add(P_CI_CD);
      if (file === "azure-pipelines.yml") skills.add(P_AZURE);
    }
  }
  if (fs.existsSync(path.join(root, ".github", "workflows"))) {
    signals.push({ signal: "github-actions", evidence: ".github/workflows" });
    skills.add(SKILL_DEVOPS);
    skills.add(SKILL_QUALITY);
    skills.add(P_CI_CD);
    skills.add(P_TESTING);
  }

  if (hasKubernetesManifests(root)) {
    signals.push({ signal: "kubernetes", evidence: "k8s|kubernetes|helm|charts|*.yaml" });
    skills.add(SKILL_DEVOPS);
    skills.add(P_KUBERNETES);
  }

  if (fs.existsSync(path.join(root, "Chart.yaml"))) {
    signals.push({ signal: "helm-chart", evidence: "Chart.yaml" });
    skills.add(SKILL_DEVOPS);
    skills.add(P_KUBERNETES);
  }

  if (fs.existsSync(path.join(root, "kustomization.yaml")) || fs.existsSync(path.join(root, "kustomization.yml"))) {
    signals.push({ signal: "kustomize", evidence: "kustomization.yaml" });
    skills.add(SKILL_DEVOPS);
    skills.add(P_KUBERNETES);
  }

  if (fs.existsSync(path.join(root, "sonar-project.properties"))) {
    signals.push({ signal: "sonarqube", evidence: "sonar-project.properties" });
    skills.add(SKILL_QUALITY);
    skills.add(P_SONARQUBE);
  }

  if (fs.existsSync(path.join(root, "serverless.yml")) || fs.existsSync(path.join(root, "serverless.yaml"))) {
    signals.push({ signal: "serverless", evidence: "serverless.yml" });
    skills.add(SKILL_DEVOPS);
    skills.add(P_AWS);
  }
  if (hasAwsIaC(root)) {
    signals.push({ signal: "aws-iac", evidence: "template.yaml|samconfig.toml|cdk.json" });
    skills.add(SKILL_DEVOPS);
    skills.add(P_AWS);
  }
  if (fs.existsSync(path.join(root, "cloudbuild.yaml"))) {
    signals.push({ signal: "gcp-cloud-build", evidence: "cloudbuild.yaml" });
    skills.add(SKILL_DEVOPS);
    skills.add(P_GCP);
    skills.add(P_CI_CD);
  }
  if (fileExistsAny(root, AZURE_IAC_FILES)) {
    signals.push({ signal: "azure-iac", evidence: "main.bicep|azure.yaml|azure-pipelines.yml" });
    skills.add(SKILL_DEVOPS);
    skills.add(P_AZURE);
  }

  if (fileExistsAny(root, TERRAFORM_FILES)) {
    const terraform = TERRAFORM_FILES.map((file) => safeRead(path.join(root, file))).join("\n");
    signals.push({ signal: "terraform", evidence: "*.tf" });
    skills.add(SKILL_DEVOPS);
    if (terraform.includes("hashicorp/aws") || terraform.includes("provider \"aws\"")) skills.add(P_AWS);
    if (terraform.includes("hashicorp/google") || terraform.includes("provider \"google\"")) skills.add(P_GCP);
    if (terraform.includes("hashicorp/azurerm") || terraform.includes("provider \"azurerm\"")) skills.add(P_AZURE);
  }

  if (hasRootFileContaining(root, ["otel", "opentelemetry", "micrometer", "prometheus", "grafana"])) {
    signals.push({ signal: "observability", evidence: "opentelemetry|micrometer|prometheus|grafana" });
    skills.add(SKILL_DEVOPS);
    skills.add(P_OBSERVABILITY);
  }

  for (const file of ["vitest.config.ts", "vitest.config.js", "jest.config.js", "playwright.config.ts", "cypress.config.ts"]) {
    if (fs.existsSync(path.join(root, file))) {
      signals.push({ signal: "testing-config", evidence: file });
      skills.add(SKILL_QUALITY);
      skills.add(P_TESTING);
    }
  }

  return { signals, skills: [...skills] };
}

function addPackageProgrammingSkills(deps: string[], skills: Set<string>): void {
  if (deps.includes("typescript")) skills.add(P_TYPESCRIPT);
  if (deps.includes("@angular/core")) {
    skills.add(P_ANGULAR);
    skills.add(P_TYPESCRIPT);
  }
  if (deps.includes("react")) skills.add(P_REACT);
  if (deps.includes("next")) skills.add(P_NEXTJS);
  if (deps.includes("@nestjs/core")) {
    skills.add(P_NODE);
    skills.add(P_NESTJS);
    skills.add(P_TYPESCRIPT);
  }
  if (["express", "fastify", "koa", "hapi", "hono"].some((dep) => deps.includes(dep))) {
    skills.add(P_NODE);
    skills.add(P_REST_API);
  }
  if (["prisma", "typeorm", "sequelize", "mongoose", "pg", "mysql2", "sqlite3", "redis"].some((dep) => deps.includes(dep))) {
    skills.add(P_DATABASE);
  }
  if (["vitest", "jest", "@playwright/test", "cypress", "@testing-library/react"].some((dep) => deps.includes(dep))) {
    skills.add(P_TESTING);
  }
  if (["@opentelemetry/api", "@opentelemetry/sdk-node", "prom-client", "pino", "winston"].some((dep) => deps.includes(dep))) {
    skills.add(SKILL_DEVOPS);
    skills.add(P_OBSERVABILITY);
  }
  if (["helmet", "jsonwebtoken", "jose", "passport", "@nestjs/passport"].some((dep) => deps.includes(dep))) {
    skills.add(SKILL_QUALITY);
    skills.add(P_SECURITY);
  }
  if (deps.includes("react-native") || deps.includes("expo")) {
    skills.add("programming/frontend/mobile");
    skills.add(P_TYPESCRIPT);
  }
}

function fileExistsAny(root: string, files: string[]): boolean {
  return files.some((file) => fs.existsSync(path.join(root, file)));
}

function hasAwsIaC(root: string): boolean {
  if (fs.existsSync(path.join(root, "samconfig.toml")) || fs.existsSync(path.join(root, "cdk.json"))) return true;

  for (const file of ["template.yaml", "template.yml"]) {
    const raw = safeRead(path.join(root, file));
    if (raw.includes("AWS::") || raw.includes("AWS::Serverless") || raw.includes("Transform: AWS::Serverless")) return true;
  }

  return false;
}

function hasRootFileContaining(root: string, markers: string[]): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return false;
  }

  for (const entry of entries) {
    const filePath = path.join(root, entry);
    if (!fs.statSync(filePath).isFile()) continue;
    if (!/\.(json|ya?ml|toml|tf|xml|gradle|kts|properties)$/.test(entry) && !["Dockerfile", "Containerfile"].includes(entry)) continue;
    const raw = safeRead(filePath).toLowerCase();
    if (markers.some((marker) => raw.includes(marker))) return true;
  }
  return false;
}

function hasKubernetesManifests(root: string): boolean {
  for (const dir of ["k8s", "kubernetes", "helm", "charts"]) {
    if (fs.existsSync(path.join(root, dir))) return true;
  }

  for (const file of ["deployment.yaml", "deployment.yml", "service.yaml", "service.yml", "ingress.yaml", "ingress.yml"]) {
    const filePath = path.join(root, file);
    if (fs.existsSync(filePath) && safeRead(filePath).includes("apiVersion:")) return true;
  }

  return false;
}

function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function collectDependencyNames(pkg: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const record = asRecord(pkg[key]);
    if (record) names.push(...Object.keys(record));
  }
  return names;
}

function hasAnyFileContaining(root: string, files: string[], markers: string[]): boolean {
  for (const file of files) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      if (markers.some((marker) => raw.includes(marker))) return true;
    } catch {
      // Archivo ilegible; se ignora.
    }
  }
  return false;
}

function readJson(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
