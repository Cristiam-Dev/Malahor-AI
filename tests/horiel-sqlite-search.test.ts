import { describe, test } from "bun:test";

import {
  NODE_SCENARIO_NAMES,
  assertNodeScenario,
  runNodeScenarioGroup,
} from "./fixtures/horiel-sqlite";

const report = runNodeScenarioGroup("search");

describe("Horiel SQLite FTS5, context and opaque keyset cursors", () => {
  for (const scenario of NODE_SCENARIO_NAMES.search) {
    test(scenario, async () => {
      assertNodeScenario(await report, scenario);
    });
  }
});
