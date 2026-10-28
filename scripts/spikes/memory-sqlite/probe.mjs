import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const date = "2026-10-27 12:00:00";
const baseline = [
  [7, "acme/hu-1", "decision", "Decisión SQLite", "Escritura transaccional", "persistencia,fts", date, 0],
  [21, "acme/hu-1/frontend", "learning", "Interfaz", "Consulta cupones", "testing", date, 1],
  [25, "acme/hu-10", "general", "SQLite vecino", "No pertenece a hu-1", "", date, 2],
  [31, "other/hu-1", "general", "SQLite externo", "Otro proyecto", "", date, 3],
];
const insertSql = "INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

export async function loadDriver(driver) {
  const modules = { node: "node:sqlite", bun: "bun:sqlite", better: "better-sqlite3" };
  if (!Object.hasOwn(modules, driver)) throw new Error(`Driver desconocido: ${driver}`);
  // Bun 1.2 resuelve imports literales de node:sqlite incluso en una rama no ejecutada.
  const sqlite = await import(modules[driver]);
  if (driver === "node") {
    const { DatabaseSync } = sqlite;
    return (file, readOnly = false) => new DatabaseSync(file, { readOnly, allowExtension: false });
  }
  if (driver === "bun") {
    const { Database } = sqlite;
    return (file, readOnly = false) => new Database(file, { readonly: readOnly, strict: true, create: !readOnly });
  }
  if (driver === "better") {
    const { default: Database } = sqlite;
    return (file, readOnly = false) => new Database(file, { readonly: readOnly, fileMustExist: true });
  }
  throw new Error(`Driver desconocido: ${driver}`);
}

function configure(db) {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA trusted_schema = OFF;");
}

function createPrivateFile(file) {
  fs.closeSync(fs.openSync(file, "wx", 0o600));
}

function searchIds(db, query) {
  return db.prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH ? ORDER BY rowid")
    .all(query).map((row) => row.rowid);
}

function snapshot(db) {
  return {
    scopes: db.prepare("SELECT * FROM scopes ORDER BY path").all(),
    observations: db.prepare("SELECT * FROM observations ORDER BY position").all(),
    sessions: db.prepare("SELECT * FROM sessions ORDER BY position").all(),
    pins: db.prepare("SELECT * FROM pins ORDER BY observation_id").all(),
    relations: db.prepare("SELECT * FROM relations ORDER BY source_id, target_id, kind").all(),
    state: db.prepare("SELECT * FROM memory_state").get(),
  };
}

function integrity(db) {
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.exec("INSERT INTO observations_fts(observations_fts, rank) VALUES ('integrity-check', 1)");
}

