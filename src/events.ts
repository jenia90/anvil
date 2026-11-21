import type { RunRecord } from "./store";

export type RunEvent = { repo: string; run: RunRecord };

export class RunEvents {
  private listeners = new Map<string, Set<(e: RunEvent) => void>>();

  publish(e: RunEvent): void {
    const set = this.listeners.get(e.repo);
    for (const fn of [...(set ?? [])]) {
      try {
        fn(e);
      } catch {
        set!.delete(fn); // a dead consumer (closed stream) must not fail the run that published
      }
    }
  }

  subscribe(repo: string, fn: (e: RunEvent) => void): () => void {
    const set = this.listeners.get(repo) ?? new Set();
    set.add(fn);
    this.listeners.set(repo, set);
    return () => void set.delete(fn);
  }
}
