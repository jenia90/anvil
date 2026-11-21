import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, loadConfig } from "../src/config";
import { RunEvents } from "../src/events";
import { bareRepoDir } from "../src/git-remote";
import { type PushDeps, UnknownRepoError, handlePush, parseRefUpdates } from "../src/pushes";
import { SerialQueues } from "../src/queue";
import { Store } from "../src/store";
import { makeFixtureRepo } from "./helpers";

const ZERO = "0".repeat(40);

async function setup(repos: string[] = ["demo"]) {
  const base = await loadConfig(join(import.meta.dir, "fixtures/config.yml"));
  const dataDir = mkdtempSync(join(tmpdir(), "pushes-"));
  const config: Config = {
    ...base,
    dataDir,
    repos: repos.map((name) => ({ name, course: "http-server", language: "rust" })),
  };
  const { bareDir, sha } = await makeFixtureRepo();
  for (const name of repos) {
    mkdirSync(dirname(bareRepoDir(dataDir, name)), { recursive: true });
    cpSync(bareDir, bareRepoDir(dataDir, name), { recursive: true });
  }
  const store = new Store(":memory:");
  const events = new RunEvents();
  const deps: PushDeps = {
    config, store, events, queues: new SerialQueues(), dataDir,
    viewUrl: (repo, i) => `http://x/r/${repo}/${i}`,
  };
  const push = (repo: string, branch = "main", emitted: string[] = []) =>
    handlePush(deps, repo, [{ oldSha: ZERO, newSha: sha, ref: `refs/heads/${branch}` }], (l) => emitted.push(l));
  return { deps, store, events, sha, push };
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) k in saved ? (process.env[k] = saved[k]) : delete process.env[k];
  }
}

describe("handlePush", () => {
  test("first push runs every stage (baseline); later pushes run stages 1..current", async () => {
    const { store, push } = await setup();
    await withEnv({ FAKE_FAIL_AT: "2" }, async () => {
      await push("demo");
      await push("demo");
    });
    expect(store.getRun(1)!.stagesRequested).toEqual(["at4", "ia4", "ih0"]);
    expect(store.getRun(2)!.stagesRequested).toEqual(["at4", "ia4"]);
  });

  test("baseline on a repo failing stage 2 makes stage 2 current and says why", async () => {
    const { store, push } = await setup();
    const out: string[] = [];
    await withEnv({ FAKE_FAIL_AT: "2" }, () => push("demo", "main", out));
    expect(store.getRun(1)!.status).toBe("failed");
    const text = out.join("\n");
    expect(text).toContain("Expected status code 200, got 404");
    expect(text).toContain("Current stage is now 2");
    expect(text).toContain("http://x/r/demo/2");
  });

  test("passing the current stage advances it and the output says so", async () => {
    const { push } = await setup();
    await withEnv({ FAKE_FAIL_AT: "2" }, () => push("demo"));
    const out: string[] = [];
    await push("demo", "main", out);
    expect(out.join("\n")).toContain("Current stage is now 3");
  });

  test("events are published in order queued, building, testing, failed", async () => {
    const { events, push } = await setup();
    const seen: string[] = [];
    events.subscribe("demo", (e) => seen.push(e.run.status));
    await withEnv({ FAKE_FAIL_AT: "2" }, () => push("demo"));
    expect(seen).toEqual(["queued", "building", "testing", "failed"]);
  });

  test("branch deletions and tag refs start no run", async () => {
    const { deps, store, sha } = await setup();
    await handlePush(deps, "demo", [
      { oldSha: sha, newSha: ZERO, ref: "refs/heads/old" },
      { oldSha: ZERO, newSha: sha, ref: "refs/tags/v1" },
    ], () => {});
    expect(store.latestRun("demo")).toBeNull();
  });

  test("two branches in one push make two runs, in order", async () => {
    const { deps, store, sha } = await setup();
    await handlePush(deps, "demo", [
      { oldSha: ZERO, newSha: sha, ref: "refs/heads/a" },
      { oldSha: ZERO, newSha: sha, ref: "refs/heads/b" },
    ], () => {});
    expect([store.getRun(1)!.branch, store.getRun(2)!.branch]).toEqual(["a", "b"]);
    expect(store.getRun(2)!.status).toBe("passed");
  });

  test.each([["demo"], ["demo2"]])("a concurrent push (to %s) of the same course is queued and finishes after", async (second) => {
    const { events, push } = await setup(["demo", "demo2"]);
    const seen: string[] = [];
    for (const name of ["demo", "demo2"]) events.subscribe(name, (e) => seen.push(`${e.run.id}:${e.run.status}`));
    const out: string[] = [];
    await withEnv({ FAKE_DELAY_MS: "80" }, async () => {
      await Promise.all([push("demo"), push(second, "dev", out)]);
    });
    expect(out.join("\n")).toMatch(/queued/i);
    expect(seen.indexOf("1:passed")).toBeLessThan(seen.indexOf("2:building"));
  });

  test("a pusher that disconnects (emit throws) does not fail or orphan the run", async () => {
    const { store, deps, sha } = await setup();
    let lines = 0;
    await withEnv({ FAKE_DELAY_MS: "150" }, () =>
      handlePush(deps, "demo", [{ oldSha: ZERO, newSha: sha, ref: "refs/heads/main" }], () => {
        if (++lines > 3) throw new Error("client gone");
      }),
    );
    const run = store.getRun(1)!;
    expect(run.status).toBe("passed");
    expect(run.testerLog).toContain("[stage-3] ");
    expect(run.stageResults.map((r) => r.status)).toEqual(["passed", "passed", "passed"]);
  });

  test("an unusable repo ends the run as error and handlePush still resolves", async () => {
    const { deps, store } = await setup();
    await handlePush(deps, "demo", [{ oldSha: ZERO, newSha: "f".repeat(40), ref: "refs/heads/main" }], () => {});
    expect(store.getRun(1)!.status).toBe("error");
  });

  test("unknown repo throws UnknownRepoError", async () => {
    const { deps } = await setup();
    await expect(handlePush(deps, "nope", [], () => {})).rejects.toBeInstanceOf(UnknownRepoError);
  });
});

describe("parseRefUpdates", () => {
  test("parses multiple lines and ignores blank lines", () => {
    expect(parseRefUpdates(`aaa bbb refs/heads/main\n\nccc ddd refs/tags/v1\n`)).toEqual([
      { oldSha: "aaa", newSha: "bbb", ref: "refs/heads/main" },
      { oldSha: "ccc", newSha: "ddd", ref: "refs/tags/v1" },
    ]);
  });
});
