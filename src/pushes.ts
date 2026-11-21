import type { Config } from "./config";
import type { Course } from "./course";
import type { RunEvents } from "./events";
import { bareRepoDir } from "./git-remote";
import { type StageStatus, currentStageIndex, stageViews, stagesToRun } from "./progress";
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

/** A run request the learner can fix: a bad stage number (400) or a stage not reached yet (409). */
export class RunRequestError extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
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

/** Throws unless `stage` names a stage of the course that is not locked by `latest` (progress on main). */
export function checkStage(course: Course, latest: Map<string, StageStatus>, stage: number): void {
  if (!Number.isInteger(stage)) throw new RunRequestError("stage must be a whole number", 400);
  const view = stageViews(course, latest).find((v) => v.stage.index === stage);
  if (!view) throw new RunRequestError(`no stage ${stage} in this course (1–${course.stages.length})`, 400);
  if (view.locked) {
    throw new RunRequestError(`stage ${stage} is locked; pass stage ${currentStageIndex(course, latest)} first`, 409);
  }
}

const BRANCH = "refs/heads/";
/** The branch recorded for `anvil test` runs: the learner's uncommitted files, never progress. */
export const WORKING_TREE = "working tree";

/**
 * Starts one run of `sha`: every stage up to the current one, or only `stage`. Throws (creating nothing) when the
 * repo or the stage is not valid. `emit` reaches the pusher's terminal; every line is also published as live log.
 */
export function startRun(
  deps: PushDeps,
  repoName: string,
  req: { branch: string; sha: string; stage?: number; archive?: string },
  rawEmit: (line: string) => void,
): { runId: number; done: Promise<void> } {
  const repo = deps.config.repos.find((r) => r.name === repoName);
  if (!repo) throw new UnknownRepoError(repoName);
  const { course, testerPath } = deps.config.courses.get(repo.course)!;
  const { store, events } = deps;
  if (req.stage !== undefined) checkStage(course, store.latestStageResults(repoName), req.stage);

  const run = store.createRun(repoName, req.branch, req.sha, []);
  // The pusher may hang up (Ctrl-C) mid-run. The run must carry on and finish: stop writing, never throw.
  let pusherGone = false;
  const toPusher = (line: string) => {
    if (pusherGone) return;
    try {
      rawEmit(line);
    } catch {
      pusherGone = true;
    }
  };
  const emit = (line: string) => {
    events.publishLine({ repo: repoName, runId: run.id, line });
    toPusher(line);
  };
  const publish = () => events.publish({ repo: repoName, run: store.getRun(run.id)! });
  const fail = (message: string) => {
    store.finishRun(run.id, { status: "error", buildLog: "", testerLog: message, results: [] });
    publish();
  };
  publish();

  const { ahead, result } = deps.queues.enqueue(course.slug, async () => {
    let finished = false;
    try {
      const latest = store.latestStageResults(repoName);
      if (req.stage !== undefined) {
        // A run queued ahead may have moved the current stage back since the request was accepted.
        try {
          checkStage(course, latest, req.stage);
        } catch (e) {
          if (!(e instanceof RunRequestError)) throw e;
          emit(`anvil: ${e.message}`);
          finished = true;
          fail(e.message);
          return;
        }
      }
      const before = currentStageIndex(course, latest);
      const stages = req.stage !== undefined ? [course.stages[req.stage - 1]] : stagesToRun(course, latest);
      const cases: TestCase[] = stages.map((s) => ({
        slug: s.slug, prefix: `stage-${s.index}`, title: `Stage #${s.index}: ${s.name}`,
      }));
      store.setStagesRequested(run.id, stages.map((s) => s.slug));
      emit(`Testing ${req.sha.slice(0, 7)} on ${req.branch}: ${stages.length} stage(s)`);

      const outcome = await executeRun({
        bareRepoDir: bareRepoDir(deps.dataDir, repoName), sha: req.sha, archive: req.archive, testerPath, cases, emit,
        onPhase: (p) => {
          store.setStatus(run.id, p);
          publish();
        },
      });
      store.finishRun(run.id, outcome);
      finished = true;
      // Summary before the finished event: pages show these lines in the live log before switching to the result.
      // The finished event goes out even if the summary fails, or open pages would show the run as running forever.
      try {
        summarize(outcome, before);
      } finally {
        publish();
      }
    } catch (e) {
      // After the finished event a published line would start a buffer nothing ever drops: tell only the pusher.
      (finished ? toPusher : emit)(`anvil: run failed unexpectedly: ${e instanceof Error ? e.message : e}`);
      if (!finished) fail(e instanceof Error ? e.message : String(e));
    }
  });
  if (ahead > 0) emit(`Queued behind ${ahead} other run(s) for this course; waiting for them to finish...`);

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
    if (req.branch === WORKING_TREE) emit("Working tree: tested, but only pushes to main move progress.");
    else if (req.branch !== "main") emit(`Branch ${req.branch}: tested, but only pushes to main move progress.`);
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

  return { runId: run.id, done: result };
}

/** Parses push options: `stage=N` (the last one wins); anything else is reported and ignored. */
function parseOptions(options: string[], emit: (line: string) => void): { stage?: number } {
  let stage: number | undefined;
  for (const option of options) {
    const m = /^stage=(.*)$/.exec(option);
    if (!m) emit(`anvil: ignoring unknown push option ${option}`);
    else stage = /^\d+$/.test(m[1]) ? Number(m[1]) : Number.NaN;
  }
  return { stage };
}

export async function handlePush(
  deps: PushDeps,
  repoName: string,
  updates: RefUpdate[],
  rawEmit: (line: string) => void,
  options: string[] = [],
): Promise<void> {
  let pusherGone = false;
  const emit = (line: string) => {
    if (pusherGone) return;
    try {
      rawEmit(line);
    } catch {
      pusherGone = true;
    }
  };
  if (!deps.config.repos.some((r) => r.name === repoName)) throw new UnknownRepoError(repoName);
  const { stage } = parseOptions(options, emit);
  const branches = updates.filter((u) => u.ref.startsWith(BRANCH) && !/^0+$/.test(u.newSha));
  const runs: Promise<void>[] = [];
  for (const u of branches) {
    try {
      runs.push(startRun(deps, repoName, { branch: u.ref.slice(BRANCH.length), sha: u.newSha, stage }, emit).done);
    } catch (e) {
      if (!(e instanceof RunRequestError)) throw e;
      emit(`anvil: ${e.message}`); // the push is accepted (post-receive cannot refuse it), but nothing runs
      break;
    }
  }
  await Promise.all(runs);
}
