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
});
