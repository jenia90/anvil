import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config";
import { RunEvents } from "../src/events";
import { bareRepoDir, ensureBareRepo, remoteUrl } from "../src/git-remote";
import { SerialQueues } from "../src/queue";
import { startServer } from "../src/server";
import { Store } from "../src/store";
import { git, makeFixtureRepo } from "./helpers";

const TOKEN = "test-token";
const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

async function boot() {
  const base = await loadConfig(join(import.meta.dir, "fixtures/config.yml"));
  const dataDir = mkdtempSync(join(tmpdir(), "int-"));
  const config: Config = { ...base, dataDir };
  const store = new Store(":memory:");
  let port = 0;
  const server = startServer({
    config, store, events: new RunEvents(), queues: new SerialQueues(), dataDir, port: 0, hookToken: TOKEN,
    viewUrl: (repo, i) => `http://127.0.0.1:${port}/r/${repo}/${i}`,
    catalog: { get: async () => ({ fetchedAt: 0, stale: false, courses: [] }) },
    startCourse: async () => {
      throw new Error("not used here");
    },
  });
  port = server.port;
  stops.push(server.stop);
  ensureBareRepo(dataDir, "demo", server.port, TOKEN);
  const { workDir } = await makeFixtureRepo();
  return { server, store, dataDir, workDir, url: remoteUrl(`http://127.0.0.1:${server.port}`, "demo") };
}

async function push(workDir: string, url: string, env: Record<string, string> = {}, options: string[] = []) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const p = Bun.spawn(["git", "push", ...options.flatMap((o) => ["-o", o]), url, "HEAD:refs/heads/main"], { cwd: workDir, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    return { stderr, code };
  } finally {
    for (const k of Object.keys(env)) k in saved ? (process.env[k] = saved[k]) : delete process.env[k];
  }
}

describe("ensureBareRepo", () => {
  test("is idempotent and rewrites the hook port", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bare-"));
    ensureBareRepo(dataDir, "demo", 1111, "old-token");
    const dir = ensureBareRepo(dataDir, "demo", 2222, "new-token");
    expect(dir).toBe(bareRepoDir(dataDir, "demo"));
    const hook = join(dir, "hooks/post-receive");
    expect(readFileSync(hook, "utf8")).toContain("127.0.0.1:2222/internal/post-receive/demo");
    expect(readFileSync(hook, "utf8")).not.toContain("1111");
    expect(readFileSync(hook, "utf8")).toContain("new-token");
    expect(readFileSync(hook, "utf8")).not.toContain("old-token");
    expect(statSync(hook).mode & 0o100).not.toBe(0);
    expect(statSync(hook).mode & 0o077).toBe(0);
    expect(git(dir, "config", "http.receivepack")).toBe("true");
    expect(git(dir, "config", "receive.advertisePushOptions")).toBe("true");
  });
});

