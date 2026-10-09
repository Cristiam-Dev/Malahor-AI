#!/usr/bin/env node
import { runDoctor } from "./commands/doctor";
import { runGraph } from "./commands/graph";
import { runContext } from "./commands/context";
import { runInstall } from "./commands/install";
import { runMemory } from "./commands/memory";
import { runObsidian } from "./commands/obsidian";
import { runUninstall } from "./commands/uninstall";
import { runUpdate } from "./commands/update";

interface ParsedArgs {
  command: string;
  args: string[];
  flags: Set<string>;
  options: Record<string, string>;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);

  try {
    switch (parsed.command) {
      case "install":
        await runInstall({
          dryRun: parsed.flags.has("dry-run"),
          yes: parsed.flags.has("yes"),
          bootstrap: parsed.flags.has("bootstrap"),
          withGraphify: parsed.flags.has("with-graphify"),
          policyAfter: parsed.options["policy-after"],
        });
        return;
      case "doctor":
        runDoctor({ dryRun: parsed.flags.has("dry-run"), selfHeal: parsed.flags.has("self-heal") });
        return;
      case "graph":
        runGraph({ action: parsed.args[0] ?? "generate", dryRun: parsed.flags.has("dry-run") });
        return;
      case "graphify":
        runGraph({ action: parsed.args[0] ?? "status", dryRun: parsed.flags.has("dry-run") });
        return;
      case "memory":
        runMemory({
          action: parsed.args[0] ?? "help",
          args: parsed.args.slice(1),
          all: parsed.flags.has("all"),
          confirm: parsed.options.confirm,
          dryRun: parsed.flags.has("dry-run"),
          yes: parsed.flags.has("yes"),
        });
        return;
      case "context":
        runContext({
          action: parsed.args[0] ?? "help",
          args: parsed.args.slice(1),
          dryRun: parsed.flags.has("dry-run"),
          limit: parsed.options.limit,
          project: parsed.options.project,
        });
        return;
      case "obsidian":
        await runObsidian({
          action: parsed.args[0] ?? "help",
          args: parsed.args.slice(1),
          dryRun: parsed.flags.has("dry-run"),
          mode: parsed.options.mode,
          yes: parsed.flags.has("yes"),
        });
        return;
      case "uninstall":
        runUninstall({ dryRun: parsed.flags.has("dry-run"), yes: parsed.flags.has("yes") });
        return;
      case "update":
        runUpdate({
          dryRun: parsed.flags.has("dry-run"),
          yes: parsed.flags.has("yes"),
          bootstrap: parsed.flags.has("bootstrap"),
          withGraphify: parsed.flags.has("with-graphify"),
          policyAfter: parsed.options["policy-after"],
        });
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
  const options: Record<string, string> = {};
  const args: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      flags.add(key);

      if ((key === "confirm" || key === "mode" || key === "project" || key === "limit" || key === "policy-after") && rest[index + 1] && !rest[index + 1].startsWith("--")) {
        options[key] = rest[index + 1];
        index += 1;
      }

      continue;
    }

    args.push(arg);
  }

  return { command, args, flags, options };
}

function printHelp(): void {
  process.stdout.write(`malahor-ai\n\nCommands:\n  install       Install Malahor for OpenCode (politica diferida: valida antes de bloquear)\n  doctor        Diagnose current installation (--self-heal repara y migra permisos)\n  graph         Generate external code graph\n  graphify      Manage isolated Graphify venv (status|install|verify)\n  context       Configure project context and detect stack\n  memory        Administer Mnemo memory\n  obsidian      Configure Obsidian MCP bridge\n  uninstall     Remove Malahor from OpenCode (incluye los bloqueos de build)\n  update        Refresh Malahor installation (migrar politicas legacy)\n\nGraphify commands:\n  graphify status [--dry-run]\n  graphify install [--dry-run]\n  graphify verify [--dry-run]\n\nContext commands:\n  context status [--project <key>]\n  context detect [--project <key>]\n  context recover [--project <key>] [--limit <n>]\n  context capsule [--project <key>] [--limit <n>]\n  context save [summary...] [--project <key>]\n  context set mnemo|mnemo+graphify|mnemo+graphify+obsidian [--project <key>] [--dry-run]\n  context obsidian on|off [--project <key>] [--dry-run]\n  context graphify on|off [--project <key>] [--dry-run]\n\nMemory commands:\n  memory list\n  memory inspect <project>\n  memory backup [--dry-run]\n  memory reset <project> --yes --confirm <project>\n  memory reset --all --yes --confirm ALL\n  memory restore <backup-file> --yes --confirm RESTORE\n\nObsidian commands:\n  obsidian status [--mode wsl-windows|windows-local]\n  obsidian guide [--mode wsl-windows|windows-local]\n  obsidian setup [--dry-run] [--yes] [--mode wsl-windows|windows-local]\n  obsidian verify [--mode wsl-windows|windows-local]\n\nFlags:\n  --dry-run        Show actions without writing files\n  --yes            Use defaults without prompts\n  --bootstrap      Agent-safe: auto-build con bun, Graphify opcional, sin prompts\n  --with-graphify  Intenta instalar Graphify en venv aislado (degrada sin romper)\n  --policy-after   ejecutar | guiar | acompanar (aplicada al final, tras validar)\n  --self-heal      (doctor) Repara instalacion y migra permisos legacy\n\nConfiguration:\n  MALAHOR_MODE                    assistant | executor\n  MALAHOR_CONFIG                  Path to config.jsonc\n  MALAHOR_HOME                    Override ~/.malahor\n  MALAHOR_OPENCODE_DIR            Override ~/.config/opencode\n  MALAHOR_EXECUTION_INTERVENTION  ejecutar | guiar | acompanar\n  MALAHOR_EXECUTION_VERIFICATION  true | false\n\nConfig file keys:\n  execution.intervention      ejecutar | guiar | acompanar\n  execution.verification      boolean read-only verification\n  projects.aliases            map canonical project to aliases\n\nSandbox example:\n  MALAHOR_HOME=.sandbox/home/.malahor MALAHOR_OPENCODE_DIR=.sandbox/home/.config/opencode malahor-ai install --yes\n`);
}

void main(process.argv.slice(2));
