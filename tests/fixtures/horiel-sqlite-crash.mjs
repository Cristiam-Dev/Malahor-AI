import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(fixtureRoot, "../..");
const sandboxRoot = path.join(repositoryRoot, ".sandbox", "horiel-p3");
const databasePath = path.resolve(process.argv[2] ?? "");
const relative = path.relative(sandboxRoot, databasePath);

if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error("Crash fixture database must remain inside .sandbox/horiel-p3.");
}

const database = new DatabaseSync(databasePath, {
  enableForeignKeyConstraints: true,
});
database.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  BEGIN IMMEDIATE;
  UPDATE memories
     SET title = 'UNCOMMITTED CRASH VALUE',
         content = 'This synthetic write must be rolled back during recovery.'
   WHERE rowid = (SELECT MIN(rowid) FROM memories);
  UPDATE horiel_store
     SET sequence = sequence + 1000;
`);

fs.writeSync(process.stdout.fd, "horiel-crash-transaction-started\n");
process.kill(process.pid, "SIGKILL");