describe("git push to the app", () => {
  test("prints remote: lines with the stage results", async () => {
    const { workDir, url } = await boot();
    const { stderr, code } = await push(workDir, url);
    expect(code).toBe(0);
    expect(stderr).toContain("remote:");
    expect(stderr).toContain("Stage 1: Bind to a port");
  });

  test("a push is accepted when a stage fails", async () => {
    const { workDir, url, store } = await boot();
    const { stderr, code } = await push(workDir, url, { FAKE_FAIL_AT: "2" });
    expect(code).toBe(0);
    expect(stderr).toContain("Expected status code 200, got 404");
    expect(store.latestRun("demo")!.status).toBe("failed");
  });

  test("a 2 MB binary push works", async () => {
    const { workDir, url, store } = await boot();
    writeFileSync(join(workDir, "big.bin"), crypto.getRandomValues(new Uint8Array(2 * 1024 * 1024)));
    git(workDir, "add", "big.bin");
    git(workDir, "commit", "-q", "-m", "big");
    const { code } = await push(workDir, url);
    expect(code).toBe(0);
    expect(store.latestRun("demo")!.status).toBe("passed");
  });

  test("git push -o stage=1 runs only stage 1", async () => {
    const { workDir, url, store } = await boot();
    const { stderr, code } = await push(workDir, url, {}, ["stage=1"]);
    expect(code).toBe(0);
    expect(stderr).toContain("Stage 1: Bind to a port");
    expect(store.latestRun("demo")!.stagesRequested).toEqual(["at4"]);
  });

  test("a carriage return in a push option does not lose the push", async () => {
    const { workDir, url, store } = await boot();
    const { code } = await push(workDir, url, {}, ["stage=1\r"]);
    expect(code).toBe(0);
    expect(store.latestRun("demo")!.stagesRequested).toEqual(["at4"]);
  });

  test("git push -o stage=9 says no such stage", async () => {
    const { workDir, url, store } = await boot();
    const { stderr, code } = await push(workDir, url, {}, ["stage=9"]);
    expect(code).toBe(0);
    expect(stderr).toContain("anvil: no stage 9 in this course (1–3)");
    expect(store.latestRun("demo")).toBeNull();
  });

  test("server-wired re-run tests the head of main", async () => {
    const { workDir, url, store, server } = await boot();
    const api = `http://127.0.0.1:${server.port}/api/repos/demo/runs`;
    const post = () => fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await post()).status).toBe(409); // nothing pushed yet
    await push(workDir, url);
    const res = await post();
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    while (!["passed", "failed", "build_failed", "error"].includes(store.getRun(runId)!.status)) await Bun.sleep(20);
    const [first, rerun] = [store.getRun(runId - 1)!, store.getRun(runId)!];
    expect(rerun.commitSha).toBe(first.commitSha);
    expect(rerun.branch).toBe("main");
    expect(rerun.status).toBe("passed");
  });

  test("test route runs the uploaded tree", async () => {
    const { workDir, store, server } = await boot();
    const tar = new Uint8Array(Bun.spawnSync(["tar", "-c", "-C", workDir, ".codecrafters", "your_program.sh"]).stdout);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/repos/demo/test`, {
      method: "POST", headers: { "content-type": "application/x-tar", "x-anvil-commit": "b".repeat(40) }, body: tar,
    });
    expect(res.status).toBe(200);
    const runId = Number(res.headers.get("x-anvil-run"));
    const text = await res.text();
    expect(text).toContain("Stage 1: Bind to a port");
    expect(text).toContain("Working tree: tested, but only pushes to main move progress.");
    const run = store.getRun(runId)!;
    expect(run.branch).toBe("working tree");
    expect(run.commitSha).toBe("b".repeat(40));
    expect(run.status).toBe("passed");
    expect(store.latestStageResults("demo").size).toBe(0);
  });

  test("test route needs a tar", async () => {
    const { server } = await boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/repos/demo/test`, { method: "POST", body: "x" });
    expect(res.status).toBe(415);
  });

  test("test route refuses a locked stage", async () => {
    const { server, store } = await boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/repos/demo/test?stage=3`, {
      method: "POST", headers: { "content-type": "application/x-tar" }, body: new Uint8Array(1024),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("stage 3 is locked; pass stage 1 first");
    expect(store.latestRun("demo")).toBeNull();
  });

  test("test route rejects a stage that is not a number", async () => {
    const { server } = await boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/repos/demo/test?stage=abc`, {
      method: "POST", headers: { "content-type": "application/x-tar" }, body: new Uint8Array(1024),
    });
    expect(res.status).toBe(400);
  });

  test("the server listens on 127.0.0.1 only", async () => {
    const { server } = await boot();
    expect(server.hostname).toBe("127.0.0.1");
  });

  test("the hook endpoint 404s for an unknown repo", async () => {
    const { server } = await boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/internal/post-receive/nope`, {
      method: "POST", body: "", headers: { "x-anvil-token": TOKEN },
    });
    expect(res.status).toBe(404);
  });

  test("the hook endpoint refuses a missing or wrong token", async () => {
    const { server, store } = await boot();
    const url = `http://127.0.0.1:${server.port}/internal/post-receive/demo`;
    const body = `${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\n`;
    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    expect((await fetch(url, { method: "POST", body, headers: { "x-anvil-token": "wrong" } })).status).toBe(403);
    expect(store.latestRun("demo")).toBeNull();
  });
});
