import type { RunRecord, RunStatus } from "./store";

export type RunEvent = { repo: string; run: RunRecord };
/** One line of a run's output, as the pusher sees it. */
export type LogEvent = { repo: string; runId: number; line: string };

export const FINISHED: ReadonlySet<RunStatus> = new Set(["passed", "failed", "build_failed", "error"]);

/** Lines kept per unfinished run for pages that connect mid-run; the stored logs cover finished runs. */
const BUFFER_LINES = 5000;

class Listeners<E extends { repo: string }> {
  private byRepo = new Map<string, Set<(e: E) => void>>();

  emit(e: E): void {
    const set = this.byRepo.get(e.repo);
    for (const fn of [...(set ?? [])]) {
      try {
        fn(e);
      } catch {
        set!.delete(fn); // a dead consumer (closed stream) must not fail the run that published
      }
    }
  }

  add(repo: string, fn: (e: E) => void): () => void {
    const set = this.byRepo.get(repo) ?? new Set();
    set.add(fn);
    this.byRepo.set(repo, set);
    return () => void set.delete(fn);
  }
}

export class RunEvents {
  private runs = new Listeners<RunEvent>();
  private lines = new Listeners<LogEvent>();
  private buffers = new Map<number, LogEvent[]>();

  publish(e: RunEvent): void {
    if (FINISHED.has(e.run.status)) this.buffers.delete(e.run.id);
    this.runs.emit(e);
  }

  subscribe(repo: string, fn: (e: RunEvent) => void): () => void {
    return this.runs.add(repo, fn);
  }

  publishLine(e: LogEvent): void {
    const buffer = this.buffers.get(e.runId) ?? [];
    buffer.push(e);
    if (buffer.length > BUFFER_LINES) buffer.shift();
    this.buffers.set(e.runId, buffer);
    this.lines.emit(e);
  }

  subscribeLines(repo: string, fn: (e: LogEvent) => void): () => void {
    return this.lines.add(repo, fn);
  }

  /** Lines of the repo's unfinished runs, oldest run first. */
  bufferedLines(repo: string): LogEvent[] {
    return [...this.buffers.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, lines]) => lines.filter((l) => l.repo === repo));
  }
}
