#!/usr/bin/env node
import { runConfig } from "./commands/config";
import { runCodegraph } from "./commands/codegraph";
import { runContext } from "./commands/context";
import { runDoctor } from "./commands/doctor";
import { runDocs } from "./commands/docs";
import { runGitCommand } from "./commands/git";
import { runHooksCommand } from "./commands/hooks";
import { runInstall } from "./commands/install";
import { runMemory } from "./commands/memory";
import { runMode } from "./commands/mode";
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
      case "mode":
        await runMode({ action: parsed.args[0] ?? "status", args: parsed.args.slice(1), approval: parsed.options.approval, yes: parsed.flags.has("yes") });
        return;
      case "install":
        await runInstall({
          dryRun: parsed.flags.has("dry-run"),
          yes: parsed.flags.has("yes"),
          bootstrap: parsed.flags.has("bootstrap"),
          policyAfter: parsed.options["policy-after"],
          docsPath: parsed.options["docs-path"],
        });
        return;
      case "codegraph":
        await runCodegraph({
          action: parsed.args[0] ?? "guide",
          project: parsed.options.project,
          confirm: parsed.options.confirm,
          dryRun: parsed.flags.has("dry-run"),
        });
        return;
      case "doctor":
        runDoctor({ dryRun: parsed.flags.has("dry-run"), selfHeal: parsed.flags.has("self-heal") });
        return;
      case "docs":
        runDocs({
          action: parsed.args[0] ?? "status",
          args: parsed.args.slice(1),
          project: parsed.options.project,
          path: parsed.options.path,
          app: parsed.options.app,
          dryRun: parsed.flags.has("dry-run"),
          apply: parsed.flags.has("apply"),
          yes: parsed.flags.has("yes"),
        });
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
          resourceKind: parsed.options["resource-kind"],
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
          subtree: parsed.flags.has("subtree"),
          project: parsed.options.project,
          type: parsed.options.type,
          limit: parsed.options.limit,
        });
        return;
      case "context":
        await runContext({
          action: parsed.args[0] ?? "help",
          args: parsed.args.slice(1),
          dryRun: parsed.flags.has("dry-run"),
          limit: parsed.options.limit,
          project: parsed.options.project,
          apply: parsed.flags.has("apply"),
          yes: parsed.flags.has("yes"),
          approval: parsed.options.approval,
          docsPath: parsed.options["docs-path"],
        });
        return;
      case "uninstall":
        runUninstall({ dryRun: parsed.flags.has("dry-run"), yes: parsed.flags.has("yes") });
        return;
      case "update":
        await runUpdate({
          dryRun: parsed.flags.has("dry-run"),
          yes: parsed.flags.has("yes"),
          bootstrap: parsed.flags.has("bootstrap"),
          policyAfter: parsed.options["policy-after"],
          docsPath: parsed.options["docs-path"],
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

      if ((key === "command" || key === "confirm" || key === "paths" || key === "path" || key === "docs-path" || key === "app" || key === "resource-kind" || key === "profile" || key === "project" || key === "limit" || key === "policy-after" || key === "message" || key === "type" || key === "scope" || key === "icon" || key === "approval" || key === "ttl") && rest[index + 1] && !rest[index + 1].startsWith("--")) {
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
  process.stdout.write(`malahor-ai

Commands:
  config        Revisar y consolidar la configuracion de OpenCode
  codegraph     Gestionar contexto estructural (symgraph, indice externo)
  install       Instalar Malahor para OpenCode
  doctor        Diagnosticar y reparar la instalacion
  docs          Resolver, validar y abrir el vault Markdown canonico
  git           Ejecutar el flujo git asistido
  hooks         Evaluar guardrails cross-harness
  context       Resolver proyecto, contexto y stack
  memory        Administrar la memoria
  mode          Consultar o cambiar asesor/asistente/ejecutor (configuracion de Malahor)
  uninstall     Remover Malahor de OpenCode
  update        Actualizar instalacion, assets y politica

Git commands:
  git precommit [--message <mensaje>] [--profile <perfil>]
  git prepush [--profile release]
  git commit-message [resumen...] [--type <tipo>] [--scope <scope>] [--icon <emoji>]

Context commands:
  context status [--project <key>]
  context detect [--project <key>]
  context recover [--project <key>] [--limit <n>]
  context capsule [--project <key>] [--limit <n>]
  context save [summary...] [--project <key>]
  context register <project> <root> [<root> ...] [--docs-path <externa>] [--yes] [--dry-run]
  context migrate [--apply] [--yes] [--approval <evidencia-hook>]

Docs commands:
  docs path|status [--project <key>]
  docs init [--project <key>] [--path <externa>] [--dry-run]
  docs check [--project <key>]
  docs open [ruta-relativa] [--project <key>] [--app system|vscode|obsidian] [--dry-run]
  docs client [get|status|system|vscode|obsidian] [--dry-run]
  docs move <origen> [--project <key>] [--apply --yes]

Mode commands:
  mode status
  mode preview <asesor|asistente|ejecutor>
  mode set <asesor|asistente|ejecutor> [--yes] [--approval <evidencia-hook>]

Memory commands:
  memory list
  memory tree [prefix]
  memory search <query...> [--project <scope>] [--subtree] [--type <type>] [--limit <n>]
  memory inspect <project>
  memory backup [--dry-run]
  memory reset <project> [--dry-run | --yes --confirm <project>]
  memory reset --all [--dry-run | --yes --confirm ALL]
  memory restore <backup-file> [--dry-run | --yes --confirm RESTORE]
  memory migrate [--dry-run]
  memory migrate --apply --yes --confirm <token>

CodeGraph commands:
  codegraph status [--project <key>]
  codegraph guide
  codegraph setup [--project <key>] [--dry-run | --confirm INSTALL_SYMGRAPH]
  codegraph index [--project <key>] [--dry-run | --confirm INDEX_SYMGRAPH:<key>]

Config commands:
  config status [--json]
  config consolidate [--apply --yes --confirm <token>] [--dry-run]
  config rollback [--apply --yes --confirm <token>] [--dry-run]

Flags:
  --dry-run        Show actions without writing files
  --yes            Use defaults without prompts
  --bootstrap      Agent-safe: auto-build con bun, sin prompts
  --policy-after   ejecutar | guiar | acompanar (aplicada al final, tras validar)
  --self-heal      (doctor) Repara instalacion y migra permisos legacy

Configuration:
  MALAHOR_MODE                    legacy; solo fallback si intervention no esta configurado
  MALAHOR_CONFIG                  Path to config.jsonc
  MALAHOR_HOME                    Override ~/.malahor
  MALAHOR_OPENCODE_DIR            Override ~/.config/opencode
  MALAHOR_EXECUTION_INTERVENTION  ejecutar | guiar | acompanar
  MALAHOR_EXECUTION_VERIFICATION  true | false

Config file keys:
   execution.intervention      ejecutar=ejecutor | guiar=asistente | acompanar=asesor
   mode                        legacy; no anula execution.intervention
  execution.verification      boolean read-only verification
  docs.client                 system | vscode | obsidian (default system)
  projects.aliases            map canonical project to aliases

Sandbox example:
  MALAHOR_HOME=.sandbox/home/.malahor MALAHOR_OPENCODE_DIR=.sandbox/home/.config/opencode malahor-ai install --yes
`);
}

void main(process.argv.slice(2));
