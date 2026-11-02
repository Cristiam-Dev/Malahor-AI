import { randomBytes } from "node:crypto";

import { invalidInput } from "./errors";

export const HORIEL_ID_PREFIXES = ["mem", "chk", "rel", "prv", "snp", "store"] as const;

export type HorielIdPrefix = typeof HORIEL_ID_PREFIXES[number];

export interface HorielIdFactory {
  create(prefix: string): string;
}

const ID_PATTERN = /^(mem|chk|rel|prv|snp|store)_[a-f0-9]{32}$/;

export function formatHorielId(prefix: HorielIdPrefix, entropy: string): string {
  if (!HORIEL_ID_PREFIXES.includes(prefix) || !/^[a-f0-9]{32}$/.test(entropy)) {
    return invalidInput("Horiel identity entropy must be 128-bit lowercase hexadecimal.");
  }
  return `${prefix}_${entropy}`;
}

export function isHorielId(value: unknown, prefix?: HorielIdPrefix): value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return false;
  return prefix === undefined || value.startsWith(`${prefix}_`);
}

export function assertHorielId(value: unknown, prefix?: HorielIdPrefix): string {
  if (!isHorielId(value, prefix)) return invalidInput("Horiel identity is invalid.");
  return value;
}

export function createCryptoIdFactory(): HorielIdFactory {
  return {
    create(prefix: string): string {
      if (!HORIEL_ID_PREFIXES.includes(prefix as HorielIdPrefix)) {
        return invalidInput("Horiel identity prefix is invalid.");
      }
      return formatHorielId(prefix as HorielIdPrefix, randomBytes(16).toString("hex"));
    },
  };
}

export function nextHorielId(factory: HorielIdFactory, prefix: HorielIdPrefix): string {
  const value = factory.create(prefix);
  return assertHorielId(value, prefix);
}
