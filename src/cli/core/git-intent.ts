import { createHash, randomUUID } from "node:crypto";
import type { GitOperation } from "./git-command-policy";

export const GIT_INTENTS = [
  "stage",
  "commit",
  "amend",
  "reset",
  "rebase",
  "cherry-pick",
  "merge",
  "branch-create",
  "branch-switch",
] as const;

export type GitIntent = typeof GIT_INTENTS[number];

export interface GitIntentRegistration {
  project: string;
  intent: GitIntent;
  command: string;
  paths?: string[];
  now?: number;
}

export interface GitIntentConsumption {
  project: string;
  operation: GitOperation;
  command: string;
  paths?: string[];
  now?: number;
}

export interface GitIntentEvidence extends GitIntentRegistration {
  id: string;
  commandHash: string;
  paths: string[];
  createdAt: number;
  expiresAt: number;
}

export interface GitIntentRegistry {
  register(input: GitIntentRegistration): GitIntentEvidence;
  match(input: GitIntentConsumption): GitIntentEvidence | undefined;
  consume(input: GitIntentConsumption): GitIntentEvidence | undefined;
  clearExpired(now?: number): number;
}

export function parseGitIntent(value: unknown): GitIntent | undefined {
  return typeof value === "string" && GIT_INTENTS.includes(value as GitIntent)
    ? value as GitIntent
    : undefined;
}

export function intentAuthorizes(intent: GitIntent, operation: GitOperation): boolean {
  if (intent === "commit") return operation === "stage" || operation === "commit";
  if (intent === "branch-create") return operation === "branch-create" || operation === "branch-switch";
  return intent === operation;
}

export function createGitIntentRegistry(options: { ttlMs?: number } = {}): GitIntentRegistry {
  const ttlMs = options.ttlMs ?? 120_000;
  const records = new Map<string, GitIntentEvidence>();

  return {
    register(input) {
      const now = input.now ?? Date.now();
      const evidence: GitIntentEvidence = {
        ...input,
        id: randomUUID(),
        commandHash: commandHash(input.command),
        paths: normalizedPaths(input.paths),
        createdAt: now,
        expiresAt: now + ttlMs,
      };
      records.set(evidence.id, evidence);
      return evidence;
    },
    match(input) {
      return findEvidence(records, input, false);
    },
    consume(input) {
      return findEvidence(records, input, true);
    },
    clearExpired(now = Date.now()) {
      let removed = 0;
      for (const [id, evidence] of records) {
        if (evidence.expiresAt >= now) continue;
        records.delete(id);
        removed += 1;
      }
      return removed;
    },
  };
}

function findEvidence(
  records: Map<string, GitIntentEvidence>,
  input: GitIntentConsumption,
  consume: boolean,
): GitIntentEvidence | undefined {
  const now = input.now ?? Date.now();
  for (const [id, evidence] of records) {
    if (evidence.expiresAt < now) {
      records.delete(id);
      continue;
    }
    if (evidence.project !== input.project) continue;
    if (!intentAuthorizes(evidence.intent, input.operation)) continue;
    if (evidence.commandHash !== commandHash(input.command)) continue;
    if (!samePaths(evidence.paths, normalizedPaths(input.paths))) continue;
    if (consume) records.delete(id);
    return evidence;
  }
  return undefined;
}

function commandHash(command: string): string {
  return createHash("sha256").update(command.trim()).digest("hex");
}

function normalizedPaths(paths: string[] | undefined): string[] {
  return [...new Set((paths ?? []).filter((value) => value.length > 0))].sort();
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
