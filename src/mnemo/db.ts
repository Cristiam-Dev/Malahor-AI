import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  return {
    observations: Array.isArray(parsed.observations) ? parsed.observations : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    nextId: typeof parsed.nextId === "number" ? parsed.nextId : 1,
  };
}

export function saveDb(db: MnemoDb, filePath = dbPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
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

export function contextForProject(project: string, limit = 8): { latestSession: SessionSummary | null; observations: Observation[] } {
  const db = loadDb();
  const normalizedProject = normalizeProject(project);
  const sessions = db.sessions
    .filter((session) => session.project === normalizedProject)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const observations = db.observations
    .filter((observation) => observation.project === normalizedProject)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);

  return { latestSession: sessions[0] ?? null, observations };
}

export function listProjects(): Array<{ project: string; observations: number; latest: string }> {
  const counts = new Map<string, { observations: number; latest: string }>();

  for (const observation of loadDb().observations) {
    const current = counts.get(observation.project) ?? { observations: 0, latest: observation.created_at };
    current.observations += 1;
    if (observation.created_at > current.latest) current.latest = observation.created_at;
    counts.set(observation.project, current);
  }

  return Array.from(counts.entries())
    .map(([project, value]) => ({ project, ...value }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
}

export function normalizeProject(project: string): string {
  const value = project.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["malaho", "malahor", "malahor-ai", "malahorai"].includes(value)) return "Malahor-AI";
  return project.trim();
}
