#!/usr/bin/env node
import { runConfig } from "./commands/config";
import { runDoctor } from "./commands/doctor";
import { runGitCommand } from "./commands/git";
import { runGraph } from "./commands/graph";
import { runContext } from "./commands/context";
import { runInstall } from "./commands/install";
import { runHooksCommand } from "./commands/hooks";
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
      case "config":
        runConfig({
          action: parsed.args[0] ?? "status",
          apply: parsed.flags.has("apply"),
          dryRun: parsed.flags.has("dry-run"),
          yes: parsed.flags.has("yes"),
          confirm: parsed.options.confirm,
          json: parsed.flags.has("json"),
          v2: parsed.flags.has("v2"),
        });
        return;
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
      case "git":
        runGitCommand({
          action: parsed.args[0] ?? "help",
          args: parsed.args.slice(1),
          profile: parsed.options.profile,
          project: parsed.options.project,
          confirm: parsed.options.confirm,
          message: parsed.options.message,
          type: parsed.options.type,
          scope: parsed.options.scope,
          icon: parsed.options.icon,
          json: parsed.flags.has("json"),
        });
        return;
      case "hooks":
        runHooksCommand({
          action: parsed.args[0] ?? "help",
          args: parsed.args.slice(1),
          command: parsed.options.command,
          paths: parsed.options.paths,
          profile: parsed.options.profile,
          project: parsed.options.project,
          scope: parsed.options.scope,
          confirm: parsed.options.confirm,
          approval: parsed.options.approval,
          ttl: parsed.options.ttl,
          json: parsed.flags.has("json"),
        });
        return;
      case "memory":
        runMemory({
          action: parsed.args[0] ?? "help",
          args: parsed.args.slice(1),
          all: parsed.flags.has("all"),
          confirm: parsed.options.confirm,
          dryRun: parsed.flags.has("dry-run"),
          yes: parsed.flags.has("yes"),
          apply: parsed.flags.has("apply"),
          approval: parsed.options.approval,
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

      if ((key === "command" || key === "confirm" || key === "mode" || key === "paths" || key === "profile" || key === "project" || key === "limit" || key === "policy-after" || key === "message" || key === "type" || key === "scope" || key === "icon" || key === "approval" || key === "ttl") && rest[index + 1] && !rest[index + 1].startsWith("--")) {
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
  process.stdout.write(`malahor-ai\n\nCommands:\n  config        Revisar/consolidar opencode.json + opencode.jsonc (preview, respaldo y rollback)\n  install       Install Malahor for OpenCode (politica diferida: valida antes de bloquear)\n  doctor        Diagnose current installation (--self-heal repara y migra permisos)\n  graph         Generate external code graph\n  graphify      Manage isolated Graphify venv (status|install|verify)\n  git           Assisted git workflow (precommit, prepush, commit-message)\n  context       Configure project context and detect stack\n  memory        Administer Mnemo memory\n  obsidian      Configure Obsidian MCP bridge\n  uninstall     Remove Malahor from OpenCode (incluye los bloqueos de build)\n  update        Refresh Malahor installation (migrar politicas legacy)\n\nGraphify commands:\n  graphify status [--dry-run]\n  graphify install [--dry-run]\n  graphify verify [--dry-run]\n\nGit commands:\n  git precommit [--message <mensaje>] [--profile <perfil>]\n  git prepush [--profile release]\n  git commit-message [resumen...] [--type <tipo>] [--scope <scope>] [--icon <emoji>]\n\nContext commands:\n  context status [--project <key>]\n  context detect [--project <key>]\n  context recover [--project <key>] [--limit <n>]\n  context capsule [--project <key>] [--limit <n>]\n  context save [summary...] [--project <key>]\n  context set mnemo|mnemo+graphify|mnemo+graphify+obsidian [--project <key>] [--dry-run]\n  context obsidian on|off [--project <key>] [--dry-run]\n  context graphify on|off [--project <key>] [--dry-run]\n\nMemory commands:\n  memory list\n  memory inspect <project>\n  memory backup [--dry-run]\n  memory reset <project> --yes --confirm <project>\n  memory reset --all --yes --confirm ALL\n  memory restore <backup-file> --yes --confirm RESTORE\n\nObsidian commands:\n  obsidian status [--mode wsl-windows|windows-local]\n  obsidian guide [--mode wsl-windows|windows-local]\n  obsidian setup [--dry-run] [--yes] [--mode wsl-windows|windows-local]\n  obsidian verify [--mode wsl-windows|windows-local]\n\nConfig commands:\n  config status [--json]\n  config consolidate [--apply --yes --confirm <token>] [--dry-run]\n  config rollback [--apply --yes --confirm <token>] [--dry-run]\n\nFlags:\n  --dry-run        Show actions without writing files\n  --yes            Use defaults without prompts\n  --bootstrap      Agent-safe: auto-build con bun, Graphify opcional, sin prompts\n  --with-graphify  Intenta instalar Graphify en venv aislado (degrada sin romper)\n  --policy-after   ejecutar | guiar | acompanar (aplicada al final, tras validar)\n  --self-heal      (doctor) Repara instalacion y migra permisos legacy\n\nConfiguration:\n  MALAHOR_MODE                    assistant | executor\n  MALAHOR_CONFIG                  Path to config.jsonc\n  MALAHOR_HOME                    Override ~/.malahor\n  MALAHOR_OPENCODE_DIR            Override ~/.config/opencode\n  MALAHOR_EXECUTION_INTERVENTION  ejecutar | guiar | acompanar\n  MALAHOR_EXECUTION_VERIFICATION  true | false\n\nConfig file keys:\n  execution.intervention      ejecutar | guiar | acompanar\n  execution.verification      boolean read-only verification\n  projects.aliases            map canonical project to aliases\n\nSandbox example:\n  MALAHOR_HOME=.sandbox/home/.malahor MALAHOR_OPENCODE_DIR=.sandbox/home/.config/opencode malahor-ai install --yes\n`);
  process.stdout.write(`\nMemory migration:\n  memory migrate [--dry-run]\n  memory migrate --apply --yes --confirm <token>\n`);
}

void main(process.argv.slice(2));
