import type { Course } from "./course";
import type { RunListItem } from "./store";

export type StageStat = { index: number; name: string; attempts: number; firstPassAt: number | null; timeToPassMs: number | null };

/**
 * Per stage, from runs on main (oldest first): attempts are the runs that requested the stage, up to and including
 * the first one where it passed (build failures count: they had requested it); time to pass is wall-clock from the
 * first attempt to the end of that passing run. Stages never attempted are left out.
 */
export function stageStats(course: Course, mainRuns: RunListItem[]): StageStat[] {
  return course.stages.flatMap((stage) => {
    const tried = mainRuns.filter((r) => r.stagesRequested.includes(stage.slug));
    if (tried.length === 0) return [];
    const passIndex = tried.findIndex((r) => r.results.some((x) => x.stageSlug === stage.slug && x.status === "passed"));
    const firstPassAt = passIndex < 0 ? null : (tried[passIndex].finishedAt ?? null);
    return [{
      index: stage.index, name: stage.name,
      attempts: passIndex < 0 ? tried.length : passIndex + 1,
      firstPassAt,
      timeToPassMs: firstPassAt === null ? null : firstPassAt - tried[0].createdAt,
    }];
  });
}
