import { describe, test } from "bun:test";

import {
  MIGRATION_SCENARIO_NAMES,
  assertMigrationScenario,
  runMigrationScenarioGroup,
} from "./fixtures/horiel-migration";

const report = runMigrationScenarioGroup("boundary");

describe("Horiel P5 sandbox and runtime boundary", () => {
  for (const scenario of MIGRATION_SCENARIO_NAMES.boundary) {
    test(scenario, async () => {
      assertMigrationScenario(await report, scenario);
    });
  }
});
