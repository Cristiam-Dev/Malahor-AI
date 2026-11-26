import fs from "node:fs";

import { loadConfig, type MalahorConfig } from "../core/config";
import { assertHooksAllowed } from "../core/hooks/engine";
import type { HookContext } from "../core/hooks/types";
import { openPortablePackage, writePortablePackage } from "../core/portable-package";
import {
  applyPortableImport,
  capturePortableProjects,
  createPortablePayload,
  parsePortableImportDirectives,
  portableExportHookCommand,
  portableImportHookCommand,
  portableSecretFindings,
  previewPortableExport,
  previewPortableImport,
  validatePortablePayload,
  type PortableExportPreview,
  type PortableImportPreview,
  type PortablePayload,
} from "../core/portable-state";
import { capturePortableMemory } from "../../mnemo/portable-transfer";
import { mnemoHookContext } from "../../mnemo/hook-context";
import { memoryV2Paths } from "../../mnemo/storage";
import type { MemoryOptions } from "./memory";

export interface PortableCommandDependencies {
  config?: MalahorConfig;
  readPassphrase?: (prompt: string) => Buffer;
  now?: () => Date;
  assertHook?: (context: HookContext) => void;
  horielSelected?: boolean;
}

export function runPortableMemory(
  options: MemoryOptions,
  dependencies: PortableCommandDependencies = {},
): void {
  if (dependencies.horielSelected) {
    throw new Error("Portable v1 solo admite el proveedor Mnemo activo; Horiel permanece inactivo y no tiene fallback.");
  }
  if (options.apply && options.dryRun) {
    throw new Error("memory portable no combina --apply con --dry-run.");
  }
  const operation = options.args[0] ?? "help";
  const args = options.args.slice(1);
  const config = dependencies.config ?? loadConfig();
  const readPassphrase = dependencies.readPassphrase ?? readHiddenPassphrase;
  const assertHook = dependencies.assertHook ?? ((context) => { assertHooksAllowed(context); });
  if (operation === "export") {
    runPortableExport(options, args, config, readPassphrase, assertHook, dependencies.now);
    return;
  }
  if (operation === "import") {
    runPortableImport(options, args, config, readPassphrase, assertHook);
    return;
  }
  if (operation === "help" || operation === "--help" || operation === "-h") {
    printPortableHelp();
    return;
  }
  throw new Error(`Operacion portable invalida: ${operation}. Usa export o import.`);
}

export function portableExportHookContext(
  preview: PortableExportPreview,
  config: MalahorConfig,
  approval?: string,
): HookContext {
  return mnemoHookContext("memory.portable.export.apply", "cli", {
    command: portableExportHookCommand(preview),
    approval,
    destructive: false,
    targetPaths: [preview.destination],
    metadata: {
      operation: "memory.portable.export",
      sourceFingerprint: preview.payloadFingerprint,
      destination: preview.destination,
      writesMalahorData: false,
    },
  });
}

export function portableImportHookContext(
  preview: PortableImportPreview,
  config: MalahorConfig,
  packagePath: string,
  approval?: string,
  confirmation?: string,
): HookContext {
  const memory = memoryV2Paths(config.paths.mnemoDb);
  return mnemoHookContext("memory.portable.import.apply", "cli", {
    command: portableImportHookCommand(preview),
    approval,
    confirmation,
    destructive: true,
    targetPaths: [
      packagePath,
      config.paths.projectsFile,
      config.paths.mnemoDb,
      memory.database,
      memory.marker,
      config.paths.backupsDir,
    ],
    metadata: {
      operation: "memory.portable.import",
      previewToken: preview.previewToken,
      packageHash: preview.packageSha256,
      destinationFingerprint: preview.destinationMemoryFingerprint,
      mappingsFingerprint: preview.projects.mappingsFingerprint,
      requiresConfirmation: preview.requiresConfirmation,
      backupRequired: true,
      revalidated: true,
      writesMalahorData: true,
    },
  });
}

