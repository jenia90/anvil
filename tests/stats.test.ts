import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCourse } from "../src/course";
import { stageStats } from "../src/stats";
import type { RunListItem } from "../src/store";

const course = loadCourse(join(import.meta.dir, "fixtures/course.yml"));
let nextId = 1;
const item = (
  stagesRequested: string[], results: Record<string, "passed" | "failed">, createdAt: number, finishedAt: number,
  status: RunListItem["status"] = "failed",
): RunListItem => ({
  id: nextId++, repo: "demo", branch: "main", commitSha: "x", status, stagesRequested, createdAt, finishedAt,
  results: Object.entries(results).map(([stageSlug, s]) => ({ stageSlug, status: s })),
});

describe("stageStats", () => {
  test("stageStats counts attempts up to the first pass", () => {
    const runs = [
      item(["at4", "ia4", "ih0"], { at4: "passed", ia4: "failed" }, 100, 110),
      item(["at4", "ia4"], { at4: "passed", ia4: "failed" }, 200, 210),
      item(["at4", "ia4"], { at4: "passed", ia4: "passed" }, 300, 310),
      item(["at4", "ia4", "ih0"], { at4: "passed", ia4: "passed", ih0: "failed" }, 400, 410),
    ];
    const stats = stageStats(course, runs);
    expect(stats.map((s) => [s.index, s.attempts])).toEqual([[1, 1], [2, 3], [3, 2]]);
  });

  test("time to pass is first attempt createdAt to passing finishedAt", () => {
    const runs = [
      item(["at4"], { at4: "failed" }, 1_000, 1_100),
      item(["at4"], { at4: "passed" }, 5_000, 5_400),
    ];
    const [first] = stageStats(course, runs);
    expect(first.firstPassAt).toBe(5_400);
    expect(first.timeToPassMs).toBe(4_400);
  });

  test("build failures count as attempts", () => {
    const runs = [
      item(["at4"], {}, 1_000, 1_100, "build_failed"),
      item(["at4"], { at4: "passed" }, 2_000, 2_100, "passed"),
    ];
    expect(stageStats(course, runs)[0].attempts).toBe(2);
  });

  test("never-passed stage has null time and stages never tried are left out", () => {
    const stats = stageStats(course, [item(["at4"], { at4: "failed" }, 1, 2)]);
    expect(stats).toEqual([{ index: 1, name: "Bind to a port", attempts: 1, firstPassAt: null, timeToPassMs: null }]);
  });
});
