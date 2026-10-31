import type { MnemoDb, Observation, SessionSummary } from "../../src/mnemo/db";

export const BANK_ROOT = "banco-sintetico";
export const BANK_ASSIGNMENTS = ["asig-1", "asig-2"] as const;
export const BANK_HUS = ["hu-1", "hu-2", "hu-3"] as const;
export const BANK_AREAS = ["frontend", "backend", "demo"] as const;

export interface BankScopeFixture {
  db: MnemoDb;
  root: string;
  assignments: string[];
  hus: string[];
  leaves: string[];
  observationIds: Record<string, number>;
  sessionSummaries: Record<string, string>;
  boundary: {
    root: string;
    hu1: string;
    hu10: string;
    asig10: string;
    otherProject: string;
  };
}

export function bankScopeFixture(): BankScopeFixture {
  const observations: Observation[] = [];
  const sessions: SessionSummary[] = [];
  const observationIds: Record<string, number> = {};
  const sessionSummaries: Record<string, string> = {};
  const assignments: string[] = [];
  const hus: string[] = [];
  const leaves: string[] = [];

  const addObservation = (scope: string): void => {
    const id = observations.length + 1;
    observationIds[scope] = id;
    observations.push({
      id,
      project: scope,
      type: "general",
      title: `Decision sintetica ${scope}`,
      content: `Contenido funcional aislado para ${scope}`,
      tags: "sintetico,scope-bancario",
      created_at: isoDate(id),
    });
  };
  const addSession = (scope: string): void => {
    const summary = `Sesion sintetica ${scope}`;
    sessionSummaries[scope] = summary;
    sessions.push({ project: scope, summary, created_at: isoDate(100 + sessions.length) });
  };

  addObservation("global");
  addObservation(BANK_ROOT);
  for (const assignmentName of BANK_ASSIGNMENTS) {
    const assignment = `${BANK_ROOT}/${assignmentName}`;
    assignments.push(assignment);
    addObservation(assignment);
    for (const huName of BANK_HUS) {
      const hu = `${assignment}/${huName}`;
      hus.push(hu);
      addObservation(hu);
      for (const area of BANK_AREAS) {
        const leaf = `${hu}/${area}`;
        leaves.push(leaf);
        addObservation(leaf);
        addSession(leaf);
      }
    }
  }

  const boundary = {
    root: "limites-sinteticos",
    hu1: "limites-sinteticos/asig-1/hu-1/frontend",
    hu10: "limites-sinteticos/asig-1/hu-10/frontend",
    asig10: "limites-sinteticos/asig-10/hu-1/frontend",
    otherProject: "otro-banco-sintetico/asig-1/hu-1/frontend",
  };
  for (const scope of [boundary.hu1, boundary.hu10, boundary.asig10, boundary.otherProject]) addObservation(scope);

  return {
    db: { observations, sessions, nextId: observations.length + 1 },
    root: BANK_ROOT,
    assignments,
    hus,
    leaves,
    observationIds,
    sessionSummaries,
    boundary,
  };
}

export function scopeChain(scope: string): string[] {
  const segments = scope.split("/");
  return ["global", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
}

export function inheritedObservationIds(fixture: BankScopeFixture, scope: string): number[] {
  return scopeChain(scope).reverse().map((candidate) => fixture.observationIds[candidate]);
}

export function newestDescendantSession(fixture: BankScopeFixture, scope: string): SessionSummary {
  return fixture.db.sessions
    .filter((session) => session.project === scope || session.project.startsWith(`${scope}/`))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
}

function isoDate(position: number): string {
  return new Date(Date.UTC(2026, 0, 1 + position)).toISOString();
}