function runPortableExport(
  options: MemoryOptions,
  args: string[],
  config: MalahorConfig,
  readPassphrase: (prompt: string) => Buffer,
  assertHook: (context: HookContext) => void,
  now: (() => Date) | undefined,
): void {
  assertArgCount(args, 1, "Uso: malahor-ai memory portable export <archivo.mhpkg> [--apply --yes --confirm <token> --approval <nonce>]");
  const memory = capturePortableMemory(config.paths.mnemoDb, config.projects.aliases);
  const projects = capturePortableProjects(config.paths.projectsFile);
  const payload = createPortablePayload(memory.snapshot, projects.snapshot, (now?.() ?? new Date()).toISOString());
  const findings = portableSecretFindings(payload);
  if (findings.length > 0) {
    throw new Error(`Export portable bloqueado por posibles secretos detectables: ${findings.join(", ")}.`);
  }
  const preview = previewPortableExport(payload, args[0]!, {
    memoryFingerprint: memory.fingerprint,
    projectsFingerprint: projects.fingerprint,
  });
  printExportPreview(preview, payload);
  if (!options.apply) {
    printLine("Preview only: no se creo paquete, backup ni archivo temporal.");
    return;
  }
  assertApplyConfirmation(options, preview.requiresConfirmation);
  const revalidatedMemory = capturePortableMemory(config.paths.mnemoDb, config.projects.aliases);
  const revalidatedProjects = capturePortableProjects(config.paths.projectsFile);
  if (revalidatedMemory.fingerprint !== preview.sourceMemoryFingerprint
    || revalidatedProjects.fingerprint !== preview.sourceProjectsFingerprint) {
    throw new Error("La memoria o projects.json cambiaron desde el preview; repite la operacion.");
  }
  assertHook(portableExportHookContext(preview, config, options.approval));
  const first = readPassphrase("Passphrase del paquete: ");
  const second = readPassphrase("Repite la passphrase: ");
  try {
    if (!first.equals(second)) throw new Error("Las passphrases no coinciden.");
    const descriptor = writePortablePackage(preview.destination, payload, first);
    printLine("Export: paquete cifrado creado y autenticado.");
    printLine(`Destination: ${descriptor.path}`);
    printLine(`Package sha256: ${descriptor.sha256}`);
    printLine(`Bytes: ${descriptor.bytes}`);
  } finally {
    first.fill(0);
    second.fill(0);
  }
}

function runPortableImport(
  options: MemoryOptions,
  args: string[],
  config: MalahorConfig,
  readPassphrase: (prompt: string) => Buffer,
  assertHook: (context: HookContext) => void,
): void {
  if (args.length < 1) {
    throw new Error("Uso: malahor-ai memory portable import <archivo.mhpkg> [map:<origen>=<destino> ...] [replace:<proyecto> ...]");
  }
  const packagePath = args[0]!;
  const directives = parsePortableImportDirectives(args.slice(1));
  const passphrase = readPassphrase("Passphrase del paquete: ");
  try {
    const opened = openPortablePackage<unknown>(packagePath, passphrase);
    const payload = validatePortablePayload(opened.value);
    const previewContext = mnemoHookContext("memory.portable.import.preview", "cli", {
      command: `memory portable import preview ${opened.sha256}`,
      targetPaths: [opened.path],
      metadata: {
        packageHash: opened.sha256,
        writesMalahorData: false,
      },
    });
    assertHook(previewContext);
    const preview = previewPortableImport(payload, {
      packageSha256: opened.sha256,
      directives,
      projectsFile: config.paths.projectsFile,
      legacyMemoryFile: config.paths.mnemoDb,
      malahorHome: config.paths.malahorHome,
    });
    printImportPreview(preview, payload);
    if (!options.apply) {
      printLine("Preview only: no se creo backup, staging, journal ni estado destino.");
      return;
    }
    assertApplyConfirmation(options, preview.requiresConfirmation);
    if (!preview.canApply) throw new Error(preview.blockers.join(" "));

    const reloaded = openPortablePackage<unknown>(opened.path, passphrase);
    const revalidatedPayload = validatePortablePayload(reloaded.value);
    if (reloaded.sha256 !== preview.packageSha256) {
      throw new Error("El paquete cambio desde el preview.");
    }
    const revalidated = previewPortableImport(revalidatedPayload, {
      packageSha256: reloaded.sha256,
      directives,
      projectsFile: config.paths.projectsFile,
      legacyMemoryFile: config.paths.mnemoDb,
      malahorHome: config.paths.malahorHome,
    });
    if (revalidated.previewToken !== preview.previewToken) {
      throw new Error("El paquete, destino o mapping cambio desde el preview.");
    }
    assertHook(portableImportHookContext(
      revalidated,
      config,
      reloaded.path,
      options.approval,
      options.confirm,
    ));
    const result = applyPortableImport({
      packageSha256: reloaded.sha256,
      payload: revalidatedPayload,
      directives,
      projectsFile: config.paths.projectsFile,
      legacyMemoryFile: config.paths.mnemoDb,
      backupsDirectory: config.paths.backupsDir,
      malahorHome: config.paths.malahorHome,
      expectedPreviewToken: revalidated.previewToken,
    });
    printLine("Import: memoria Mnemo SQLite y registro de proyectos publicados.");
    printLine(`Memory sha256: ${result.publishedMemoryFingerprint}`);
    printLine(`Projects sha256: ${result.publishedProjectsFingerprint}`);
    printLine(`Projects changed: ${result.projectsChanged ? "yes" : "no"}`);
    printLine(`Memory backup: ${result.memory.backup.destination ?? "empty source"}`);
    printLine(`Projects backup: ${result.projectsBackup ?? "empty source"}`);
  } finally {
    passphrase.fill(0);
  }
}

