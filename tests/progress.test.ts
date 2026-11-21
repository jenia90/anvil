import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCourse } from "../src/course";
import { type StageStatus, currentStageIndex, stageViews, stagesToRun } from "../src/progress";

const course = loadCourse(join(import.meta.dir, "fixtures/course.yml"));
const results = (o: Record<string, StageStatus>) => new Map(Object.entries(o));

describe("currentStageIndex", () => {
  test("is the first stage whose latest result is not a pass", () => {
    expect(currentStageIndex(course, results({ at4: "passed", ia4: "failed" }))).toBe(2);
    expect(currentStageIndex(course, results({ at4: "passed" }))).toBe(2);
    expect(currentStageIndex(course, results({}))).toBe(1);
  });

  test("a regression moves current back", () => {
    expect(currentStageIndex(course, results({ at4: "failed", ia4: "passed", ih0: "passed" }))).toBe(1);
  });

  test("all passed gives null", () => {
    expect(currentStageIndex(course, results({ at4: "passed", ia4: "passed", ih0: "passed" }))).toBeNull();
  });
});

describe("stageViews", () => {
  test("marks done before current, current, upcoming after, with last results", () => {
    const views = stageViews(course, results({ at4: "passed", ia4: "failed" }));
    expect(views.map((v) => v.state)).toEqual(["done", "current", "upcoming"]);
    expect(views.map((v) => v.lastResult)).toEqual(["passed", "failed", null]);
    expect(views[1].stage.slug).toBe("ia4");
  });

  test("everything is done when all passed", () => {
    const views = stageViews(course, results({ at4: "passed", ia4: "passed", ih0: "passed" }));
    expect(views.map((v) => v.state)).toEqual(["done", "done", "done"]);
  });
});

describe("stageViews locked", () => {
  const locked = (o: Record<string, StageStatus>) => stageViews(course, results(o)).map((v) => v.locked);

  test("fresh repo locks everything after stage 1", () => {
    expect(locked({})).toEqual([false, true, true]);
  });

  test("mid-course locks stages after current", () => {
    expect(locked({ at4: "passed", ia4: "failed" })).toEqual([false, false, true]);
  });

  test("regression keeps reached stages unlocked", () => {
    expect(locked({ at4: "failed", ia4: "passed", ih0: "passed" })).toEqual([false, false, false]);
  });

  test("catch-up unlocks every stage with a result", () => {
    expect(locked({ at4: "passed", ia4: "passed", ih0: "failed" })).toEqual([false, false, false]);
  });

  test("nothing is locked when all pass", () => {
    expect(locked({ at4: "passed", ia4: "passed", ih0: "passed" })).toEqual([false, false, false]);
  });
});

describe("stagesToRun", () => {
  test("with no results at all it returns every stage (baseline)", () => {
    expect(stagesToRun(course, results({})).map((s) => s.index)).toEqual([1, 2, 3]);
  });

  test("with results it returns stages 1..current", () => {
    expect(stagesToRun(course, results({ at4: "passed", ia4: "failed" })).map((s) => s.index)).toEqual([1, 2]);
  });

  test("when all passed it returns every stage", () => {
    const all = results({ at4: "passed", ia4: "passed", ih0: "passed" });
    expect(stagesToRun(course, all).map((s) => s.index)).toEqual([1, 2, 3]);
  });
});
