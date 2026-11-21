import type { Config } from "./config";
import type { RunEvents } from "./events";
import { bareRepoDir } from "./git-remote";
import { currentStageIndex, stagesToRun } from "./progress";
import type { SerialQueues } from "./queue";
import { type RunOutcome, executeRun } from "./runner";
import type { RunStatus, Store } from "./store";
import type { TestCase } from "./tester-log";

export type RefUpdate = { oldSha: string; newSha: string; ref: string };
export type PushDeps = {
  config: Config;
  store: Store;
  queues: SerialQueues;
  events: RunEvents;
  dataDir: string;
  viewUrl: (repo: string, stageIndex: number) => string;
};

export class UnknownRepoError extends Error {
  constructor(repo: string) {
    super(`unknown repo: ${repo}`);
  }
}

export function parseRefUpdates(text: string): RefUpdate[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [oldSha, newSha, ref] = l.split(/\s+/);
      return { oldSha, newSha, ref };
    });
}

const BRANCH = "refs/heads/";

export async function handlePush(
  deps: PushDeps,
  repoName: string,
  updates: RefUpdate[],
  rawEmit: (line: string) => void,
): Promise<void> {
  // The pusher may hang up (Ctrl-C) mid-run. The run must carry on and finish: stop writing, never throw.
  let pusherGone = false;
  const emit = (line: string) => {
    if (pusherGone) return;
    try {
      rawEmit(line);
    } catch {
      pusherGone = true;
    }
  };
  const repo = deps.config.repos.find((r) => r.name === repoName);
  if (!repo) throw new UnknownRepoError(repoName);
  const { course, testerPath } = deps.config.courses.get(repo.course)!;
  const { store, events } = deps;

  const publish = (id: number) => events.publish({ repo: repoName, run: store.getRun(id)! });

  const jobs = updates
    .filter((u) => u.ref.startsWith(BRANCH) && !/^0+$/.test(u.newSha))
    .map((u) => {
      const branch = u.ref.slice(BRANCH.length);
      const run = store.createRun(repoName, branch, u.newSha, []);
      publish(run.id);
      const { ahead, result } = deps.queues.enqueue(course.slug, async () => {
        let finished = false;
        try {
          const latest = store.latestStageResults(repoName);
          const before = currentStageIndex(course, latest);
          const stages = stagesToRun(course, latest);
          const cases: TestCase[] = stages.map((s) => ({
            slug: s.slug, prefix: `stage-${s.index}`, title: `Stage #${s.index}: ${s.name}`,
          }));
          store.setStagesRequested(run.id, stages.map((s) => s.slug));
          emit(`Testing ${u.newSha.slice(0, 7)} on ${branch}: ${stages.length} stage(s)`);

          const outcome = await executeRun({
            bareRepoDir: bareRepoDir(deps.dataDir, repoName), sha: u.newSha, testerPath, cases, emit,
            onPhase: (p) => {
              store.setStatus(run.id, p);
              publish(run.id);
            },
          });
          store.finishRun(run.id, outcome);
          finished = true;
          publish(run.id);
          summarize(outcome, before);
        } catch (e) {
          if (!finished) {
            store.finishRun(run.id, {
              status: "error", buildLog: "", testerLog: e instanceof Error ? e.message : String(e), results: [],
            });
            publish(run.id);
          }
          emit(`anvil: run failed unexpectedly: ${e instanceof Error ? e.message : e}`);
        }
      });
      if (ahead > 0) emit(`Queued behind ${ahead} other run(s) for this course; waiting for them to finish...`);
      return result;
    });

  function summarize(outcome: RunOutcome, before: number | null): void {
    const labels: Partial<Record<RunStatus, string>> = {
      build_failed: "✘ Build failed (see the compile output above)",
      error: "✘ The run ended with an error (see the output above)",
    };
    const label = labels[outcome.status];
    if (label) emit(label);
    for (const r of outcome.results) {
      const stage = course.stages.find((s) => s.slug === r.slug)!;
      if (r.status === "passed") emit(`✔ Stage ${stage.index}: ${stage.name}`);
      if (r.status === "failed") emit(`✘ Stage ${stage.index}: ${stage.name} — ${r.failureLine ?? "failed"}`);
    }
    const after = currentStageIndex(course, store.latestStageResults(repoName));
    if (after === null) {
      emit("All stages pass.");
      emit(`View: ${deps.viewUrl(repoName, course.stages.length)}`);
      return;
    }
    const name = course.stages[after - 1].name;
    emit(after !== before ? `Current stage is now ${after}: ${name}` : `Current stage: ${after}: ${name}`);
    emit(`View: ${deps.viewUrl(repoName, after)}`);
  }

  await Promise.all(jobs);
}