function printExportPreview(preview: PortableExportPreview, payload: PortablePayload): void {
  printLine("Portable export preview");
  printLine(`Destination: ${preview.destination}`);
  printLine(`Backend: ${payload.manifest.sourceBackend}`);
  printLine(`Records: observations=${payload.manifest.counts.observations} sessions=${payload.manifest.counts.sessions} pins=${payload.manifest.counts.pins} relations=${payload.manifest.counts.relations}`);
  printLine(`Projects: ${payload.manifest.counts.projects}`);
  printLine(`Plaintext bytes (before compression): ${preview.plaintextBytes}`);
  printLine(`Confirmation: ${preview.requiresConfirmation}`);
}

function printImportPreview(preview: PortableImportPreview, payload: PortablePayload): void {
  printLine("Portable import preview");
  printLine(`Package sha256: ${preview.packageSha256}`);
  printLine(`Source backend: ${payload.manifest.sourceBackend}; destination backend after apply: sqlite`);
  printLine(`Records: observations=${payload.manifest.counts.observations} sessions=${payload.manifest.counts.sessions} pins=${payload.manifest.counts.pins} relations=${payload.manifest.counts.relations}`);
  printLine(`Projects: ${payload.manifest.counts.projects}`);
  for (const decision of preview.projects.decisions) {
    printLine(`Project ${decision.key}: ${decision.disposition}`);
  }
  printLine(`Unmapped paths: ${preview.projects.unmappedPaths.length}`);
  printLine(`Conflicts: ${preview.projects.conflicts.length}`);
  for (const blocker of preview.blockers) printLine(`Blocked: ${blocker}`);
  printLine(`Confirmation: ${preview.requiresConfirmation}`);
}

function assertApplyConfirmation(options: MemoryOptions, expected: string): void {
  if (!options.yes || options.confirm !== expected || !options.approval) {
    throw new Error(`Apply portable requiere --yes --confirm ${expected} --approval <nonce>.`);
  }
}

function assertArgCount(args: string[], count: number, usage: string): void {
  if (args.length !== count) throw new Error(usage);
}

function readHiddenPassphrase(prompt: string): Buffer {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("La passphrase portable requiere un TTY interactivo; no se acepta por argumento ni entorno.");
  }
  process.stdout.write(prompt);
  const bytes: number[] = [];
  const input = Buffer.alloc(8);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  try {
    while (true) {
      const count = fs.readSync(process.stdin.fd, input, 0, input.length, null);
      if (count === 0) throw new Error("TTY cerrado durante la lectura de passphrase.");
      for (const byte of input.subarray(0, count)) {
        if (byte === 3) throw new Error("Lectura de passphrase cancelada.");
        if (byte === 13 || byte === 10) {
          process.stdout.write("\n");
          return Buffer.from(bytes);
        }
        if (byte === 127 || byte === 8) {
          bytes.pop();
          continue;
        }
        if (bytes.length >= 1024) throw new Error("La passphrase excede 1024 bytes.");
        bytes.push(byte);
      }
    }
  } finally {
    input.fill(0);
    process.stdin.setRawMode(wasRaw);
  }
}

function printPortableHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai memory portable export <archivo.mhpkg>
  malahor-ai memory portable export <archivo.mhpkg> --apply --yes --confirm <token> --approval <nonce>
  malahor-ai memory portable import <archivo.mhpkg> [map:<origen>=<destino> ...] [replace:<proyecto> ...]
  malahor-ai memory portable import <archivo.mhpkg> [directivas...] --apply --yes --confirm <token> --approval <nonce>

La passphrase se solicita de forma oculta por TTY y nunca se acepta como argumento o variable de entorno.
`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
