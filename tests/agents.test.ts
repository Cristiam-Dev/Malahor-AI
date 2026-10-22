import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  MALAHOR_AGENT_FILE,
  MALAHOR_AGENT_IDS,
  MALAHOR_AGENT_MARKER,
  agentContractProblems,
  agentState,
  assertAgentAssets,
  describeAgentRemoval,
  describeAgentSync,
  malahorAgentAssetPath,
  malahorAgentPath,
  readAgentContract,
  removeManagedAgent,
  removeManagedAgents,
  syncManagedAgent,
  syncManagedAgents,
  type MalahorAgentId,
} from "../src/cli/core/opencode-agents";
import { MALAHOR_COMMAND_FILES } from "../src/cli/core/opencode-commands";
import type { MalahorPaths } from "../src/cli/core/paths";
import { validateInstallation } from "../src/cli/core/validate";

const ASSETS_DIR = path.join(process.cwd(), "assets");
const V2_ASSET = path.join(ASSETS_DIR, "opencode", "agents", "v2", MALAHOR_AGENT_FILE);
const V1_ASSET = path.join(ASSETS_DIR, "opencode", "agents", "v1", MALAHOR_AGENT_FILE);

const EXPECTED_CONTRACTS = {
  malahor: {
    mode: "primary",
    delegationDenyAll: true,
    delegationAllowManaged: true,
    questionAllowed: true,
    editDenyAll: false,
    shellDenyAll: false,
    hasEditAllow: false,
    hasShellAllow: false,
  },
  "malahor-diagnostico": {
    mode: "subagent",
    delegationDenyAll: true,
    delegationAllowManaged: false,
    questionAllowed: false,
    editDenyAll: true,
    shellDenyAll: true,
    hasEditAllow: false,
    hasShellAllow: true,
  },
  "malahor-testing": {
    mode: "subagent",
    delegationDenyAll: true,
    delegationAllowManaged: false,
    questionAllowed: false,
    editDenyAll: true,
    shellDenyAll: true,
    hasEditAllow: true,
    hasShellAllow: true,
  },
} as const;

function tempDir(): string {
  return fs.mkdtempSync(path.join("/tmp/opencode", "malahor-agents-"));
}

function pathsFor(root: string): MalahorPaths {
  return {
    opencodeDir: path.join(root, "opencode"),
    backupsDir: path.join(root, "backups"),
  } as MalahorPaths;
}

function validationPathsFor(root: string): MalahorPaths {
  const opencodeDir = path.join(root, "opencode");

  return {
    opencodeDir,
    backupsDir: path.join(root, "backups"),
    malahorHome: path.join(root, "malahor"),
    mnemoIndex: path.join(root, "malahor", "mnemo", "index.js"),
    assetsDir: path.join(root, "malahor", "assets"),
    agentsMd: path.join(opencodeDir, "AGENTS.md"),
    opencodeConfig: path.join(opencodeDir, "opencode.jsonc"),
  } as MalahorPaths;
}

function assetPath(host: "v1" | "v2", agentId: MalahorAgentId): string {
  return path.join(ASSETS_DIR, "opencode", "agents", host, `${agentId}.md`);
}

function writeForeign(
  paths: MalahorPaths,
  content = "---\ndescription: mio\n---\n",
  agentId: MalahorAgentId = "malahor",
): string {
  const destination = malahorAgentPath(paths, agentId);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
  return destination;
}

function writeFrontmatter(agentId: MalahorAgentId, lines: string[]): string {
  const file = path.join(tempDir(), `${agentId}.md`);
  fs.writeFileSync(file, `---\n${lines.join("\n")}\n---\n`, "utf8");
  return file;
}

