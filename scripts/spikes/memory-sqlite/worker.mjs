import { runProbeCommand } from "./probe.mjs";

await runProbeCommand().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
