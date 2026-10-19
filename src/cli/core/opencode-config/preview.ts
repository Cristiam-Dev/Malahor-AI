import fs from "node:fs";
import path from "node:path";
import { assertRealDirectory, digest, snapshot } from "./io";
import { mergeConfigText } from "./merge";
import { pendingTransactions } from "./store";
import type { ConfigLocation, ConsolidationPlan } from "./types";

export function hasDuplicateConfigs(directory: string): boolean {
  return ["opencode.json", "opencode.jsonc"].every((name) => {
    try {
      fs.lstatSync(path.join(directory, name));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : true;
    }
  });
}

export function previewConsolidation(location: ConfigLocation): ConsolidationPlan {
  const directory = path.resolve(location.opencodeDir);
  const pending = pendingTransactions(location).map((transaction) => transaction.id);

  try {
    assertRealDirectory(directory);
    const source = snapshot(path.join(directory, "opencode.json"));
    const target = snapshot(path.join(directory, "opencode.jsonc"));

    if (!source || !target) {
      return { state: source || target ? "single" : "missing", directory, source, target, pending };
    }

    const merge = mergeConfigText(target.text, source.text);
    const confirmation = `CONSOLIDATE:${digest(JSON.stringify({ directory, source, target, merged: digest(merge.text) }))}`;

    return { state: merge.conflicts.length ? "blocked" : "ready", directory, source, target, merge, confirmation, pending };
  } catch (error) {
    return {
      state: "blocked",
      directory,
      issue: error instanceof Error ? error.message : "Entrada invalida o no legible; no se interpreta como configuracion vacia.",
      pending,
    };
  }
}
