import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runContext } from "../../src/cli/commands/context";
import { runMemory } from "../../src/cli/commands/memory";
import { contextForProject } from "../../src/mnemo/context";
import { getObservation, saveObservation } from "../../src/mnemo/db";
import { applyMemoryMigration, previewMemoryMigration } from "../../src/mnemo/migration";
import { readMigrationManifest } from "../../src/mnemo/migration/manifest";
import { memoryLocation, memoryV2Paths } from "../../src/mnemo/storage";
import { callTool } from "../../src/mnemo/tools";

const [action, root] = process.argv.slice(2);
assert.ok(["migrate", "append", "read"].includes(action));
assert.ok(root && path.basename(root).startsWith("malahor-memory-engine-"));
assert.equal(process.env.MALAHOR_HOME, root);

const source = path.join(root, "mnemo", "db.json");
const paths = memoryV2Paths(source);
const sourceHash = () => createHash("sha256").update(fs.readFileSync(source)).digest("hex");
const originalHash = sourceHash();

if (action === "migrate") {
  runMemory({ action: "migrate", args: [], all: false, confirm: undefined, dryRun: true, yes: false });
  const preview = previewMemoryMigration({ source });
  assert.equal(preview.state, "ready");
  assert.ok(preview.confirmation);
  runMemory({ action: "migrate", args: [], all: false, confirm: preview.confirmation,
    dryRun: false, yes: true, apply: true });
  assert.equal(memoryLocation(source).backend, "sqlite");
  assert.equal(getObservation(9)?.project, "acme/store");
  assert.equal(readMigrationManifest(paths.manifest)?.manifest.state, "verified");
  assert.equal(sourceHash(), originalHash);
} else if (action === "append") {
  assert.equal(memoryLocation(source).backend, "sqlite");
  const direct = saveObservation({ project: "acme/store", type: "learning", title: "runtimeunique direct",
    content: "Node Bun migration interop", tags: "runtime" });
  assert.equal(direct.id, 40);
  const mcp = callTool({ name: "mem_save", arguments: { project: "acme/store", type: "general",
    title: "runtimeunique mcp", content: "MCP after cutover", tags: "runtime" } }) as { id: number };
  assert.equal(mcp.id, 41);
  runContext({ action: "save", args: ["Runtime checkpoint"], dryRun: false, project: "acme", limit: undefined });
  runContext({ action: "recover", args: [], dryRun: false, project: "acme", limit: "8" });
  runContext({ action: "capsule", args: [], dryRun: false, project: "acme", limit: "8" });
  runMemory({ action: "list", args: [], all: false, confirm: undefined, dryRun: false, yes: false });
  runMemory({ action: "inspect", args: ["acme/store"], all: false, confirm: undefined, dryRun: false, yes: false });
  assert.equal(sourceHash(), originalHash);
} else {
  assert.equal(getObservation(40)?.title, "runtimeunique direct");
  assert.equal(getObservation(41)?.title, "runtimeunique mcp");
  const search = callTool({ name: "mem_search", arguments: { query: "runtimeunique", project: "acme/store" } }) as Array<{ id: number }>;
  assert.deepEqual(search.map((item) => item.id).sort((left, right) => left - right), [40, 41]);
  const context = contextForProject("acme/store", 20);
  assert.equal(context.latestSession?.summary, "Legacy checkpoint");
  assert.equal(contextForProject("acme", 20).latestSession?.summary, "Runtime checkpoint");
  assert.equal(context.observations.some((item) => item.id === 40), true);
  assert.equal(context.observations.some((item) => item.id === 41), true);
  assert.equal(previewMemoryMigration({ source }).state, "active");
  assert.equal(sourceHash(), originalHash);
}

const snapshot = callTool({ name: "mem_context", arguments: { project: "acme/store", limit: 20 } }) as {
  observations: Array<{ id: number }>;
  latestSession: { summary: string } | null;
};
console.log(JSON.stringify({
  task: "T-5.3.4",
  action,
  passed: true,
  runtime: { node: process.version, bun: process.versions.bun ?? null },
  sourceHash: originalHash,
  observations: snapshot.observations.length,
  latestSession: snapshot.latestSession?.summary ?? null,
  rootLatestSession: contextForProject("acme", 20).latestSession?.summary ?? null,
  backups: fs.readdirSync(path.join(root, "backups")).length,
}));
