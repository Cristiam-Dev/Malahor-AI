import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  classifyInfrastructureCommand,
  classifyInfrastructurePath,
} from "../src/cli/core/infrastructure-boundary";
import { runHooks } from "../src/cli/core/hooks/engine";
import type { HookContext, HookPolicyMeta } from "../src/cli/core/hooks/types";
import { toolDefinitions } from "../src/mnemo/tools";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

function temporaryRepo(): string {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-infra-boundary-"));
  fixtures.push(root);
  fs.mkdirSync(path.join(root, ".malahor"), { recursive: true });
  return root;
}

function policyMeta(): HookPolicyMeta {
  return {
    contractVersion: 1,
    schemaVersion: 1,
    policyVersion: "test",
    issuer: "test",
    policyHash: "a".repeat(64),
    sources: [],
    corporateStatus: "absent",
    corporateRequired: false,
    criticalGaps: [],
    warnings: [],
  };
}

function context(root: string, overrides: Partial<HookContext> = {}): HookContext {
  return {
    event: "file.write.before",
    harness: "cli",
    profile: "off",
    cwd: root,
    projectRoot: root,
    malahorHome: path.join(root, ".malahor"),
    project: "demo",
    policyMeta: policyMeta(),
    audit: { enabled: false },
    ...overrides,
  };
}

function infrastructureAsk(result: ReturnType<typeof runHooks>): boolean {
  return result.violations.some((violation) => violation.id === "MAL-HOOK-INFRA-APPROVAL");
}

describe("clasificador estructural de infraestructura", () => {
  test("clasifica definiciones CI/CD, IaC, despliegue y release", () => {
    const root = temporaryRepo();
    const protectedPaths = [
      ".github/workflows/ci.yml",
      ".github/actions/check/action.yml",
      ".gitlab-ci.yml",
      "infra/network/main.tf",
      "modules/network/variables.tfvars.json",
      "template.yaml",
      "deploy/prod/service.yaml",
      "charts/api/Chart.yaml",
      "Dockerfile.production",
      ".npmrc",
      "scripts/release.sh",
      ".changeset/config.json",
    ];
    const ordinaryPaths = [
      "src/deployment-service.ts",
      "docs/infra-overview.md",
      "package.json",
      "src/dockerfile-parser.ts",
      ".github/ISSUE_TEMPLATE/bug.md",
    ];

    for (const target of protectedPaths) {
      expect(classifyInfrastructurePath(root, path.join(root, target)).protected).toBe(true);
    }
    for (const target of ordinaryPaths) {
      expect(classifyInfrastructurePath(root, path.join(root, target)).protected).toBe(false);
    }
  });

  test("resuelve aliases symlink antes de clasificar", () => {
    const root = temporaryRepo();
    const workflows = path.join(root, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.symlinkSync(workflows, path.join(root, "automation"), "dir");

    const result = classifyInfrastructurePath(root, path.join(root, "automation", "release.yml"));

    expect(result.protected).toBe(true);
    expect(result.surface).toBe("ci-cd");
  });

  test("protege codigo y valores dentro de proyectos IaC detectados por marcador", () => {
    const root = temporaryRepo();
    fs.mkdirSync(path.join(root, "services", "chart", "templates"), { recursive: true });
    fs.writeFileSync(path.join(root, "services", "chart", "Chart.yaml"), "apiVersion: v2\n", "utf8");
    fs.mkdirSync(path.join(root, "platform"), { recursive: true });
    fs.writeFileSync(path.join(root, "platform", "Pulumi.yaml"), "name: platform\n", "utf8");
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "cdk.json"), "{}\n", "utf8");

    for (const target of [
      "services/chart/templates/deployment.yaml",
      "services/chart/values-production.yaml",
      "platform/index.ts",
      "lib/application-stack.ts",
    ]) {
      expect(classifyInfrastructurePath(root, path.join(root, target)).protected).toBe(true);
    }
  });

  test("distingue comandos mutantes de analisis y dry-run", () => {
    const protectedCommands = [
      "npm publish",
      "docker push registry.example/app:1",
      "terraform apply plan.tfplan",
      "terraform -chdir=infra apply plan.tfplan",
      "tofu fmt infra/main.tf",
      "pulumi up --yes",
      "kubectl apply -f k8s/prod.yaml",
      "helm upgrade --install api charts/api",
      "gh workflow run deploy.yml",
      "firebase deploy",
      "firebase --project production deploy",
      "pnpm run deploy:prod",
      "echo --dry-run | npm publish",
      "npm publish --dry-run=false",
    ];
    const analysisCommands = [
      "npm publish --dry-run",
      "npm pack --dry-run",
      "terraform plan",
      "terraform validate",
      "terraform fmt -check",
      "kubectl get pods",
      "kubectl apply --dry-run=server -f k8s/prod.yaml",
      "helm template api charts/api",
      "helm upgrade --dry-run api charts/api",
      "cat .github/workflows/ci.yml",
    ];

    for (const command of protectedCommands) {
      expect(classifyInfrastructureCommand(command).protected).toBe(true);
    }
    for (const command of analysisCommands) {
      expect(classifyInfrastructureCommand(command).protected).toBe(false);
    }
  });
});

