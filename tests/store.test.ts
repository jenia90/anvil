import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseResult } from "../src/tester-log";
import { Store } from "../src/store";

const result = (slug: string, status: CaseResult["status"], failureLine: string | null = null): CaseResult => ({
  slug, status, log: `log ${slug}`, failureLine,
});
const finish = (store: Store, id: number, results: CaseResult[], status: "passed" | "failed" = "failed") =>
  store.finishRun(id, { status, buildLog: "build", testerLog: "tester", results });

describe("Store", () => {
  test("createRun starts queued with increasing ids", () => {
    const store = new Store(":memory:");
    const a = store.createRun("demo", "main", "abc1234", ["at4"]);
    const b = store.createRun("demo", "main", "def5678", ["at4", "ia4"]);
    expect(a.status).toBe("queued");
    expect(b.id).toBe(a.id + 1);
    expect(b.stagesRequested).toEqual(["at4", "ia4"]);
    expect(a.finishedAt).toBeNull();
  });

  test("finishRun stores status, logs and only passed/failed stage results", () => {
    const store = new Store(":memory:");
    const run = store.createRun("demo", "main", "abc1234", ["at4", "ia4", "ih0"]);
    finish(store, run.id, [result("at4", "passed"), result("ia4", "failed", "got 404"), result("ih0", "not_run")]);
    const got = store.getRun(run.id)!;
    expect(got.status).toBe("failed");
    expect(got.buildLog).toBe("build");
    expect(got.testerLog).toBe("tester");
    expect(got.finishedAt).not.toBeNull();
    expect(got.stageResults.map((r) => [r.stageSlug, r.status, r.failureLine])).toEqual([
      ["at4", "passed", null],
      ["ia4", "failed", "got 404"],
    ]);
  });

  test("latestStageResults takes the newest result per stage", () => {
    const store = new Store(":memory:");
    const r1 = store.createRun("demo", "main", "a", []);
    finish(store, r1.id, [result("at4", "passed"), result("ia4", "failed")]);
    const r2 = store.createRun("demo", "main", "b", []);
    finish(store, r2.id, [result("at4", "failed"), result("ia4", "passed")]);
    expect([...store.latestStageResults("demo")]).toEqual([["at4", "failed"], ["ia4", "passed"]]);
  });

  test("latestStageResults ignores branches other than main", () => {
    const store = new Store(":memory:");
    const r1 = store.createRun("demo", "main", "a", []);
    finish(store, r1.id, [result("at4", "failed")]);
    const r2 = store.createRun("demo", "feature", "b", []);
    finish(store, r2.id, [result("at4", "passed"), result("ia4", "passed")]);
    expect([...store.latestStageResults("demo")]).toEqual([["at4", "failed"]]);
  });

  test("latestStageResults ignores other repos", () => {
    const store = new Store(":memory:");
    const other = store.createRun("other", "main", "a", []);
    finish(store, other.id, [result("at4", "passed")]);
    expect(store.latestStageResults("demo").size).toBe(0);
  });

  test("latestRun returns the newest run of that repo", () => {
    const store = new Store(":memory:");
    const a = store.createRun("demo", "main", "a", []);
    store.createRun("other", "main", "b", []);
    const c = store.createRun("demo", "dev", "c", []);
    expect(store.latestRun("demo")!.id).toBe(c.id);
    expect(store.latestRun("demo")!.branch).toBe("dev");
    expect(a.id).toBeLessThan(c.id);
    expect(store.latestRun("nobody")).toBeNull();
  });

  test("setStagesRequested replaces the stages list", () => {
    const store = new Store(":memory:");
    const run = store.createRun("demo", "main", "a", []);
    store.setStagesRequested(run.id, ["at4", "ia4"]);
    expect(store.getRun(run.id)!.stagesRequested).toEqual(["at4", "ia4"]);
  });

  test("setStatus updates the status", () => {
    const store = new Store(":memory:");
    const run = store.createRun("demo", "main", "a", []);
    store.setStatus(run.id, "building");
    expect(store.getRun(run.id)!.status).toBe("building");
  });

  test("failInterruptedRuns turns queued, building and testing into error and counts them", () => {
    const store = new Store(":memory:");
    const q = store.createRun("demo", "main", "a", []);
    const b = store.createRun("demo", "main", "b", []);
    store.setStatus(b.id, "building");
    const t = store.createRun("demo", "main", "c", []);
    store.setStatus(t.id, "testing");
    const done = store.createRun("demo", "main", "d", []);
    finish(store, done.id, [result("at4", "passed")], "passed");
    expect(store.failInterruptedRuns()).toBe(3);
    expect([q, b, t, done].map((r) => store.getRun(r.id)!.status)).toEqual(["error", "error", "error", "passed"]);
  });

  test("data survives reopening a file-backed store", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "cc.sqlite");
    const first = new Store(path);
    const run = first.createRun("demo", "main", "a", ["at4"]);
    finish(first, run.id, [result("at4", "passed")], "passed");
    const second = new Store(path);
    expect(second.getRun(run.id)!.status).toBe("passed");
    expect(second.latestStageResults("demo").get("at4")).toBe("passed");
  });

  test("listRuns pages newest first with results", () => {
    const store = new Store(":memory:");
    for (let i = 0; i < 5; i++) finish(store, store.createRun("demo", "main", `c${i}`, ["at4"]).id, [result("at4", "passed")]);
    store.createRun("other", "main", "z", []);
    const first = store.listRuns("demo", { limit: 2 });
    expect(first.runs.map((r) => r.id)).toEqual([5, 4]);
    expect(first.more).toBe(true);
    expect(first.runs[0].results).toEqual([{ stageSlug: "at4", status: "passed" }]);
    expect((first.runs[0] as Record<string, unknown>).testerLog).toBeUndefined();
    const next = store.listRuns("demo", { before: 4, limit: 3 });
    expect(next.runs.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(next.more).toBe(false);
  });

  test("runTimes for one repo and all", () => {
    const store = new Store(":memory:");
    const a = store.createRun("demo", "main", "a", []);
    const b = store.createRun("other", "dev", "b", []);
    expect(store.runTimes("demo")).toEqual([a.createdAt]);
    expect(store.runTimes()).toEqual([a.createdAt, b.createdAt]);
  });

  test("runCounts counts finished and passed", () => {
    const store = new Store(":memory:");
    finish(store, store.createRun("demo", "main", "a", []).id, [], "passed");
    finish(store, store.createRun("demo", "x", "b", []).id, [], "failed");
    store.createRun("demo", "main", "c", []);
    expect(store.runCounts("demo")).toEqual({ total: 3, finished: 2, passed: 1 });
  });

  test("mainRuns lists main runs oldest first", () => {
    const store = new Store(":memory:");
    const a = store.createRun("demo", "main", "a", []);
    store.createRun("demo", "feature", "b", []);
    const c = store.createRun("demo", "main", "c", []);
    expect(store.mainRuns("demo").map((r) => r.id)).toEqual([a.id, c.id]);
  });

  test("lastPassingCommit finds the newest earlier main pass", () => {
    const store = new Store(":memory:");
    finish(store, store.createRun("demo", "main", "old", []).id, [result("at4", "passed")]);
    finish(store, store.createRun("demo", "main", "newer", []).id, [result("at4", "passed")]);
    finish(store, store.createRun("demo", "feature", "branch", []).id, [result("at4", "passed")]);
    const failing = store.createRun("demo", "main", "bad", []);
    finish(store, failing.id, [result("at4", "failed")]);
    finish(store, store.createRun("demo", "main", "later", []).id, [result("at4", "passed")]);
    expect(store.lastPassingCommit("demo", "at4", failing.id)).toBe("newer");
    expect(store.lastPassingCommit("demo", "ia4", failing.id)).toBeNull();
  });

  test("mainRuns stays fast for a long course history", () => {
    const store = new Store(":memory:");
    const slugs = Array.from({ length: 60 }, (_, i) => `s${i}`);
    for (let i = 0; i < 3000; i++) {
      const run = store.createRun("demo", "main", `c${i}`, slugs);
      finish(store, run.id, slugs.map((s) => result(s, "passed")));
    }
    const start = performance.now();
    const runs = store.mainRuns("demo");
    expect(performance.now() - start).toBeLessThan(500);
    expect(runs.length).toBe(3000);
    expect(runs[2999].results.length).toBe(60);
  });
});