export function probe(open, directory, schema = fs.readFileSync(new URL("schema.sql", import.meta.url), "utf8")) {
  const file = path.join(directory, "memory.sqlite");
  createPrivateFile(file);
  const db = open(file);
  const checks = [];
  const check = (name, run) => { run(); checks.push(name); };
  let peer;
  try {
    configure(db);
    assert.equal(db.prepare("PRAGMA journal_mode = WAL").get().journal_mode, "wal");
    db.exec("PRAGMA synchronous = FULL");
    db.exec(schema);
    const sqlite = db.prepare("SELECT sqlite_version() AS version").get().version;
    check("schema-and-fts5", () => {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
      assert.equal(db.prepare("PRAGMA application_id").get().application_id, 0x4D414C32);
      assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 2);
      assert.equal(db.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
    });
    db.exec(`
      INSERT INTO scopes VALUES ('acme', NULL, 0), ('other', NULL, 0);
      INSERT INTO scopes VALUES ('acme/hu-1', 'acme', 1), ('acme/hu-10', 'acme', 1), ('other/hu-1', 'other', 1);
      INSERT INTO scopes VALUES ('acme/hu-1/frontend', 'acme/hu-1', 2);
    `);
    const insert = db.prepare(insertSql);
    for (const row of baseline) insert.run(...row);
    check("legacy-fields-order-and-id-gaps", () => {
      const rows = db.prepare("SELECT * FROM observations ORDER BY position").all();
      assert.deepEqual(rows.map(Object.values), baseline);
    });
    check("fts-title-content-tags-and-accents", () => {
      assert.deepEqual(searchIds(db, "decision"), [7]);
      assert.deepEqual(searchIds(db, "transaccional"), [7]);
      assert.deepEqual(searchIds(db, "testing"), [21]);
      assert.deepEqual(searchIds(db, '"Decisión SQLite"'), [7]);
      assert.equal(typeof db.prepare("SELECT bm25(observations_fts) AS score FROM observations_fts WHERE observations_fts MATCH ?").get("sqlite").score, "number");
    });
    check("exact-subtree-and-neighbor-boundaries", () => {
      assert.deepEqual(db.prepare("SELECT id FROM observations WHERE scope_path = ? ORDER BY position").all("acme/hu-1").map((r) => r.id), [7]);
      const ids = db.prepare(`SELECT o.id FROM observations o JOIN observations_fts f ON f.rowid = o.id
        WHERE observations_fts MATCH ? AND (o.scope_path = ? OR (o.scope_path >= ? AND o.scope_path < ?))
        ORDER BY o.position`).all("sqlite OR testing", "acme/hu-1", "acme/hu-1/", "acme/hu-10").map((r) => r.id);
      assert.deepEqual(ids, [7, 21]);
    });
    check("global-and-parent-chain", () => {
      const rows = db.prepare(`WITH RECURSIVE chain(path, parent_path) AS (
        SELECT path, parent_path FROM scopes WHERE path = ?
        UNION ALL SELECT s.path, s.parent_path FROM scopes s JOIN chain c ON s.path = c.parent_path
      ) SELECT path FROM chain UNION SELECT path FROM scopes WHERE path = 'global' ORDER BY path`).all("acme/hu-1/frontend");
      assert.deepEqual(rows.map((r) => r.path), ["acme", "acme/hu-1", "acme/hu-1/frontend", "global"]);
    });
    check("scope-and-foreign-key-constraints", () => {
      assert.throws(() => db.exec("INSERT INTO scopes VALUES ('acme/invalid', 'other', 1)"));
      assert.throws(() => db.exec("INSERT INTO scopes VALUES ('acme/depth', 'acme', 4)"));
      assert.throws(() => db.exec("INSERT INTO scopes VALUES ('acme//empty', 'acme', 1)"));
      assert.throws(() => db.exec("UPDATE scopes SET path = 'renamed' WHERE path = 'acme'"));
      assert.throws(() => db.exec("DELETE FROM scopes WHERE path = 'acme/hu-1'"));
      assert.throws(() => insert.run(50, "missing", "general", "", "", "", date, 5));
      assert.throws(() => insert.run(...baseline[0]));
      assert.throws(() => insert.run(9007199254740992n, "acme", "general", "", "", "", date, 5));
      assert.throws(() => insert.run(50, "acme", "invalid", "", "", "", date, 5));
      assert.throws(() => insert.run(50));
    });
    check("fts-update-and-delete-triggers", () => {
      db.prepare("UPDATE observations SET content = ? WHERE id = ?").run("Consulta descuentos", 21);
      assert.deepEqual(searchIds(db, "cupones"), []);
      assert.deepEqual(searchIds(db, "descuentos"), [21]);
      insert.run(50, "acme", "general", "eliminable", "", "", date, 5);
      assert.deepEqual(searchIds(db, "eliminable"), [50]);
      db.prepare("DELETE FROM observations WHERE id = ?").run(50);
      assert.deepEqual(searchIds(db, "eliminable"), []);
    });
    check("transaction-rolls-back-data-and-fts", () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE observations SET title = ? WHERE id = ?").run("rollbackword", 7);
        insert.run(50, "acme", "general", "rollbackword", "", "", date, 5);
        assert.deepEqual(searchIds(db, "rollbackword"), [7, 50]);
        assert.throws(() => insert.run(...baseline[0]));
      } finally {
        db.exec("ROLLBACK");
      }
      assert.deepEqual(searchIds(db, "rollbackword"), []);
      assert.deepEqual(searchIds(db, "decision"), [7]);
      assert.equal(db.prepare("SELECT count(*) AS total FROM observations").get().total, 4);
    });
    check("sessions-preserve-duplicates-and-order", () => {
      const add = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)");
      add.run("snapshot:0", "acme", "Resumen repetido", date, 0);
      add.run("snapshot:1", "acme", "Resumen repetido", date, 1);
      assert.equal(db.prepare("SELECT count(*) AS total FROM sessions").get().total, 2);
      assert.deepEqual(db.prepare("SELECT id FROM sessions ORDER BY position").all().map((r) => r.id), ["snapshot:0", "snapshot:1"]);
    });
    check("pins-relations-and-cascade", () => {
      db.prepare("INSERT INTO pins VALUES (?, ?)").run(7, date);
      db.prepare("INSERT INTO relations VALUES (?, ?, ?, ?)").run(7, 21, "supersedes", date);
      assert.throws(() => db.prepare("INSERT INTO pins VALUES (?, ?)").run(999, date));
      assert.throws(() => db.prepare("INSERT INTO relations VALUES (?, ?, ?, ?)").run(7, 7, "conflicts", date));
      assert.throws(() => db.prepare("INSERT INTO relations VALUES (?, ?, ?, ?)").run(7, 21, "invalid", date));
      insert.run(50, "acme", "general", "temporal", "", "", date, 5);
      db.prepare("INSERT INTO pins VALUES (?, ?)").run(50, date);
      db.prepare("INSERT INTO relations VALUES (?, ?, ?, ?)").run(50, 7, "conflicts", date);
      db.prepare("DELETE FROM observations WHERE id = ?").run(50);
      assert.equal(db.prepare("SELECT count(*) AS total FROM pins").get().total, 1);
      assert.equal(db.prepare("SELECT count(*) AS total FROM relations").get().total, 1);
      assert.equal(db.prepare("SELECT count(*) AS total FROM observations").get().total, 4);
    });
    check("next-id-is-not-max-id-plus-one", () => {
      db.exec("UPDATE memory_state SET next_observation_id = 100, next_observation_position = 4, next_session_position = 2");
      assert.equal(db.prepare("SELECT next_observation_id FROM memory_state").get().next_observation_id, 100);
    });
    peer = open(file);
    configure(peer);
    check("wal-reader-and-bounded-writer-lock", () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        assert.equal(peer.prepare("SELECT count(*) AS total FROM observations").get().total, 4);
        assert.throws(() => peer.exec("INSERT INTO scopes VALUES ('locked', NULL, 0)"), /locked|busy/i);
      } finally {
        db.exec("ROLLBACK");
      }
      peer.exec("INSERT INTO scopes VALUES ('unlocked', NULL, 0); DELETE FROM scopes WHERE path = 'unlocked'");
    });
    check("private-directory-database-and-wal", () => {
      if (process.platform === "win32") return;
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      for (const suffix of ["", "-wal", "-shm"]) {
        assert.equal(fs.statSync(`${file}${suffix}`).mode & 0o777, 0o600);
      }
    });
    check("sqlite-foreign-key-and-fts-integrity", () => integrity(db));
    check("consistent-backup-with-live-wal", () => {
      const backupFile = path.join(directory, "backup.sqlite");
      createPrivateFile(backupFile);
      db.prepare("VACUUM INTO ?").run(backupFile);
      const backup = open(backupFile);
      try {
        configure(backup);
        integrity(backup);
        assert.deepEqual(snapshot(backup), snapshot(db));
        assert.deepEqual(searchIds(backup, "descuentos"), [21]);
        if (process.platform !== "win32") assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);
      } finally {
        backup.close();
      }
    });
    check("readonly-open-rejects-writes", () => {
      const reader = open(file, true);
      try {
        assert.equal(reader.prepare("SELECT count(*) AS total FROM observations").get().total, 4);
        assert.throws(() => reader.exec("INSERT INTO scopes VALUES ('readonly', NULL, 0)"), /readonly|read.only/i);
      } finally {
        reader.close();
      }
      const absent = path.join(directory, "absent.sqlite");
      assert.throws(() => open(absent, true));
      assert.equal(fs.existsSync(absent), false);
    });
    return { sqlite, checks, posixPermissions: process.platform !== "win32", schemaSha256: createHash("sha256").update(schema).digest("hex") };
  } finally {
    peer?.close();
    db.close();
  }
}

