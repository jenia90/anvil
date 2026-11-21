import { describe, expect, test } from "bun:test";
import { RunEvents, type RunEvent } from "../src/events";
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
