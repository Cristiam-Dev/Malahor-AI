import { describe, test } from "bun:test";

import {
  NODE_SCENARIO_NAMES,
  assertNodeScenario,
  runNodeScenarioGroup,
} from "./fixtures/horiel-sqlite";

const report = runNodeScenarioGroup("administration");

describe("Horiel SQLite snapshots and conditional restore", () => {
  for (const scenario of NODE_SCENARIO_NAMES.administration) {
    test(scenario, async () => {
      assertNodeScenario(await report, scenario);
    });
  }
});