describe("guard built-in de infraestructura", () => {
  test("lectura queda permitida y escritura protegida exige ASK incluso con profile off", () => {
    const root = temporaryRepo();
    const target = ".github/workflows/ci.yml";
    const read = runHooks(context(root, {
      event: "file.read.before",
      resourceKind: "filesystem",
      targetPaths: [target],
    }));
    const write = runHooks(context(root, {
      event: "file.write.before",
      resourceKind: "filesystem",
      targetPaths: [target],
      confirmation: "USER_REQUESTED_COMMIT",
      metadata: {
        planID: "plan-fixture",
        revision: "rev-fixture",
        userExplicitlyRequestedCommit: true,
      },
    }));
    const ordinary = runHooks(context(root, {
      event: "file.write.before",
      resourceKind: "filesystem",
      targetPaths: ["src/app.ts"],
    }));

    expect(read.decision).toBe("allow");
    expect(write.decision).toBe("ask");
    expect(infrastructureAsk(write)).toBe(true);
    expect(ordinary.decision).toBe("allow");
  });

  test("stage, commit y push no heredan consentimiento Git", () => {
    const root = temporaryRepo();
    const target = ".github/workflows/ci.yml";
    const stage = runHooks(context(root, {
      event: "file.stage.before",
      command: `git add -- ${target}`,
      resourceKind: "filesystem",
      targetPaths: [target],
      confirmation: "USER_REQUESTED_STAGE",
    }));
    const commit = runHooks(context(root, {
      event: "git.commit.before",
      command: "git commit -m '🔒 ci(security): protege despliegues'",
      resourceKind: "filesystem",
      targetPaths: [target],
      confirmation: "USER_REQUESTED_COMMIT",
    }));
    const push = runHooks(context(root, {
      event: "git.push.before",
      command: "git push",
      resourceKind: "filesystem",
      targetPaths: [target],
      confirmation: "CHECKS_OK",
    }));

    for (const result of [stage, commit, push]) {
      expect(result.decision).toBe("ask");
      expect(infrastructureAsk(result)).toBe(true);
    }
  });

  test("descubre rutas staged y outgoing aunque el caller no las declare", () => {
    const root = temporaryRepo();
    const target = ".github/workflows/ci.yml";
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(root, target), "name: CI\n", "utf8");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "--", target], { cwd: root });

    const staged = runHooks(context(root, {
      event: "git.commit.before",
      command: "git commit -m '🔒 ci(security): protege despliegues'",
      confirmation: "USER_REQUESTED_COMMIT",
    }));
    expect(infrastructureAsk(staged)).toBe(true);

    execFileSync("git", [
      "-c", "user.name=Malahor Fixture",
      "-c", "user.email=fixture@malahor.invalid",
      "-c", "commit.gpgsign=false",
      "commit", "--quiet", "--no-verify", "-m", "fixture",
    ], { cwd: root });
    const outgoing = runHooks(context(root, {
      event: "git.push.before",
      command: "git push",
    }));
    expect(infrastructureAsk(outgoing)).toBe(true);
  });

  test("git add exacto no hereda otro cambio protegido pero git add -A si", () => {
    const root = temporaryRepo();
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "name: CI\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "app.ts"), "export {};\n", "utf8");
    execFileSync("git", ["init", "--quiet"], { cwd: root });

    const exact = runHooks(context(root, {
      event: "shell.exec.before",
      command: "git add -- src/app.ts",
      confirmation: "USER_REQUESTED_STAGE",
    }));
    const broad = runHooks(context(root, {
      event: "shell.exec.before",
      command: "git add -A",
      confirmation: "USER_REQUESTED_STAGE",
    }));

    expect(infrastructureAsk(exact)).toBe(false);
    expect(infrastructureAsk(broad)).toBe(true);
  });

  test("una escritura sin recursos se mantiene fail-closed como ASK", () => {
    const root = temporaryRepo();
    const result = runHooks(context(root, { event: "file.write.before", targetPaths: [] }));

    expect(result.decision).toBe("ask");
    expect(infrastructureAsk(result)).toBe(true);
  });

  test("el contrato MCP expone el nonce de aprobacion separado", () => {
    const hook = toolDefinitions.find((definition) => definition.name === "malahor_hook_check");
    const properties = hook?.inputSchema.properties as Record<string, unknown>;

    expect(properties.approval).toBeDefined();
  });
});
