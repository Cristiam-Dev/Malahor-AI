import fs from "node:fs";
import path from "node:path";
import { MemoryEngine } from "../src/mnemo/engine";
import { MemoryStore } from "../src/mnemo/engine/store";
import { ensureScope } from "../src/mnemo/engine/observations";
import type { MnemoDb } from "../src/mnemo/db";
import { fixtureDb } from "./mnemo-fixture";

export function memorySandbox(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-memory-engine-"));
  return { root, file: path.join(root, "memory", "db.sqlite") };
}

export function seedEngine(file: string, db: MnemoDb = fixtureDb()): MemoryEngine {
  const store = MemoryStore.open(file, "create");
  try {
    store.transaction(() => {
      for (const [position, item] of db.observations.entries()) {
        ensureScope(store, item.project);
        store.run("INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [item.id, item.project, item.type, item.title, item.content, item.tags, item.created_at, position]);
      }
      for (const [position, item] of db.sessions.entries()) {
        ensureScope(store, item.project);
        store.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)", [`synthetic:${position}`, item.project, item.summary, item.created_at, position]);
      }
      store.run("UPDATE memory_state SET next_observation_id = ?, next_observation_position = ?, next_session_position = ?",
        [db.nextId, db.observations.length, db.sessions.length]);
    });
  } finally { store.close(); }
  return MemoryEngine.open(file, { access: "write" });
}

export function syntheticMarker(root: string): void {
  fs.writeFileSync(path.join(root, "memory", "active.json"), JSON.stringify({ version: 1, backend: "sqlite", schemaVersion: 1 }), { mode: 0o600 });
}
