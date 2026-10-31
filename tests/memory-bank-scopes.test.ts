import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { dbPath, saveDb, type Observation } from "../src/mnemo/db";
import { MemoryEngine, type ScopeEntry } from "../src/mnemo/engine";
import { callTool } from "../src/mnemo/tools";
import { memorySandbox, seedEngine, syntheticMarker } from "./memory-engine-fixture";
import {
  bankScopeFixture,
  inheritedObservationIds,
  newestDescendantSession,
  scopeChain,
  type BankScopeFixture,
} from "./fixtures/memory-bank-scopes";

interface MemoryContextResult {
  latestSession: { project: string; summary: string; created_at: string } | null;
  observations: Observation[];
  scopeChain: string[];
  rollupScopes?: string[];
  budgetUsed: number;
  omittedPinnedIds: number[];
}

interface Sandbox {
  root: string;
  home: string;
  sqlite: string;
  previous: Record<string, string | undefined>;
}

let sandbox: Sandbox;
let fixture: BankScopeFixture;

beforeEach(() => {
  const { root } = memorySandbox();
  const home = path.join(root, "malahor-home");
  const previous = Object.fromEntries(["MALAHOR_HOME", "MALAHOR_CONFIG", "MALAHOR_OPENCODE_DIR"]
    .map((key) => [key, process.env[key]]));
  process.env.MALAHOR_HOME = home;
  process.env.MALAHOR_CONFIG = path.join(root, "config.jsonc");
  process.env.MALAHOR_OPENCODE_DIR = path.join(root, "opencode");
  fs.writeFileSync(process.env.MALAHOR_CONFIG, "{}\n", { mode: 0o600 });
  fixture = bankScopeFixture();
  saveDb(fixture.db);
  sandbox = { root, home, sqlite: path.join(home, "memory", "db.sqlite"), previous };
});

