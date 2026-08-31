#!/usr/bin/env node
import { runDoctor } from "./commands/doctor";
import { runGraph } from "./commands/graph";
import { runInstall } from "./commands/install";
import { runUninstall } from "./commands/uninstall";
import { runUpdate } from "./commands/update";

interface ParsedArgs {
  command: string;
  flags: Set<string>;
}

function main(argv: string[]): void {
  const parsed = parseArgs(argv);

  try {
    switch (parsed.command) {
      case "install":
        runInstall({ dryRun: parsed.flags.has("dry-run"), yes: parsed.flags.has("yes") });
        return;
      case "doctor":
        runDoctor();
        return;
      case "graph":
        runGraph({ dryRun: parsed.flags.has("dry-run") });
        return;
      case "uninstall":
        runUninstall({ dryRun: parsed.flags.has("dry-run"), yes: parsed.flags.has("yes") });
        return;
      case "update":
        runUpdate({ dryRun: parsed.flags.has("dry-run"), yes: parsed.flags.has("yes") });
        return;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return;
      default:
        process.stderr.write(`Unknown command: ${parsed.command}\n\n`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Set<string>();

  for (const arg of rest) {
    if (arg.startsWith("--")) flags.add(arg.slice(2));
  }

  return { command, flags };
}

function printHelp(): void {
  process.stdout.write(`malahor-ai\n\nCommands:\n  install       Install Malahor for OpenCode\n  doctor        Diagnose current installation\n  graph         Generate external code graph\n  uninstall     Remove Malahor from OpenCode\n  update        Refresh Malahor installation\n\nFlags:\n  --dry-run     Show actions without writing files\n  --yes         Non-interactive confirmation placeholder\n\nConfiguration:\n  MALAHOR_MODE          assistant | executor\n  MALAHOR_CONFIG        Path to config.jsonc\n  MALAHOR_HOME          Override ~/.malahor\n  MALAHOR_OPENCODE_DIR  Override ~/.config/opencode\n\nSandbox example:\n  MALAHOR_HOME=.sandbox/home/.malahor MALAHOR_OPENCODE_DIR=.sandbox/home/.config/opencode malahor-ai install --yes\n`);
}

main(process.argv.slice(2));
