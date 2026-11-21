import { describe, expect, test } from "bun:test";
import { type LogEvent, RunEvents, type RunEvent } from "../src/events";
import { Store } from "../src/store";

const run = (repo: string): RunEvent => ({ repo, run: new Store(":memory:").createRun(repo, "main", "abc", []) });

describe("RunEvents", () => {
  test("subscribers only get events for their repo", () => {
    const events = new RunEvents();
    const got: string[] = [];
    events.subscribe("a", (e) => got.push(e.repo));
    events.publish(run("a"));
    events.publish(run("b"));
    expect(got).toEqual(["a"]);
  });

  test("unsubscribe stops delivery", () => {
    const events = new RunEvents();
    const got: string[] = [];
    const off = events.subscribe("a", (e) => got.push(e.repo));
    events.publish(run("a"));
    off();
    events.publish(run("a"));
    expect(got).toEqual(["a"]);
  });

  test("a throwing listener neither stops the others nor breaks publish, and is dropped", () => {
    const events = new RunEvents();
    const got: string[] = [];
    let calls = 0;
    events.subscribe("a", () => {
      calls++;
      throw new Error("closed stream");
    });
    events.subscribe("a", (e) => got.push(e.repo));
    expect(() => events.publish(run("a"))).not.toThrow();
    events.publish(run("a"));
    expect(got).toEqual(["a", "a"]);
    expect(calls).toBe(1);
  });
});

describe("RunEvents log lines", () => {
  const line = (repo: string, runId: number, text: string): LogEvent => ({ repo, runId, line: text });
  const finished = (repo: string, id: number): RunEvent => {
    const r = run(repo);
    return { repo, run: { ...r.run, id, status: "passed" } };
  };

  test("lines reach line subscribers of their repo only", () => {
    const events = new RunEvents();
    const got: string[] = [];
    events.subscribeLines("a", (e) => got.push(e.line));
    events.publishLine(line("a", 1, "one"));
    events.publishLine(line("b", 2, "two"));
    expect(got).toEqual(["one"]);
  });

  test("bufferedLines returns lines of unfinished runs in order", () => {
    const events = new RunEvents();
    events.publishLine(line("a", 2, "second-run"));
    events.publishLine(line("a", 1, "first-run 1"));
    events.publishLine(line("b", 3, "other repo"));
    events.publishLine(line("a", 1, "first-run 2"));
    expect(events.bufferedLines("a").map((e) => e.line)).toEqual(["first-run 1", "first-run 2", "second-run"]);
  });

  test("publishing a finished run drops its buffer", () => {
    const events = new RunEvents();
    events.publishLine(line("a", 7, "x"));
    events.publish(finished("a", 7));
    expect(events.bufferedLines("a")).toEqual([]);
  });

  test("buffer keeps the newest 5000 lines", () => {
    const events = new RunEvents();
    for (let i = 1; i <= 5001; i++) events.publishLine(line("a", 1, `line ${i}`));
    const buffered = events.bufferedLines("a");
    expect(buffered.length).toBe(5000);
    expect(buffered[0].line).toBe("line 2");
  });

  test("a throwing line subscriber is removed", () => {
    const events = new RunEvents();
    let calls = 0;
    events.subscribeLines("a", () => {
      calls++;
      throw new Error("closed stream");
    });
    expect(() => events.publishLine(line("a", 1, "x"))).not.toThrow();
    events.publishLine(line("a", 1, "y"));
    expect(calls).toBe(1);
  });
});
