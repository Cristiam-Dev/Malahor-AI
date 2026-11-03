import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CODE_MODE_LIMITS } from "../src/plugin/code-mode-worker";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BUNDLE = path.join(REPO_ROOT, "assets", "opencode", "plugins", "malahor", "index.ts");
let fixtureRoot: string;
let runner: string;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-code-mode-sandbox-"));
  const exportedBundle = path.join(fixtureRoot, "malahor-bundle-api.mjs");
  fs.writeFileSync(
    exportedBundle,
    `${fs.readFileSync(BUNDLE, "utf8")}\nexport { executeCodeModeSandbox };\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  runner = path.join(fixtureRoot, "sandbox-scenario.mjs");
  fs.writeFileSync(runner, nodeScenarioSource(pathToFileURL(exportedBundle).href), { encoding: "utf8", mode: 0o600 });
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("AUTH-01 A4: worker Code Mode real y confinado", () => {
  test("media únicamente las tools descubiertas mediante el RPC cerrado", () => {
    const report = runScenario("success");

    expect(report.error).toBeUndefined();
    expect(report.calls, JSON.stringify(report.output)).toEqual([{
      version: 1,
      type: "call",
      callID: "call_0",
      index: 0,
      tool: "read",
      input: { path: "src/a.ts", offset: 0, limit: 10 },
    }]);
    expect(report.output).toMatchObject({
      result: { ok: true, value: { upper: "ALPHA" } },
      redacted: false,
      truncated: false,
    });
  });

  test("acepta opcionales ausentes y rechaza propiedades desconocidas antes del RPC", () => {
    const report = runScenario("optional-input");

    expect(report.error).toBeUndefined();
    expect(report.output?.result, JSON.stringify(report.output)).toMatchObject({
      ok: true,
      value: { read: "read", glob: "glob", grep: "grep" },
    });
    expect(report.calls).toEqual([
      { tool: "read", input: { path: "src/a.ts" } },
      { tool: "glob", input: { pattern: "src/*.ts" } },
      { tool: "grep", input: { pattern: "alpha" } },
    ]);
    expect(report.unknown.error).toBeUndefined();
    expect(report.unknown.output?.result?.ok, JSON.stringify(report.unknown)).toBe(false);
    expect(report.unknownCalls).toBe(0);
  });

  test("no expone proceso, módulos, eval, red, timers ni tools fuera del catálogo", () => {
    const report = runScenario("escapes");

    expect(report.hostCalls).toBe(0);
    expect(report.attempts).toHaveLength(10);
    for (const attempt of report.attempts as Array<Record<string, any>>) {
      expect(attempt.error, `${attempt.name}: ${JSON.stringify(attempt.output)}`).toBeUndefined();
      expect(attempt.output?.result?.ok, attempt.name).toBe(false);
    }
  }, 35_000);

  test("redacta secretos y descarta claves mágicas antes de devolver al host", () => {
    const report = runScenario("redaction");
    const serialized = JSON.stringify(report.output);

    expect(report.error).toBeUndefined();
    expect(report.output).toMatchObject({
      result: {
        ok: true,
        value: { safe: "visible", prototypePolluted: false },
      },
      redacted: true,
    });
    expect(serialized).not.toContain(report.syntheticValue);
    expect(serialized).not.toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("impone límites de código, llamadas, output por llamada y resultado", () => {
    const report = runScenario("quotas");

    expect(report.codeError).toContain("QUOTA_EXCEEDED");
    expect(report.calls13).toBeLessThanOrEqual(CODE_MODE_LIMITS.maxToolCalls);
    expect(report.thirteen?.result?.ok).toBe(false);
    expect(report.largeCall?.result).toMatchObject({
      ok: false,
      error: { kind: "QUOTA_EXCEEDED" },
    });
    expect(report.largeResult?.result?.ok).toBe(false);
  });

  test("watchdog, cancelación outer y retorno con llamada pendiente terminan y limpian señales hijas", () => {
    const report = runScenario("cleanup", 45_000);

    const loopKind = report.loop.error ?? report.loop.output?.result?.error?.kind;
    expect(loopKind, JSON.stringify(report.loop)).toMatch(/QUOTA_EXCEEDED|Timeout/i);
    expect(report.loop.elapsedMs).toBeLessThan(CODE_MODE_LIMITS.watchdogMs + 5_000);
    expect(report.cancel).toMatchObject({ error: expect.stringContaining("CANCELLED"), childAborted: true });
    expect(report.pending).toMatchObject({ error: expect.stringContaining("SANDBOX_FAILURE"), childAborted: true });
  }, 50_000);
});

function runScenario(name: string, timeout = 30_000): Record<string, any> {
  const result = Bun.spawnSync(["node", "--no-warnings", runner, name, BUNDLE], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH },
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  });
  expect(result.exitCode, `${name}: ${result.stderr.toString()}`).toBe(0);
  return JSON.parse(result.stdout.toString()) as Record<string, any>;
}

function nodeScenarioSource(moduleURL: string): string {
  return `
    import fs from "node:fs";
    import { executeCodeModeSandbox } from ${JSON.stringify(moduleURL)};

    const scenario = process.argv[2];
    const source = fs.readFileSync(process.argv[3], "utf8");
    const executionRef = "exec_aaaaaaaaaaaaaaaaaaaa";
    const base = (code, onCall, tools = ["read"], signal) => executeCodeModeSandbox({
      source, code, executionRef, tools, signal, onCall,
    });
    const capture = async (callback) => {
      try { return { output: await callback() }; }
      catch (error) { return { error: String(error?.message ?? error) }; }
    };

    let report;
    if (scenario === "success") {
      const calls = [];
      const result = await capture(() => base(
        "const text = await tools.repo.read({ path: 'src/a.ts', offset: 0, limit: 10 }); return { upper: text.toUpperCase() };",
        async (message) => { calls.push(message); return { ok: true, value: "alpha" }; },
      ));
      report = { ...result, calls: calls.map(({ executionRef: _ignored, ...call }) => call) };
    } else if (scenario === "optional-input") {
      const calls = [];
      const result = await capture(() => base(
        "const read = await tools.repo.read({ path: 'src/a.ts' }); const glob = await tools.repo.glob({ pattern: 'src/*.ts' }); const grep = await tools.repo.grep({ pattern: 'alpha' }); return { read, glob, grep };",
        async (message) => { calls.push(message); return { ok: true, value: message.tool }; },
        ["read", "glob", "grep"],
      ));
      let unknownCalls = 0;
      const unknown = await capture(() => base(
        "return await tools.repo.read({ path: 'src/a.ts', unexpected: true });",
        async () => { unknownCalls += 1; return { ok: true, value: "unsafe" }; },
      ));
      report = {
        ...result,
        calls: calls.map(({ tool, input }) => ({ tool, input })),
        unknown,
        unknownCalls,
      };
    } else if (scenario === "escapes") {
      let hostCalls = 0;
      const attempts = [
        ["process", "return process.env;"],
        ["global", "return global;"],
        ["require", "return require('node:fs');"],
        ["import", "import fs from 'node:fs'; return fs;"],
        ["eval", "return eval('1 + 1');"],
        ["Function", "return Function('return 1')();"],
        ["fetch", "return await fetch('https://example.invalid');"],
        ["timer", "return setTimeout(() => {}, 1);"],
        ["shell", "return await tools.repo.shell({ command: 'echo no' });"],
        ["write", "return await tools.repo.write({ path: 'x', content: 'no' });"],
      ];
      const outcomes = [];
      for (const [name, code] of attempts) {
        outcomes.push({ name, ...await capture(() => base(code, async () => {
          hostCalls += 1;
          return { ok: true, value: "unexpected" };
        })) });
      }
      report = { attempts: outcomes, hostCalls };
    } else if (scenario === "redaction") {
      const syntheticValue = ["synthetic", "0123456789abcdef"].join("-");
      const credentialName = ["api", "key"].join("_");
      const response = JSON.parse(\`{"safe":"visible","__proto__":{"polluted":true},"credential":"\${credentialName}='\${syntheticValue}'"}\`);
      const result = await capture(() => base(
        "const value = await tools.repo.read({ path: 'src/a.ts', offset: 0, limit: 10 }); return { safe: value.safe, credential: value.credential, prototypePolluted: Object.prototype.polluted === true };",
        async () => ({ ok: true, value: response }),
      ));
      report = { ...result, syntheticValue };
    } else if (scenario === "quotas") {
      const oversized = "x".repeat(${CODE_MODE_LIMITS.codeBytes + 1});
      const codeFailure = await capture(() => base(oversized, async () => ({ ok: true, value: null })));
      let calls13 = 0;
      const statements = Array.from({ length: 13 }, () => "await tools.repo.read({ path: 'src/a.ts', offset: 0, limit: 10 });").join(" ");
      const thirteen = await capture(() => base(\`\${statements} return true;\`, async () => {
        calls13 += 1;
        return { ok: true, value: "ok" };
      }));
      const largeCall = await capture(() => base(
        "return await tools.repo.read({ path: 'src/a.ts', offset: 0, limit: 10 });",
        async () => ({ ok: true, value: "x".repeat(${CODE_MODE_LIMITS.callOutputBytes + 1}) }),
      ));
      const largeResult = await capture(() => base(
        "return 'x'.repeat(70000);",
        async () => ({ ok: true, value: null }),
      ));
      report = {
        codeError: codeFailure.error,
        calls13,
        thirteen: thirteen.output,
        largeCall: largeCall.output,
        largeResult: largeResult.output,
      };
    } else if (scenario === "cleanup") {
      const started = Date.now();
      const loop = await capture(() => base("while (true) {}", async () => ({ ok: true, value: null })));
      const loopReport = { ...loop, elapsedMs: Date.now() - started };

      const controller = new AbortController();
      let cancelChildAborted = false;
      const cancel = await capture(() => base(
        "return await tools.repo.read({ path: 'src/a.ts', offset: 0, limit: 10 });",
        (_message, signal) => new Promise((resolve) => {
          const finish = () => { cancelChildAborted = true; resolve({ ok: false, error: { code: "CANCELLED", message: "cancelled" } }); };
          controller.abort();
          if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
        }),
        ["read"],
        controller.signal,
      ));

      let pendingChildAborted = false;
      const pending = await capture(() => base(
        "tools.repo.read({ path: 'src/a.ts', offset: 0, limit: 10 }); return { done: true };",
        (_message, signal) => new Promise((resolve) => {
          const finish = () => { pendingChildAborted = true; resolve({ ok: false, error: { code: "CANCELLED", message: "cancelled" } }); };
          if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
        }),
      ));
      report = {
        loop: loopReport,
        cancel: { ...cancel, childAborted: cancelChildAborted },
        pending: { ...pending, childAborted: pendingChildAborted },
      };
    } else {
      throw new Error(\`unknown scenario: \${scenario}\`);
    }
    process.stdout.write(JSON.stringify(report));
  `;
}
