import { describe, test } from "bun:test";

import {
  MIGRATION_SCENARIO_NAMES,
  assertMigrationScenario,
  runMigrationScenarioGroup,
} from "./fixtures/horiel-migration";

const report = runMigrationScenarioGroup("apply");

describe("Horiel P5 staging apply and differential verification", () => {
  for (const scenario of MIGRATION_SCENARIO_NAMES.apply) {
    test(scenario, async () => {
      assertMigrationScenario(await report, scenario);
    });
  }
});
