import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MemoryEngine } from "../../src/mnemo/engine";
import { callTool } from "../../src/mnemo/tools";
import { runContext } from "../../src/cli/commands/context";
import { runMemory } from "../../src/cli/commands/memory";
import { getObservation, saveDb } from "../../src/mnemo/db";
import { backupMemory } from "../../src/mnemo/admin-backup";
import { contextForProject } from "../../src/mnemo/context";

const [action, root] = process.argv.slice(2);
assert.ok(["exercise", "append", "read"].includes(action));
assert.ok(root && path.basename(root).startsWith("malahor-memory-engine-"));
assert.equal(process.env.MALAHOR_HOME, root);
const file = path.join(root, "memory", "db.sqlite");
const legacy = path.join(root, "mnemo", "db.json");
const hash = () => createHash("sha256").update(fs.readFileSync(legacy)).digest("hex");
const item = { project: "acme/hu-1", type: "general" as const, title: "Decisión SQLite", content: "Transaccion", tags: "runtime" };

if (action === "exercise") {
  fs.writeFileSync(process.env.MALAHOR_CONFIG!, "{}", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ acme: { context: "mnemo", roots: [root], defaultRoot: root } }), { mode: 0o600 });
  saveDb({ observations: [], sessions: [], nextId: 99 });
  const legacyHash = hash();
  const engine = MemoryEngine.open(file, { access: "create" });
  const first = engine.save(item);
  engine.pin(first.id); engine.sessionSummary("acme", "Engine session");
  engine.integrity(); engine.close();
  fs.writeFileSync(path.join(root, "memory", "active.json"), JSON.stringify({ version: 1, backend: "sqlite", schemaVersion: 1 }), { mode: 0o600 });
  const second = callTool({ name: "mem_save", arguments: item }) as { id: number };
  assert.equal(second.id, 2); assert.equal(getObservation(2)?.title, item.title);
  assert.equal((callTool({ name: "mem_tree", arguments: { prefix: "acme" } }) as Array<unknown>).length, 2);
  callTool({ name: "mem_pin", arguments: { id: 2 } });
  const pinned = callTool({ name: "mem_context", arguments: { project: "acme", rollup: true, limit: 1 } }) as { observations: Array<{ id: number }> };
  assert.equal(pinned.observations[0]?.id, 2);
  const promote = callTool({ name: "mem_promote_preview", arguments: { id: 2, ancestor: "acme" } }) as { requiresConfirmation: string };
  callTool({ name: "mem_promote", arguments: { id: 2, ancestor: "acme", confirm: promote.requiresConfirmation } });
  assert.equal(getObservation(2)?.project, "acme");
  const contextOptions = { args: ["CLI checkpoint"], dryRun: false, project: "acme", limit: undefined };
  runContext({ ...contextOptions, action: "save" });
  runContext({ ...contextOptions, action: "recover", args: [] });
  runContext({ ...contextOptions, action: "capsule", args: [] });
  assert.equal(contextForProject("acme").latestSession?.summary, "CLI checkpoint");
  for (const action of ["list", "inspect", "backup"]) {
    runMemory({ action, args: action === "inspect" ? ["acme"] : [], all: false, yes: false, dryRun: false, confirm: undefined });
  }
  const backup = backupMemory();
  const copy = MemoryEngine.open(backup.destination!, { access: "write" });
  copy.integrity(); assert.equal(copy.snapshot().observations.length, 2); copy.close();
  assert.equal(hash(), legacyHash);
} else {
  const engine = MemoryEngine.open(file, { access: action === "append" ? "write" : "read" });
  try {
    assert.equal(engine.search({ query: "decision", match: "fts", mode: "subtree", scope: "acme" }).length, 2);
    if (action === "append") {
      assert.equal(engine.save({ ...item, title: "interopunico" }).id, 3);
      engine.integrity();
    }
    assert.equal(engine.get(3)?.title, "interopunico");
    assert.equal(engine.snapshot().nextId, 4);
  } finally { engine.close(); }
}
console.log(JSON.stringify({ task: "T-5.3.2", action, passed: true, root, runtime: { node: process.version, bun: process.versions.bun ?? null }, legacyHash: hash() }));
