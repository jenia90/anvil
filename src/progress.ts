import type { Course, Stage } from "./course";

export type StageStatus = "passed" | "failed";
export type StageView = { stage: Stage; state: "done" | "current" | "upcoming"; lastResult: StageStatus | null };
type Latest = Map<string, StageStatus>;

export function currentStageIndex(course: Course, latest: Latest): number | null {
  const first = course.stages.find((s) => latest.get(s.slug) !== "passed");
  return first ? first.index : null;
}

export function stageViews(course: Course, latest: Latest): StageView[] {
  const current = currentStageIndex(course, latest);
  return course.stages.map((stage) => ({
    stage,
    state: current === null || stage.index < current ? "done" : stage.index === current ? "current" : "upcoming",
    lastResult: latest.get(stage.slug) ?? null,
  }));
}

export function stagesToRun(course: Course, latest: Latest): Stage[] {
  if (latest.size === 0) return course.stages;
  const current = currentStageIndex(course, latest);
  return current === null ? course.stages : course.stages.slice(0, current);
}
