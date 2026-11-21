import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { executeRun } from "../src/runner";
import type { TestCase } from "../src/tester-log";
import { makeFixtureRepo } from "./helpers";

const fakeTester = join(import.meta.dir, "fixtures/fake-tester.ts");
const cases: TestCase[] = [1, 2, 3].map((n) => ({ slug: `s${n}`, prefix: `stage-${n}`, title: `Stage #${n}` }));

async function run(opts: Parameters<typeof makeFixtureRepo>[0] = {}, env: Record<string, string> = {}, tester = fakeTester, timeoutMs?: number) {
  const { bareDir, sha } = await makeFixtureRepo(opts);
  const lines: string[] = [];
  const phases: string[] = [];
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const outcome = await executeRun({
      bareRepoDir: bareDir, sha, testerPath: tester, cases,
      emit: (l) => lines.push(l), onPhase: (p) => phases.push(p), timeoutMs,
    });
    return { outcome, lines, phases };
  } finally {
    for (const k of Object.keys(env)) k in saved ? (process.env[k] = saved[k]) : delete process.env[k];
  }
}

describe("executeRun", () => {
  test("all stages pass", async () => {
    const { outcome, lines, phases } = await run();
    expect(outcome.status).toBe("passed");
    expect(outcome.results.map((r) => r.status)).toEqual(["passed", "passed", "passed"]);
    expect(phases).toEqual(["building", "testing"]);
    const compileAt = lines.findIndex((l) => l.includes("compiling fixture"));
    const testerAt = lines.findIndex((l) => l.includes("Running tests"));
    expect(compileAt).toBeGreaterThanOrEqual(0);
    expect(compileAt).toBeLessThan(testerAt);
    expect(outcome.buildLog).toContain("compiling fixture");
  });

  test("a failing stage", async () => {
    const { outcome } = await run({}, { FAKE_FAIL_AT: "2" });
    expect(outcome.status).toBe("failed");
    expect(outcome.results.map((r) => r.status)).toEqual(["passed", "failed", "not_run"]);
    expect(outcome.results[1].failureLine).toBe("Expected status code 200, got 404");
  });

  test("compile failure skips the tester", async () => {
    const { outcome, phases } = await run({ compileExit: 1 });
    expect(outcome.status).toBe("build_failed");
    expect(outcome.testerLog).toBe("");
    expect(outcome.results).toEqual([]);
    expect(phases).toEqual(["building"]);
  });

  test("missing compile.sh skips the compile step, as on CodeCrafters", async () => {
    const { outcome } = await run({ omitCompile: true });
    expect(outcome.status).toBe("passed");
    expect(outcome.buildLog).toContain("compile.sh");
  });

  test("sets TESTER_DIR to the tester's directory and copies .codecrafters/run.sh over your_program.sh", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "dump-")), "env.txt");
    await run({ runScript: "#!/bin/sh\necho from-run-sh\n" }, { FAKE_ENV_DUMP: dump });
    const [, , testerDir, program] = readFileSync(dump, "utf8").trim().split("\n");
    expect(testerDir).toBe(join(import.meta.dir, "fixtures"));
    expect(JSON.parse(program)).toBe("#!/bin/sh\necho from-run-sh\n");
  });

  test("the tester gets private grep, pwd and a sudo that never elevates; they are gone after the run", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "dump-")), "shims.txt");
    const { outcome } = await run({}, { FAKE_SHIM_DUMP: dump });
    expect(outcome.status).toBe("passed");
    const [grep, pwd, sudo, sudoExit, sudoUid] = readFileSync(dump, "utf8").split("\n");
    const shimDir = dirname(sudo);
    expect(shimDir).not.toBe("/usr/bin");
    expect(dirname(grep)).toBe(shimDir);
    expect(dirname(pwd)).toBe(shimDir);
    expect(sudoExit).toBe("0");
    expect(sudoUid).toBe(String(process.getuid!()));
    expect(existsSync(shimDir)).toBe(false);
  });

  test("keeps your_program.sh when there is no .codecrafters/run.sh", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "dump-")), "env.txt");
    await run({}, { FAKE_ENV_DUMP: dump });
    const [, , , program] = readFileSync(dump, "utf8").trim().split("\n");
    expect(JSON.parse(program)).toBe("#!/bin/sh\nexit 0\n");
  });

  test("missing tester binary is an error with the spawn error", async () => {
    const { outcome } = await run({}, {}, "/nonexistent/tester");
    expect(outcome.status).toBe("error");
    expect(outcome.testerLog.length).toBeGreaterThan(0);
  });

  test("tester crash is an error", async () => {
    const { outcome } = await run({}, { FAKE_CRASH: "1" });
    expect(outcome.status).toBe("error");
  });

  test("tester gets the checkout as its submission dir and it is removed afterwards", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "dump-")), "env.txt");
    await run({}, { FAKE_ENV_DUMP: dump });
    const [dir, hadCompile] = readFileSync(dump, "utf8").trim().split("\n");
    expect(hadCompile).toBe("true");
    expect(existsSync(dir)).toBe(false);
  });

  test("stored logs are capped at 1 MiB and emit stops after the cap", async () => {
    const compileScript = `#!/bin/sh\nyes "0123456789abcdef0123456789abcdef" | head -c 3000000\nexit 0\n`;
    const { outcome, lines } = await run({ compileScript });
    expect(outcome.buildLog.length).toBeLessThanOrEqual(1024 * 1024 + 64);
    expect(outcome.buildLog).toContain("[log truncated]");
    expect(lines.length).toBeLessThan(40000);
  });

  test("output without newlines is flushed in pieces, so the first MiB is kept and memory stays bounded", async () => {
    const compileScript = `#!/bin/sh\necho start\nhead -c 5000000 /dev/zero | tr '\\0' x\nexit 0\n`;
    const { outcome } = await run({ compileScript });
    expect(outcome.buildLog.startsWith("start\n")).toBe(true);
    expect(outcome.buildLog.length).toBeGreaterThan(500_000);
    expect(outcome.buildLog.length).toBeLessThanOrEqual(1024 * 1024 + 64);
    expect(outcome.buildLog).toContain("[log truncated]");
  });

  test("a compile that never ends is killed after the timeout and ends as error", async () => {
    const started = Date.now();
    const { outcome } = await run({ compileScript: "#!/bin/sh\necho hanging\nsleep 30\n" }, {}, fakeTester, 400);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.status).toBe("error");
    expect(outcome.buildLog).toMatch(/timed out/i);
  });

  test("a tester that never ends is killed after the timeout and ends as error", async () => {
    const started = Date.now();
    const { outcome } = await run({}, { FAKE_HANG: "1" }, fakeTester, 400);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.status).toBe("error");
    expect(outcome.testerLog).toMatch(/timed out/i);
  });

  test("checked-out files get fresh modification times, so build tools never reuse a stale artifact", async () => {
    const compileScript = `#!/bin/sh\necho "mtime=$(stat -c %Y your_program.sh)"\nexit 0\n`;
    const { outcome } = await run({ compileScript, commitDate: "2020-01-01T00:00:00Z" });
    const mtime = Number(/mtime=(\d+)/.exec(outcome.buildLog)![1]);
    expect(Date.now() / 1000 - mtime).toBeLessThan(60);
  });
});
