import { describe, expect, test } from "bun:test";
import { SerialQueues } from "../src/queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SerialQueues", () => {
  test("jobs with the same key run one at a time in order", async () => {
    const q = new SerialQueues();
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
    };
    await Promise.all([q.enqueue("c", job("a", 30)).result, q.enqueue("c", job("b", 5)).result]);
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  test("jobs with different keys run in parallel", async () => {
    const q = new SerialQueues();
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`start ${name}`);
      await sleep(20);
    };
    await Promise.all([q.enqueue("x", job("a")).result, q.enqueue("y", job("b")).result]);
    expect(log).toEqual(["start a", "start b"]);
  });

  test("ahead is 0, 1, 2 for three jobs enqueued together", async () => {
    const q = new SerialQueues();
    const jobs = [0, 1, 2].map(() => q.enqueue("c", () => sleep(5)));
    expect(jobs.map((j) => j.ahead)).toEqual([0, 1, 2]);
    await Promise.all(jobs.map((j) => j.result));
    expect(q.enqueue("c", async () => {}).ahead).toBe(0);
  });

  test("a rejected job does not block the next", async () => {
    const q = new SerialQueues();
    const bad = q.enqueue("c", async () => {
      throw new Error("boom");
    });
    const good = q.enqueue("c", async () => "ok");
    await expect(bad.result).rejects.toThrow("boom");
    expect(await good.result).toBe("ok");
  });
});
