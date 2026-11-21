import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestCase, parseTesterLog } from "../src/tester-log";

const raw = readFileSync(join(import.meta.dir, "fixtures/tester-multi.txt"), "utf8");
const cases: TestCase[] = [1, 2, 3].map((n) => ({ slug: `s${n}`, prefix: `stage-${n}`, title: `Stage #${n}` }));

describe("parseTesterLog", () => {
  const results = parseTesterLog(raw, cases);

  test("statuses are passed, failed, not_run", () => {
    expect(results.map((r) => r.status)).toEqual(["passed", "failed", "not_run"]);
    expect(results.map((r) => r.slug)).toEqual(["s1", "s2", "s3"]);
  });

  test("failed case has the failure line without prefix or colour", () => {
    expect(results[1].failureLine).toBe("Expected status code 200, got 404");
  });

  test("failed case log has its own request echo and the interleaved program lines", () => {
    expect(results[1].log).toContain("> GET / HTTP/1.1");
    expect(results[1].log).toContain("[your_program]");
    expect(results[1].log).toContain("handled request");
    expect(results[1].log).not.toContain("Success! Closing connection");
  });

  test("passed case log contains Test passed.", () => {
    expect(results[0].log).toContain("Test passed.");
    expect(results[0].failureLine).toBeNull();
  });

  test("not_run case has empty log and no failure line", () => {
    expect(results[2]).toEqual({ slug: "s3", status: "not_run", log: "", failureLine: null });
  });

  test("garbage or empty input gives all not_run", () => {
    for (const input of ["", "hello\nworld\n"]) {
      expect(parseTesterLog(input, cases).map((r) => r.status)).toEqual(["not_run", "not_run", "not_run"]);
    }
  });

  test("a case that started but has no verdict is failed with no failure line", () => {
    const crashed = parseTesterLog("\x1b[33m[stage-1] \x1b[0mRunning tests for Stage #1\n", cases);
    expect(crashed[0].status).toBe("failed");
    expect(crashed[0].failureLine).toBeNull();
    expect(crashed[1].status).toBe("not_run");
  });
});
