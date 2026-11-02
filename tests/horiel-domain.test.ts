import { describe, expect, test } from "bun:test";

import {
  HORIEL_LIMITS,
  HORIEL_RANKING_VERSION,
  HorielError,
  formatHorielId,
  isHorielId,
  isScopeWithin,
  normalizeTags,
  parseScopePath,
  scopeAncestors,
  tokenizeSearchQuery,
  validateMemoryDraft,
} from "../src/horiel/core";

function expectCode(action: () => unknown, code: string): HorielError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HorielError);
    expect(error).toMatchObject({ code });
    return error as HorielError;
  }
  throw new Error(`Expected HorielError(${code})`);
}

describe("Horiel domain identities", () => {
  test("formats opaque 128-bit identifiers with the approved entity prefixes", () => {
    const entropy = "0123456789abcdef".repeat(2);
    for (const prefix of ["mem", "chk", "rel", "prv", "snp", "store"] as const) {
      const id = formatHorielId(prefix, entropy);
      expect(id).toBe(`${prefix}_${entropy}`);
      expect(isHorielId(id)).toBe(true);
      expect(isHorielId(id, prefix)).toBe(true);
    }

    expect(isHorielId(`mem_${"A".repeat(32)}`)).toBe(false);
    expect(isHorielId(`mem_${"0".repeat(31)}`)).toBe(false);
    expect(isHorielId(`unknown_${"0".repeat(32)}`)).toBe(false);
    expectCode(() => formatHorielId("mem", "0".repeat(31)), "invalid_input");
    expectCode(() => formatHorielId("mem", "A".repeat(32)), "invalid_input");
  });
});

describe("Horiel scope paths", () => {
  test("accepts one to four NFC segments and keeps @global isolated", () => {
    expect(parseScopePath("acme")).toBe("acme");
    expect(parseScopePath("acme/asignacion/HU-17/área")).toBe("acme/asignacion/HU-17/área");
    expect(parseScopePath("@global")).toBe("@global");

    for (const invalid of [
      "",
      " acme",
      "acme ",
      "acme//task",
      "acme/./task",
      "acme/../task",
      "acme\\task",
      "acme/a/b/c/d",
      "@global/project",
      "cafe\u0301",
      `acme/${"😀".repeat(33)}`,
    ]) {
      expectCode(() => parseScopePath(invalid), "invalid_input");
    }
  });

  test("derives ancestors by segments and never admits textual-prefix neighbours", () => {
    expect(scopeAncestors(parseScopePath("cliente/asignacion/HU-17/seguridad"))).toEqual([
      "cliente/asignacion/HU-17",
      "cliente/asignacion",
      "cliente",
    ]);
    expect(scopeAncestors(parseScopePath("cliente"))).toEqual([]);
    expect(scopeAncestors(parseScopePath("@global"))).toEqual([]);

    expect(isScopeWithin("cliente/a/HU-1", "cliente/a")).toBe(true);
    expect(isScopeWithin("cliente/a", "cliente/a")).toBe(true);
    expect(isScopeWithin("cliente/ab", "cliente/a")).toBe(false);
    expect(isScopeWithin("cliente/a", "@global")).toBe(false);
    expect(isScopeWithin("@global", "cliente")).toBe(false);
  });
});

describe("Horiel validation", () => {
  test("normalizes tags deterministically with NFC, lowercase, deduplication and sorting", () => {
    expect(normalizeTags([" ZETA ", "Cafe\u0301", "café", "alpha", "ALPHA"])).toEqual([
      "alpha",
      "café",
      "zeta",
    ]);

    expectCode(() => normalizeTags(Array.from({ length: 21 }, (_, index) => `tag-${index}`)), "invalid_input");
    expectCode(() => normalizeTags(["x".repeat(65)]), "invalid_input");
    expectCode(() => normalizeTags(["line\nbreak"]), "invalid_input");
  });

  test("applies character and UTF-8 byte limits without truncating multibyte content", () => {
    const accepted = validateMemoryDraft({
      scope: "acme/task",
      type: "decision",
      title: "😀".repeat(128),
      content: "😀".repeat(16_384),
      tags: ["UNICODE"],
      idempotencyKey: "request-0001",
    });
    expect(new TextEncoder().encode(accepted.content)).toHaveLength(HORIEL_LIMITS.contentBytes);
    expect(accepted.tags).toEqual(["unicode"]);

    expectCode(() => validateMemoryDraft({
      scope: "acme/task",
      type: "decision",
      title: "😀".repeat(129),
      content: "valid",
      tags: [],
      idempotencyKey: "request-0002",
    }), "invalid_input");
    expectCode(() => validateMemoryDraft({
      scope: "acme/task",
      type: "decision",
      title: "a".repeat(161),
      content: "valid",
      tags: [],
      idempotencyKey: "request-0003",
    }), "invalid_input");
    expectCode(() => validateMemoryDraft({
      scope: "acme/task",
      type: "decision",
      title: "valid",
      content: `${"😀".repeat(16_384)}a`,
      tags: [],
      idempotencyKey: "request-0004",
    }), "invalid_input");
  });

  test("rejects known secret shapes and never echoes the detected value", () => {
    const secret = "sk-live-0123456789abcdefghijklmnop";
    const error = expectCode(() => validateMemoryDraft({
      scope: "acme/security",
      type: "general",
      title: "credential",
      content: `api_key=${secret}`,
      tags: ["security"],
      idempotencyKey: "request-secret-1",
    }), "invalid_input");

    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(`api_key=${secret}`);
  });
});

describe("Horiel literal query contract", () => {
  test("turns operator-looking input into bounded literal terms", () => {
    expect(tokenizeSearchQuery('Alpha OR title:* "beta" alpha')).toEqual([
      "alpha",
      "or",
      "title",
      "beta",
    ]);
    expect(HORIEL_RANKING_VERSION).toBe(1);

    expectCode(() => tokenizeSearchQuery("x".repeat(1_025)), "invalid_input");
    expectCode(
      () => tokenizeSearchQuery(Array.from({ length: 25 }, (_, index) => `term${index}`).join(" ")),
      "invalid_input",
    );
    expectCode(() => tokenizeSearchQuery("x".repeat(65)), "invalid_input");
  });
});
