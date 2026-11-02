import { describe, test } from "bun:test";

import {
  MIGRATION_SCENARIO_NAMES,
  assertMigrationScenario,
  runMigrationScenarioGroup,
} from "./fixtures/horiel-migration";

const report = runMigrationScenarioGroup("mapping");

describe("Horiel P5 deterministic migration mapping", () => {
  for (const scenario of MIGRATION_SCENARIO_NAMES.mapping) {
    test(scenario, async () => {
      assertMigrationScenario(await report, scenario);
    });
  }
});
