import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../cli/core/config";
import { resolveCanonicalProjectScope, type ProjectAliases } from "../cli/core/project";
import { sanitizeMemoryContent } from "./sanitizer";

export type ObservationType = "decision" | "bug" | "pattern" | "architecture" | "learning" | "general";

export interface Observation {
  id: number;
  project: string;
  type: ObservationType;
  title: string;
  content: string;
  tags: string;
  created_at: string;
}

export interface SessionSummary {
  project: string;
  summary: string;
  created_at: string;
}

export interface MnemoDb {
  observations: Observation[];
  sessions: SessionSummary[];
  nextId: number;
}

export interface SaveObservationInput {
  project: string;
  type: ObservationType;
  title: string;
  content: string;
  tags: string;
}

export function dbPath(): string {
  const base = process.env.MALAHOR_HOME ?? path.join(process.env.HOME ?? os.homedir(), ".malahor");
  return path.join(base, "mnemo", "db.json");
}

export function loadDb(filePath = dbPath()): MnemoDb {
  if (!fs.existsSync(filePath)) {
    return { observations: [], sessions: [], nextId: 1 };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return { observations: [], sessions: [], nextId: 1 };

  const parsed = JSON.parse(raw) as Partial<MnemoDb>;
  const aliases = loadConfig().projects.aliases;
  return {
    observations: Array.isArray(parsed.observations)
      ? parsed.observations.map((observation) => normalizeLoadedObservation(observation as Observation, aliases))
      : [],
    sessions: Array.isArray(parsed.sessions)
      ? parsed.sessions.map((session) => normalizeLoadedSession(session as SessionSummary, aliases))
      : [],
    nextId: typeof parsed.nextId === "number" ? parsed.nextId : 1,
  };
}

export function saveDb(db: MnemoDb, filePath = dbPath()): void {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(tempPath, `${JSON.stringify(db, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function saveObservation(input: SaveObservationInput): Observation {
  const db = loadDb();
  const observation: Observation = {
    id: db.nextId,
    project: normalizeProject(input.project),
    type: input.type,
    title: sanitizeMemoryContent(input.title),
    content: sanitizeMemoryContent(input.content),
    tags: sanitizeMemoryContent(input.tags),
    created_at: new Date().toISOString(),
  };

  db.nextId += 1;
  db.observations.push(observation);
  saveDb(db);
  return observation;
}

export function saveSessionSummary(project: string, summary: string): SessionSummary {
  const db = loadDb();
  const session = {
    project: normalizeProject(project),
    summary: sanitizeMemoryContent(summary),
    created_at: new Date().toISOString(),
  };

  db.sessions.push(session);
  saveDb(db);
  return session;
}

export function searchObservations(query: string, project = "", type = "", limit = 5): Observation[] {
  const db = loadDb();
  const normalizedQuery = query.toLowerCase();
  const normalizedProject = project ? normalizeProject(project) : "";

  return db.observations
    .filter((observation) => !normalizedProject || observation.project === normalizedProject)
    .filter((observation) => !type || observation.type === type)
    .filter((observation) => {
      const haystack = `${observation.title}\n${observation.content}\n${observation.tags}`.toLowerCase();
      return !normalizedQuery || haystack.includes(normalizedQuery);
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export function getObservation(id: number): Observation | null {
  return loadDb().observations.find((observation) => observation.id === id) ?? null;
}

export function listProjects(filePath = dbPath()): Array<{ project: string; observations: number; latest: string }> {
  const counts = new Map<string, { observations: number; latest: string }>();
  const db = loadDb(filePath);

  for (const observation of db.observations) {
    const current = counts.get(observation.project) ?? { observations: 0, latest: observation.created_at };
    current.observations += 1;
    if (observation.created_at > current.latest) current.latest = observation.created_at;
    counts.set(observation.project, current);
  }

  for (const session of db.sessions) {
    const current = counts.get(session.project) ?? { observations: 0, latest: session.created_at };
    if (session.created_at > current.latest) current.latest = session.created_at;
    counts.set(session.project, current);
  }

  return Array.from(counts.entries())
    .map(([project, value]) => ({ project, ...value }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
}

export function normalizeProject(project: string): string {
  return resolveCanonicalProjectScope(project, loadConfig().projects.aliases);
}

function normalizeLoadedObservation(observation: Observation, aliases: ProjectAliases): Observation {
  return { ...observation, project: resolveCanonicalProjectScope(observation.project, aliases) };
}

function normalizeLoadedSession(session: SessionSummary, aliases: ProjectAliases): SessionSummary {
  return { ...session, project: resolveCanonicalProjectScope(session.project, aliases) };
}
