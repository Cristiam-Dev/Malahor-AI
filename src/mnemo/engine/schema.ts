export const MEMORY_APPLICATION_ID = 0x4D414C32;
export const MEMORY_SCHEMA_VERSION = 1;

export const MEMORY_SCHEMA = `
CREATE TABLE memory_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_observation_id INTEGER NOT NULL CHECK (next_observation_id BETWEEN 1 AND 9007199254740991),
  next_observation_position INTEGER NOT NULL CHECK (next_observation_position >= 0),
  next_session_position INTEGER NOT NULL CHECK (next_session_position >= 0)
) STRICT;
INSERT INTO memory_state VALUES (1, 1, 0, 0);

CREATE TABLE scopes (
  path TEXT PRIMARY KEY NOT NULL COLLATE BINARY,
  parent_path TEXT REFERENCES scopes(path) ON DELETE RESTRICT,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  CHECK (length(path) > 0 AND path NOT GLOB '*[^a-z0-9/-]*'
    AND substr(path, 1, 1) <> '/' AND substr(path, -1) <> '/' AND instr(path, '//') = 0),
  CHECK ((parent_path IS NULL AND depth = 0 AND instr(path, '/') = 0)
    OR (parent_path IS NOT NULL AND depth > 0
      AND substr(path, 1, length(parent_path) + 1) = parent_path || '/'
      AND instr(substr(path, length(parent_path) + 2), '/') = 0))
) STRICT;
CREATE INDEX scopes_parent ON scopes(parent_path);
CREATE TRIGGER scopes_parent_depth BEFORE INSERT ON scopes
WHEN NEW.parent_path IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM scopes WHERE path = NEW.parent_path AND depth = NEW.depth - 1
) BEGIN SELECT RAISE(ABORT, 'scope parent/depth mismatch'); END;
CREATE TRIGGER scopes_immutable BEFORE UPDATE ON scopes
BEGIN SELECT RAISE(ABORT, 'scope paths are immutable; move records explicitly'); END;
INSERT INTO scopes VALUES ('global', NULL, 0);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  scope_path TEXT NOT NULL REFERENCES scopes(path) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('decision', 'bug', 'pattern', 'architecture', 'learning', 'general')),
  title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL, created_at TEXT NOT NULL,
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0)
) STRICT;
CREATE INDEX observations_scope_position ON observations(scope_path, position);
CREATE INDEX observations_scope_type ON observations(scope_path, type);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  scope_path TEXT NOT NULL REFERENCES scopes(path) ON DELETE RESTRICT,
  summary TEXT NOT NULL, created_at TEXT NOT NULL,
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0)
) STRICT;
CREATE INDEX sessions_scope_position ON sessions(scope_path, position);
CREATE TABLE pins (
  observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE relations (
  source_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('supersedes', 'conflicts')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, kind), CHECK (source_id <> target_id)
) STRICT;
CREATE INDEX relations_target ON relations(target_id);

CREATE VIRTUAL TABLE observations_fts USING fts5(
  title, content, tags, content = 'observations', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER observations_fts_insert AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content, tags) VALUES (NEW.id, NEW.title, NEW.content, NEW.tags);
END;
CREATE TRIGGER observations_fts_delete AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, tags)
  VALUES ('delete', OLD.id, OLD.title, OLD.content, OLD.tags);
END;
CREATE TRIGGER observations_fts_update AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, tags)
  VALUES ('delete', OLD.id, OLD.title, OLD.content, OLD.tags);
  INSERT INTO observations_fts(rowid, title, content, tags) VALUES (NEW.id, NEW.title, NEW.content, NEW.tags);
END;
PRAGMA application_id = ${MEMORY_APPLICATION_ID};
PRAGMA user_version = ${MEMORY_SCHEMA_VERSION};
`;
