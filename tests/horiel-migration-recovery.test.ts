import { describe, test } from "bun:test";

import {
  MIGRATION_SCENARIO_NAMES,
  assertMigrationScenario,
  runMigrationScenarioGroup,
} from "./fixtures/horiel-migration";

const report = runMigrationScenarioGroup("recovery");

describe("Horiel P5 durable recovery", () => {
  for (const scenario of MIGRATION_SCENARIO_NAMES.recovery) {
    test(scenario, async () => {
      assertMigrationScenario(await report, scenario);
    });
  }
});
