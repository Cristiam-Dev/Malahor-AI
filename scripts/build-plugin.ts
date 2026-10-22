import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const entry = path.join(root, "src/plugin/index.ts");
const outfile = path.join(root, "assets/opencode/plugins/malahor/index.ts");
const temporary = mkdtempSync(path.join(os.tmpdir(), "malahor-plugin-build-"));

try {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: temporary,
    target: "node",
    format: "esm",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const output = result.outputs.find((item) => item.path.endsWith(".js")) ?? result.outputs[0];
  if (!output) {
    console.error("El build del plugin no produjo salida.");
    process.exit(1);
  }

  const bundle = await output.text();
  const banner = [
    "// malahor-managed",
    "// @ts-nocheck bundle generado desde src/plugin/index.ts; el source se typechequea con tsconfig.json",
    "",
  ].join("\n");
  await Bun.write(outfile, `${banner}${bundle}`);
  console.log(`Plugin bundle: ${path.relative(root, outfile)}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