describe("agentes malahor gestionados", () => {
  test("assets V1/V2 de los tres agentes existen y declaran el contrato esperado", () => {
    expect(MALAHOR_AGENT_IDS).toEqual(["malahor", "malahor-diagnostico", "malahor-testing"]);

    for (const agentId of MALAHOR_AGENT_IDS) {
      for (const host of ["v1", "v2"] as const) {
        const asset = assetPath(host, agentId);
        expect(fs.existsSync(asset)).toBe(true);
        expect(agentContractProblems(asset, agentId)).toEqual([]);
        expect(readAgentContract(asset)).toEqual(EXPECTED_CONTRACTS[agentId]);
      }
    }
  });

  test("asset path resuelve los tres agentes, V1/V2 y host desconocido", () => {
    expect(malahorAgentAssetPath(ASSETS_DIR, "v2")).toBe(V2_ASSET);
    expect(malahorAgentAssetPath(ASSETS_DIR, "v1")).toBe(V1_ASSET);
    expect(malahorAgentAssetPath(ASSETS_DIR, "v2", "malahor-diagnostico"))
      .toBe(assetPath("v2", "malahor-diagnostico"));
    expect(malahorAgentAssetPath(ASSETS_DIR, "v2", "malahor-testing"))
      .toBe(assetPath("v2", "malahor-testing"));
    expect(malahorAgentAssetPath(ASSETS_DIR, "unknown", "malahor-testing")).toBeNull();
    expect(malahorAgentPath(pathsFor(tempDir()), "malahor-testing")).toContain("malahor-testing.md");
  });

  test("instala V2 los tres agentes con contrato y permisos esperados", () => {
    const paths = pathsFor(tempDir());
    const results = syncManagedAgents(ASSETS_DIR, paths, "v2", false);

    expect(results.map((result) => result.agent)).toEqual([...MALAHOR_AGENT_IDS]);
    expect(results.every((result) => result.action === "created")).toBe(true);

    const primary = fs.readFileSync(malahorAgentPath(paths), "utf8");
    expect(primary).toContain(MALAHOR_AGENT_MARKER);
    expect(primary).toContain("mode: primary");
    expect(primary).toContain('resource: "malahor-*"');
    expect(primary).not.toContain("permission:\n  task:");

    const diagnostic = fs.readFileSync(malahorAgentPath(paths, "malahor-diagnostico"), "utf8");
    expect(diagnostic).toContain("mode: subagent");
    expect(diagnostic).toContain("- action: edit");
    expect(diagnostic).toContain('resource: "bun run typecheck*"');
    expect(diagnostic).not.toContain('resource: "malahor-*"');

    const testing = fs.readFileSync(malahorAgentPath(paths, "malahor-testing"), "utf8");
    expect(testing).toContain("mode: subagent");
    expect(testing).toContain('resource: "**/*.test.*"');
    expect(testing).toContain('resource: "**/__tests__/**"');
    expect(testing).toContain('resource: "**/tests/**"');
    expect(testing).toContain('resource: "bun test*"');
    expect(testing).not.toContain('resource: "malahor-*"');

    for (const agentId of MALAHOR_AGENT_IDS) {
      expect(agentContractProblems(malahorAgentPath(paths, agentId), agentId)).toEqual([]);
    }
  });

  test("instala V1 los tres agentes con task, edit y shell acotados", () => {
    const paths = pathsFor(tempDir());
    const results = syncManagedAgents(ASSETS_DIR, paths, "v1", false);

    expect(results.every((result) => result.action === "created")).toBe(true);

    const primary = fs.readFileSync(malahorAgentPath(paths), "utf8");
    expect(primary).toContain("permission:\n  task:");
    expect(primary).toContain('"malahor-*": allow');

    const diagnostic = fs.readFileSync(malahorAgentPath(paths, "malahor-diagnostico"), "utf8");
    expect(diagnostic).toContain("edit: deny");
    expect(diagnostic).toContain("bash:");
    expect(diagnostic).toContain('"bun run typecheck*": allow');
    expect(diagnostic).toContain("question: deny");
    expect(diagnostic).not.toContain("shell:");
    expect(diagnostic).not.toContain('"malahor-*"');

    const testing = fs.readFileSync(malahorAgentPath(paths, "malahor-testing"), "utf8");
    expect(testing).toContain("bash:");
    expect(testing).toContain('"**/*.test.*": allow');
    expect(testing).toContain('"**/tests/**": allow');
    expect(testing).toContain('"bun test*": allow');
    expect(testing).toContain("question: deny");
    expect(testing).not.toContain("shell:");
    expect(testing).not.toContain('"malahor-*"');

    for (const agentId of MALAHOR_AGENT_IDS) {
      expect(agentContractProblems(malahorAgentPath(paths, agentId), agentId)).toEqual([]);
    }
  });

  test("host desconocido no adivina formato ni crea archivos", () => {
    const paths = pathsFor(tempDir());
    const results = syncManagedAgents(ASSETS_DIR, paths, "unknown", false);

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.action === "skipped-unknown-host")).toBe(true);
    for (const agentId of MALAHOR_AGENT_IDS) {
      expect(fs.existsSync(malahorAgentPath(paths, agentId))).toBe(false);
    }
  });

  test("segunda ejecucion sin cambios es idempotente para los tres", () => {
    const paths = pathsFor(tempDir());
    syncManagedAgents(ASSETS_DIR, paths, "v2", false);
    const results = syncManagedAgents(ASSETS_DIR, paths, "v2", false);

    expect(results.every((result) => result.action === "unchanged")).toBe(true);
    expect(results.every((result) => result.backup === null)).toBe(true);
  });

  test("refresca un agente gestionado y deja backup", () => {
    const paths = pathsFor(tempDir());
    const destination = malahorAgentPath(paths, "malahor-testing");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, "---\n# malahor-managed\nmode: subagent\n---\nviejo\n", "utf8");

    const results = syncManagedAgents(ASSETS_DIR, paths, "v2", false);
    const testing = results.find((result) => result.agent === "malahor-testing");

    expect(testing?.action).toBe("refreshed");
    expect(testing?.backup?.created).toBe(true);
    expect(testing?.backup?.destination).not.toBeNull();
    expect(fs.existsSync(testing!.backup!.destination!)).toBe(true);
    expect(fs.readFileSync(destination, "utf8")).toBe(fs.readFileSync(assetPath("v2", "malahor-testing"), "utf8"));
  });

  test("no sobrescribe agentes propios, incluido un especialista con ID reservado", () => {
    const paths = pathsFor(tempDir());
    const ownPrimary = "---\ndescription: mio\n---\n";
    const ownTesting = "---\ndescription: mi testing\n---\n";
    const primaryPath = writeForeign(paths, ownPrimary, "malahor");
    const testingPath = writeForeign(paths, ownTesting, "malahor-testing");

    const results = syncManagedAgents(ASSETS_DIR, paths, "v2", false);

    expect(results.find((result) => result.agent === "malahor")?.action).toBe("kept-foreign");
    expect(results.find((result) => result.agent === "malahor-testing")?.action).toBe("kept-foreign");
    expect(results.find((result) => result.agent === "malahor-diagnostico")?.action).toBe("created");
    expect(fs.readFileSync(primaryPath, "utf8")).toBe(ownPrimary);
    expect(fs.readFileSync(testingPath, "utf8")).toBe(ownTesting);
  });

  test("dry-run no escribe ningun agente", () => {
    const paths = pathsFor(tempDir());
    const results = syncManagedAgents(ASSETS_DIR, paths, "v2", true);

    expect(results.every((result) => result.action === "created")).toBe(true);
    expect(results.every((result) => result.backup === null)).toBe(true);
    for (const agentId of MALAHOR_AGENT_IDS) {
      expect(fs.existsSync(malahorAgentPath(paths, agentId))).toBe(false);
    }
  });

  test("estado missing/foreign/managed por agente", () => {
    const paths = pathsFor(tempDir());
    const destination = malahorAgentPath(paths, "malahor-diagnostico");

    expect(agentState(destination)).toBe("missing");
    writeForeign(paths, undefined, "malahor-diagnostico");
    expect(agentState(destination)).toBe("foreign");
    fs.unlinkSync(destination);
    syncManagedAgent(ASSETS_DIR, paths, "v2", false, "malahor-diagnostico");
    expect(agentState(destination)).toBe("managed");
  });

  test("remove retira los tres gestionados y deja backup de cada uno", () => {
    const paths = pathsFor(tempDir());
    syncManagedAgents(ASSETS_DIR, paths, "v2", false);
    const results = removeManagedAgents(paths, false);

    expect(results.map((result) => result.agent)).toEqual([...MALAHOR_AGENT_IDS]);
    expect(results.every((result) => result.removed)).toBe(true);
    expect(results.every((result) => result.backup?.created === true)).toBe(true);

    for (const result of results) {
      expect(result.backup?.destination).not.toBeNull();
      expect(fs.existsSync(result.backup!.destination!)).toBe(true);
      expect(fs.existsSync(result.destination)).toBe(false);
    }
  });

  test("remove respeta agentes propios y retira solo los gestionados", () => {
    const paths = pathsFor(tempDir());
    const ownPath = writeForeign(paths, undefined, "malahor-testing");
    syncManagedAgents(ASSETS_DIR, paths, "v2", false);

    const results = removeManagedAgents(paths, false);
    const testing = results.find((result) => result.agent === "malahor-testing");

    expect(testing?.removed).toBe(false);
    expect(testing?.state).toBe("foreign");
    expect(fs.existsSync(ownPath)).toBe(true);
    expect(results.filter((result) => result.removed)).toHaveLength(2);
  });

  test("remove dry-run informa pero conserva los archivos", () => {
    const paths = pathsFor(tempDir());
    syncManagedAgents(ASSETS_DIR, paths, "v2", false);
    const results = removeManagedAgents(paths, true);

    expect(results.every((result) => result.removed)).toBe(true);
    for (const result of results) {
      expect(result.backup?.destination).not.toBeNull();
      expect(fs.existsSync(result.backup!.destination!)).toBe(false);
      expect(fs.existsSync(result.destination)).toBe(true);
    }
  });

  test("syncManagedAgents falla antes de escribir si falta un asset", () => {
    const root = tempDir();
    const partialAssets = path.join(root, "assets");
    const partialPrimary = path.join(partialAssets, "opencode", "agents", "v2", MALAHOR_AGENT_FILE);
    fs.mkdirSync(path.dirname(partialPrimary), { recursive: true });
    fs.copyFileSync(assetPath("v2", "malahor"), partialPrimary);

    const paths = pathsFor(path.join(root, "home"));

    expect(() => assertAgentAssets(partialAssets, "v2")).toThrow();
    expect(() => syncManagedAgents(partialAssets, paths, "v2", false)).toThrow();
    for (const agentId of MALAHOR_AGENT_IDS) {
      expect(fs.existsSync(malahorAgentPath(paths, agentId))).toBe(false);
    }
  });

  test("agentContractProblems detecta especialistas sobreextendidos o incompletos", () => {
    const diagnostic = writeFrontmatter("malahor-diagnostico", [
      "mode: subagent",
      "permissions:",
      "  - action: edit",
      '    resource: "*"',
      "    effect: allow",
      "  - action: shell",
      '    resource: "*"',
      "    effect: deny",
      "  - action: shell",
      '    resource: "bun run typecheck*"',
      "    effect: allow",
      "  - action: subagent",
      '    resource: "*"',
      "    effect: deny",
      "  - action: question",
      '    resource: "*"',
      "    effect: deny",
    ]);
    const diagnosticProblems = agentContractProblems(diagnostic, "malahor-diagnostico");
    expect(diagnosticProblems).toContain("falta deny de edit");
    expect(diagnosticProblems).toContain("diagnostico no debe permitir edit");

    const testing = writeFrontmatter("malahor-testing", [
      "mode: subagent",
      "permissions:",
      "  - action: edit",
      '    resource: "*"',
      "    effect: deny",
      "  - action: edit",
      '    resource: "**/*.test.*"',
      "    effect: allow",
      "  - action: shell",
      '    resource: "*"',
      "    effect: deny",
      "  - action: shell",
      '    resource: "bun test*"',
      "    effect: allow",
      "  - action: subagent",
      '    resource: "*"',
      "    effect: deny",
      "  - action: question",
      '    resource: "*"',
      "    effect: deny",
    ]);
    const testingProblems = agentContractProblems(testing, "malahor-testing");
    expect(testingProblems).toContain("falta allow de edit para **/__tests__/**");
    expect(testingProblems).toContain("falta allow de edit para **/tests/**");
    expect(testingProblems).not.toContain("falta deny de edit");

    const overprivileged = writeFrontmatter("malahor-diagnostico", [
      "mode: primary",
      "permissions:",
      "  - action: subagent",
      '    resource: "*"',
      "    effect: deny",
      "  - action: subagent",
      '    resource: "malahor-*"',
      "    effect: allow",
      "  - action: question",
      '    resource: "*"',
      "    effect: allow",
      "  - action: edit",
      '    resource: "*"',
      "    effect: deny",
      "  - action: shell",
      '    resource: "*"',
      "    effect: deny",
    ]);
    const overprivilegedProblems = agentContractProblems(overprivileged, "malahor-diagnostico");
    expect(overprivilegedProblems).toContain("mode no es subagent");
    expect(overprivilegedProblems).toContain("especialista no debe permitir malahor-*");
    expect(overprivilegedProblems).toContain("especialista no debe permitir question");
  });

  test("validateInstallation exige los tres agentes y rechaza un especialista foreign", () => {
    const paths = validationPathsFor(tempDir());
    fs.mkdirSync(paths.malahorHome, { recursive: true });
    fs.mkdirSync(path.dirname(paths.mnemoIndex), { recursive: true });
    fs.writeFileSync(paths.mnemoIndex, "", "utf8");
    fs.mkdirSync(paths.assetsDir, { recursive: true });
    fs.mkdirSync(path.dirname(paths.agentsMd), { recursive: true });
    fs.writeFileSync(paths.agentsMd, "", "utf8");
    fs.writeFileSync(paths.opencodeConfig, "{}\n", "utf8");
    const commandsDir = path.join(paths.opencodeDir, "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    for (const file of MALAHOR_COMMAND_FILES) {
      fs.writeFileSync(path.join(commandsDir, file), "", "utf8");
    }

    syncManagedAgents(ASSETS_DIR, paths, "v2", false);

    const testingPath = malahorAgentPath(paths, "malahor-testing");
    fs.writeFileSync(testingPath, "---\ndescription: mi testing\n---\n", "utf8");
    const foreignProblems = validateInstallation(paths, null, {
      agentHost: "v2",
      mcpManagedByPlugin: true,
      configManagedByPlugin: true,
    });
    expect(foreignProblems.some((problem) => problem.includes("malahor-testing") && problem.includes("no esta gestionado"))).toBe(true);

    fs.unlinkSync(malahorAgentPath(paths, "malahor-diagnostico"));
    const missingProblems = validateInstallation(paths, null, {
      agentHost: "v2",
      mcpManagedByPlugin: true,
      configManagedByPlugin: true,
    });
    expect(missingProblems.some((problem) => problem.includes("malahor-diagnostico") && problem.includes("falta"))).toBe(true);
  });

  test("describeAgentSync/Removal usan el nombre del agente", () => {
    const paths = pathsFor(tempDir());
    const created = syncManagedAgent(ASSETS_DIR, paths, "v2", false, "malahor-testing");

    expect(describeAgentSync(created, false)).toContain("Subagente malahor-testing");
    expect(describeAgentSync(created, false)).toContain("installed");
    expect(describeAgentSync(created, true)).toContain("would install");

    const foreignPath = writeForeign(pathsFor(tempDir()), undefined, "malahor-diagnostico");
    expect(describeAgentSync(
      {
        agent: "malahor-diagnostico",
        action: "kept-foreign",
        host: "v2",
        source: assetPath("v2", "malahor-diagnostico"),
        destination: foreignPath,
        backup: null,
      },
      false,
    )).toContain("no se toca");

    const removal = removeManagedAgent(paths, false, "malahor-testing");
    expect(describeAgentRemoval(removal, false)).toContain("Subagente malahor-testing");
    expect(describeAgentRemoval(removal, false)).toContain("removed");
    expect(describeAgentRemoval(removal, true)).toContain("would remove");
  });
});