afterEach(() => {
  for (const [key, value] of Object.entries(sandbox.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

const context = (scope: string, options: { rollup?: boolean; limit?: number; budget?: number } = {}) =>
  callTool({ name: "mem_context", arguments: { project: scope, limit: options.limit ?? 50,
    ...(options.rollup ? { rollup: true } : {}), ...(options.budget !== undefined ? { budget: options.budget } : {}) } }) as MemoryContextResult;

const searchIds = (scope: string, subtree: boolean): number[] =>
  (callTool({ name: "mem_search", arguments: { query: "", project: scope, subtree, limit: 50 } }) as Observation[])
    .map((item) => item.id).sort((left, right) => left - right);

const tree = (prefix: string): ScopeEntry[] =>
  callTool({ name: "mem_tree", arguments: { prefix } }) as ScopeEntry[];

function activateSqlite(): void {
  seedEngine(sandbox.sqlite, fixture.db).close();
  syntheticMarker(sandbox.home);
}

describe("T-5.5.1: jerarquia bancaria sintetica", () => {
  test("las 18 hojas heredan cinco niveles sin fugas y conservan paridad JSON/SQLite", () => {
    const measure = () => fixture.leaves.map((leaf) => {
      const result = context(leaf);
      const expectedIds = inheritedObservationIds(fixture, leaf);
      const leaks = result.observations.filter((item) => !expectedIds.includes(item.id)).length;
      expect(result.scopeChain).toEqual(scopeChain(leaf));
      expect(result.observations.map((item) => item.id)).toEqual(expectedIds);
      expect(result.latestSession?.summary).toBe(fixture.sessionSummaries[leaf]);
      expect(leaks).toBe(0);
      return { leaf, inherited: result.observations.length, leaks, ids: expectedIds };
    });

    const json = measure();
    activateSqlite();
    const sqlite = measure();
    expect(sqlite).toEqual(json);
    expect({ leaves: sqlite.length, inheritedPerLeaf: new Set(sqlite.map((item) => item.inherited)),
      leaks: sqlite.reduce((total, item) => total + item.leaks, 0) })
      .toEqual({ leaves: 18, inheritedPerLeaf: new Set([5]), leaks: 0 });
  });

  test("exact y subtree respetan 13 scopes por asignacion, 4 por HU y prefijos vecinos", () => {
    const assignment = fixture.assignments[0];
    const hu = fixture.hus[0];
    const expected = {
      assignmentExact: [fixture.observationIds[assignment]],
      assignmentSubtree: 13,
      huSubtree: 4,
      boundaryHu1: [fixture.observationIds[fixture.boundary.hu1]],
      boundaryAssignment: [fixture.observationIds[fixture.boundary.hu1], fixture.observationIds[fixture.boundary.hu10]].sort((a, b) => a - b),
    };
    const measure = () => ({
      assignmentExact: searchIds(assignment, false),
      assignmentSubtree: searchIds(assignment, true),
      huSubtree: searchIds(hu, true),
      boundaryHu1: searchIds(`${fixture.boundary.root}/asig-1/hu-1`, true),
      boundaryAssignment: searchIds(`${fixture.boundary.root}/asig-1`, true),
    });

    const json = measure();
    expect(json.assignmentExact).toEqual(expected.assignmentExact);
    expect(json.assignmentSubtree).toHaveLength(expected.assignmentSubtree);
    expect(json.huSubtree).toHaveLength(expected.huSubtree);
    expect(json.boundaryHu1).toEqual(expected.boundaryHu1);
    expect(json.boundaryAssignment).toEqual(expected.boundaryAssignment);
    expect(json.boundaryAssignment).not.toContain(fixture.observationIds[fixture.boundary.asig10]);
    expect(json.assignmentSubtree).not.toContain(fixture.observationIds[fixture.boundary.otherProject]);
    activateSqlite();
    expect(measure()).toEqual(json);
  });

  test("rollup agrega solo descendientes propios y elige la sesion mas nueva", () => {
    const assignment = fixture.assignments[0];
    const hu = fixture.hus[0];
    const measure = () => {
      const assignmentResult = context(assignment, { rollup: true });
      const huResult = context(hu, { rollup: true });
      return {
        assignmentIds: assignmentResult.observations.map((item) => item.id).sort((a, b) => a - b),
        assignmentScopes: assignmentResult.rollupScopes,
        assignmentSession: assignmentResult.latestSession,
        huIds: huResult.observations.map((item) => item.id).sort((a, b) => a - b),
        huScopes: huResult.rollupScopes,
        huSession: huResult.latestSession,
      };
    };

    const json = measure();
    const expectedRollupIds = (scope: string) => fixture.db.observations
      .filter((item) => scopeChain(scope).includes(item.project) || item.project.startsWith(`${scope}/`))
      .map((item) => item.id).sort((a, b) => a - b);
    expect(json.assignmentIds).toEqual(expectedRollupIds(assignment));
    expect(json.assignmentScopes).toHaveLength(12);
    expect(json.assignmentSession).toEqual(newestDescendantSession(fixture, assignment));
    expect(json.huIds).toEqual(expectedRollupIds(hu));
    expect(json.huScopes).toHaveLength(3);
    expect(json.huSession).toEqual(newestDescendantSession(fixture, hu));
    const otherAssignmentIds = new Set(fixture.db.observations
      .filter((item) => item.project === fixture.assignments[1] || item.project.startsWith(`${fixture.assignments[1]}/`))
      .map((item) => item.id));
    expect(json.assignmentIds.some((id) => otherAssignmentIds.has(id))).toBe(false);
    activateSqlite();
    expect(measure()).toEqual(json);
  });

  test("pins v2 priorizan solo el contexto seleccionado, respetan budget y no alteran recuerdos", () => {
    const targetScope = fixture.leaves[0];
    const siblingScope = fixture.leaves[1];
    const outsideScope = fixture.leaves.at(-1)!;
    const targetId = fixture.observationIds[targetScope];
    const projectId = fixture.observationIds[fixture.root];
    const siblingId = fixture.observationIds[siblingScope];
    const outsideId = fixture.observationIds[outsideScope];
    expect(() => callTool({ name: "mem_pin", arguments: { id: targetId } })).toThrow("requiere memoria v2");
    activateSqlite();
    const beforeReader = MemoryEngine.open(sandbox.sqlite);
    let before: Observation | null;
    try { before = beforeReader.get(targetId); } finally { beforeReader.close(); }
    expect(before).not.toBeNull();
    for (const id of [targetId, targetId, projectId, siblingId, outsideId]) {
      expect(callTool({ name: "mem_pin", arguments: { id } })).toEqual({ id, pinned: true });
    }

    const limited = context(targetScope, { limit: 1 });
    expect(limited.observations.map((item) => item.id)).toEqual([targetId]);
    expect(limited.omittedPinnedIds).toEqual([projectId]);
    expect(limited.observations.map((item) => item.id)).not.toContain(siblingId);
    expect(limited.observations.map((item) => item.id)).not.toContain(outsideId);
    const budget = JSON.stringify(before).length;
    const budgeted = context(targetScope, { budget });
    expect(budgeted.observations.map((item) => item.id)).toEqual([targetId]);
    expect(budgeted.budgetUsed).toBe(budget);
    expect(budgeted.latestSession).toBeNull();
    const reader = MemoryEngine.open(sandbox.sqlite);
    try { expect(reader.get(targetId)).toEqual(before); } finally { reader.close(); }
  });

  test("tree conserva 27 scopes con parents, profundidad y conteos directos", () => {
    const json = tree(fixture.root);
    expect(json).toHaveLength(27);
    for (const item of json) {
      const parts = item.path.split("/");
      expect(item.depth).toBe(parts.length - 1);
      expect(item.parent).toBe(parts.length === 1 ? null : parts.slice(0, -1).join("/"));
      expect(item.observations).toBe(1);
      expect(item.sessions).toBe(fixture.leaves.includes(item.path) ? 1 : 0);
    }
    activateSqlite();
    expect(tree(fixture.root)).toEqual(json);
    process.stdout.write(`[T-5.5.1] ${JSON.stringify({ leaves: 18, inheritedPerLeaf: 5, leaks: 0,
      assignmentSubtree: 13, huSubtree: 4, treeScopes: 27 })}\n`);
    expect(fs.existsSync(dbPath())).toBe(true);
  });
});
