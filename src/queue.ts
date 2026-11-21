export class SerialQueues {
  private tails = new Map<string, Promise<unknown>>();
  private pending = new Map<string, number>();

  enqueue<T>(key: string, job: () => Promise<T>): { ahead: number; result: Promise<T> } {
    const ahead = this.pending.get(key) ?? 0;
    this.pending.set(key, ahead + 1);
    const run = async () => {
      try {
        return await job();
      } finally {
        this.pending.set(key, (this.pending.get(key) ?? 1) - 1);
      }
    };
    const tail = this.tails.get(key) ?? Promise.resolve();
    const result = tail.then(run);
    this.tails.set(key, result.catch(() => {}));
    return { ahead, result };
  }
}