export function interop(open, directory, write) {
  const db = open(path.join(directory, "memory.sqlite"), !write);
  try {
    if (write) {
      configure(db);
      assert.deepEqual(searchIds(db, "descuentos"), [21]);
      db.exec("BEGIN IMMEDIATE");
      try {
        const state = db.prepare("SELECT * FROM memory_state").get();
        assert.equal(state.next_observation_id, 100);
        db.prepare(insertSql).run(100, "acme", "general", "interopunico", "", "", date, state.next_observation_position);
        db.exec("UPDATE memory_state SET next_observation_id = 101, next_observation_position = 5; COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      integrity(db);
    }
    assert.deepEqual(searchIds(db, "interopunico"), [100]);
    assert.equal(db.prepare("SELECT next_observation_id FROM memory_state").get().next_observation_id, 101);
    return { checks: [write ? "peer-read-and-write" : "origin-read-peer-write"] };
  } finally {
    db.close();
  }
}

export async function runProbeCommand(schema) {
  const [driver, action, directory] = process.argv.slice(2);
  if (!["probe", "interop-write", "interop-read"].includes(action)
    || !directory || !fs.statSync(directory).isDirectory()
    || !path.basename(fs.realpathSync(directory)).startsWith("malahor-memory-sqlite-")) {
    throw new Error("Uso interno: probe.mjs <node|bun|better> <probe|interop-write|interop-read> <sandbox generado>");
  }
  let open;
  try {
    open = await loadDriver(driver);
  } catch (error) {
    if (!["ERR_MODULE_NOT_FOUND", "ERR_UNKNOWN_BUILTIN_MODULE", "ERR_UNSUPPORTED_ESM_URL_SCHEME"].includes(error.code)
      && !/Cannot find package|No such built-in module|Cannot find module/.test(error.message)) throw error;
    console.log(JSON.stringify({ driver, status: "unavailable", reason: error.message }));
    return;
  }
  const result = action === "probe" ? probe(open, directory, schema) : interop(open, directory, action === "interop-write");
  console.log(JSON.stringify({ driver, status: "passed", runtime: { node: process.version, bun: process.versions.bun ?? null }, ...result }));
}
