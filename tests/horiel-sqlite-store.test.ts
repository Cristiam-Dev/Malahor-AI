import { describe, test } from "bun:test";

import {
  NODE_SCENARIO_NAMES,
  assertNodeScenario,
  runNodeScenarioGroup,
} from "./fixtures/horiel-sqlite";

const report = runNodeScenarioGroup("store");

describe("Horiel SQLite opening, schema and P2 store port", () => {
  for (const scenario of NODE_SCENARIO_NAMES.store) {
    test(scenario, async () => {
      assertNodeScenario(await report, scenario);
    });
  }
});
