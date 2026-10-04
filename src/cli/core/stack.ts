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
  { signal: "node-backend", skill: SKILL_BACKEND, test: (deps) => ["express", "fastify", "koa", "hapi", "@nestjs/core"].some((dep) => deps.includes(dep)) },
  { signal: "persistence", skill: SKILL_BACKEND, test: (deps) => ["prisma", "typeorm", "sequelize", "mongoose", "pg", "mysql2", "sqlite3", "redis"].some((dep) => deps.includes(dep)) },
  { signal: "ai-js", skill: SKILL_AI, test: (deps) => ["openai", "@anthropic-ai/sdk", "langchain", "@langchain/core"].some((dep) => deps.includes(dep)) },
];

const DEVOPS_FILES = [
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  "Jenkinsfile",
];

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
  }

  if (fs.existsSync(path.join(root, "tsconfig.json"))) {
    signals.push({ signal: "typescript", evidence: "tsconfig.json" });
  }

  if (fs.existsSync(path.join(root, "pom.xml"))) {
    signals.push({ signal: "java-spring", evidence: "pom.xml" });
    skills.add(SKILL_BACKEND);
  }
  if (fs.existsSync(path.join(root, "build.gradle")) || fs.existsSync(path.join(root, "build.gradle.kts"))) {
    signals.push({ signal: "java-gradle", evidence: "build.gradle" });
    skills.add(SKILL_BACKEND);
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

  for (const file of DEVOPS_FILES) {
    if (fs.existsSync(path.join(root, file))) {
      signals.push({ signal: file.startsWith("docker") ? "docker" : "ci", evidence: file });
      skills.add(SKILL_DEVOPS);
    }
  }
  if (fs.existsSync(path.join(root, ".github", "workflows"))) {
    signals.push({ signal: "github-actions", evidence: ".github/workflows" });
    skills.add(SKILL_DEVOPS);
  }

  return { signals, skills: [...skills] };
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
