import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  MALAHOR_AGENT_FILE,
  MALAHOR_AGENT_MARKER,
  agentContractProblems,
  agentState,
  describeAgentRemoval,
  describeAgentSync,
  malahorAgentAssetPath,
  malahorAgentPath,
  readAgentContract,
  removeManagedAgent,
  syncManagedAgent,
} from "../src/cli/core/opencode-agents";
import type { MalahorPaths } from "../src/cli/core/paths";

const ASSETS_DIR = path.join(process.cwd(), "assets");
const V2_ASSET = path.join(ASSETS_DIR, "opencode", "agents", "v2", MALAHOR_AGENT_FILE);
const V1_ASSET = path.join(ASSETS_DIR, "opencode", "agents", "v1", MALAHOR_AGENT_FILE);

function tempDir(): string {
  return fs.mkdtempSync(path.join("/tmp/opencode", "malahor-agents-"));
}

function pathsFor(root: string): MalahorPaths {
  return {
    opencodeDir: path.join(root, "opencode"),
    backupsDir: path.join(root, "backups"),
  } as MalahorPaths;
}

function writeForeign(paths: MalahorPaths, content = "---\ndescription: mio\n---\n"): string {
  const destination = malahorAgentPath(paths);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
  return destination;
}

describe("agente malahor gestionado", () => {
  test("assets V1/V2 existen y declaran el contrato completo", () => {
    for (const asset of [V1_ASSET, V2_ASSET]) {
      expect(fs.existsSync(asset)).toBe(true);
      expect(agentContractProblems(asset)).toEqual([]);
      expect(readAgentContract(asset)).toEqual({
        mode: "primary",
        delegationDenyAll: true,
        delegationAllowManaged: true,
        questionAllowed: true,
      });
    }
  });

  test("asset path resuelve V1, V2 y host desconocido", () => {
    expect(malahorAgentAssetPath(ASSETS_DIR, "v2")).toBe(V2_ASSET);
    expect(malahorAgentAssetPath(ASSETS_DIR, "v1")).toBe(V1_ASSET);
    expect(malahorAgentAssetPath(ASSETS_DIR, "unknown")).toBeNull();
  });

  test("instala V2 con subagent deny/allow y question allow", () => {
    const paths = pathsFor(tempDir());
    const result = syncManagedAgent(ASSETS_DIR, paths, "v2", false);

    expect(result.action).toBe("created");
    const content = fs.readFileSync(malahorAgentPath(paths), "utf8");
    expect(content).toContain(MALAHOR_AGENT_MARKER);
    expect(content).toContain("mode: primary");
    expect(content).toContain("- action: subagent");
    expect(content).toContain('resource: "*"');
    expect(content).toContain('resource: "malahor-*"');
    expect(content).toContain("effect: deny");
    expect(content).toContain("effect: allow");
    expect(content).toContain("- action: question");
    expect(content).not.toContain("permission:\n  task:");
  });

  test("instala V1 con permission.task deny/allow y question allow", () => {
    const paths = pathsFor(tempDir());
    const result = syncManagedAgent(ASSETS_DIR, paths, "v1", false);

    expect(result.action).toBe("created");
    const content = fs.readFileSync(malahorAgentPath(paths), "utf8");
    expect(content).toContain("mode: primary");
    expect(content).toContain("permission:\n  task:");
    expect(content).toContain('"*": deny');
    expect(content).toContain('"malahor-*": allow');
    expect(content).toContain("question: allow");
    expect(content).not.toContain("- action: subagent");
  });

  test("host desconocido no adivina formato ni crea archivo", () => {
    const paths = pathsFor(tempDir());
    const result = syncManagedAgent(ASSETS_DIR, paths, "unknown", false);

    expect(result.action).toBe("skipped-unknown-host");
    expect(result.source).toBeNull();
    expect(fs.existsSync(malahorAgentPath(paths))).toBe(false);
  });

  test("segunda ejecucion sin cambios es idempotente", () => {
    const paths = pathsFor(tempDir());
    syncManagedAgent(ASSETS_DIR, paths, "v2", false);
    const result = syncManagedAgent(ASSETS_DIR, paths, "v2", false);

    expect(result.action).toBe("unchanged");
    expect(result.backup).toBeNull();
  });

  test("refresca un archivo gestionado y deja backup", () => {
    const paths = pathsFor(tempDir());
    const destination = malahorAgentPath(paths);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, "---\n# malahor-managed\nmode: primary\n---\nviejo\n", "utf8");

    const result = syncManagedAgent(ASSETS_DIR, paths, "v2", false);

    expect(result.action).toBe("refreshed");
    expect(result.backup?.created).toBe(true);
    expect(result.backup?.destination).not.toBeNull();
    expect(fs.existsSync(result.backup!.destination!)).toBe(true);
    expect(fs.readFileSync(destination, "utf8")).toBe(fs.readFileSync(V2_ASSET, "utf8"));
  });

  test("no sobrescribe un agente propio", () => {
    const paths = pathsFor(tempDir());
    const ownContent = "---\ndescription: mio\n---\n";
    const destination = writeForeign(paths, ownContent);
    const result = syncManagedAgent(ASSETS_DIR, paths, "v2", false);

    expect(result.action).toBe("kept-foreign");
    expect(fs.readFileSync(destination, "utf8")).toBe(ownContent);
  });

  test("dry-run no escribe el archivo", () => {
    const paths = pathsFor(tempDir());
    const result = syncManagedAgent(ASSETS_DIR, paths, "v2", true);

    expect(result.action).toBe("created");
    expect(result.backup).toBeNull();
    expect(fs.existsSync(malahorAgentPath(paths))).toBe(false);
  });

  test("estado missing/foreign/managed", () => {
    const paths = pathsFor(tempDir());
    const destination = malahorAgentPath(paths);

    expect(agentState(destination)).toBe("missing");
    writeForeign(paths);
    expect(agentState(destination)).toBe("foreign");
    fs.unlinkSync(destination);
    syncManagedAgent(ASSETS_DIR, paths, "v2", false);
    expect(agentState(destination)).toBe("managed");
  });

  test("remove retira solo lo gestionado y deja backup", () => {
    const paths = pathsFor(tempDir());
    syncManagedAgent(ASSETS_DIR, paths, "v2", false);
    const result = removeManagedAgent(paths, false);

    expect(result.removed).toBe(true);
    expect(result.state).toBe("managed");
    expect(result.backup?.created).toBe(true);
    expect(result.backup?.destination).not.toBeNull();
    expect(fs.existsSync(result.backup!.destination!)).toBe(true);
    expect(fs.existsSync(malahorAgentPath(paths))).toBe(false);
  });

  test("remove respeta un agente propio", () => {
    const paths = pathsFor(tempDir());
    const destination = writeForeign(paths);
    const result = removeManagedAgent(paths, false);

    expect(result.removed).toBe(false);
    expect(result.state).toBe("foreign");
    expect(fs.existsSync(destination)).toBe(true);
  });

  test("remove dry-run informa pero conserva el archivo", () => {
    const paths = pathsFor(tempDir());
    syncManagedAgent(ASSETS_DIR, paths, "v2", false);
    const result = removeManagedAgent(paths, true);

    expect(result.removed).toBe(true);
    expect(result.backup?.destination).not.toBeNull();
    expect(fs.existsSync(result.backup!.destination!)).toBe(false);
    expect(fs.existsSync(malahorAgentPath(paths))).toBe(true);
  });

  test("describeAgentSync/Removal reflejan el estado sin ambiguedad", () => {
    const paths = pathsFor(tempDir());
    const created = syncManagedAgent(ASSETS_DIR, paths, "v2", false);
    expect(describeAgentSync(created, false)).toContain("installed");
    expect(describeAgentSync(created, true)).toContain("would install");

    const foreign = writeForeign(pathsFor(tempDir()));
    expect(describeAgentSync(
      { action: "kept-foreign", host: "v2", source: V2_ASSET, destination: foreign, backup: null },
      false,
    )).toContain("no se toca");

    const removal = removeManagedAgent(paths, false);
    expect(describeAgentRemoval(removal, false)).toContain("removed");
    expect(describeAgentRemoval(removal, true)).toContain("would remove");
  });
});
