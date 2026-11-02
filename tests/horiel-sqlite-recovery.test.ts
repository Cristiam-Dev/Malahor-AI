import { describe, test } from "bun:test";

import {
  NODE_SCENARIO_NAMES,
  assertNodeScenario,
  runNodeScenarioGroup,
} from "./fixtures/horiel-sqlite";

const report = runNodeScenarioGroup("recovery");

describe("Horiel SQLite locking and crash recovery", () => {
  for (const scenario of NODE_SCENARIO_NAMES.recovery) {
    test(scenario, async () => {
      assertNodeScenario(await report, scenario);
    });
  }
});
