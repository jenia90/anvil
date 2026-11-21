import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAnvil, packWorkingTree, parseAnvilRemote, parseSubmitArgs, parseTestArgs, runSubmit, runTest } from "../src/cli";
import { type Config, loadConfig } from "../src/config";
import { RunEvents } from "../src/events";
import { ensureBareRepo, remoteUrl } from "../src/git-remote";
import { SerialQueues } from "../src/queue";
import { startServer } from "../src/server";
import { Store } from "../src/store";
import { git, makeFixtureRepo } from "./helpers";

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

describe("parseAnvilRemote", () => {
  test("finds the base and repo of an anvil remote", () => {
    expect(parseAnvilRemote("http://127.0.0.1:4300/git/redis-rust.git")).toEqual({ base: "http://127.0.0.1:4300", repo: "redis-rust" });
    expect(parseAnvilRemote("https://box.tail1.ts.net/git/shell-go.git/")).toEqual({ base: "https://box.tail1.ts.net", repo: "shell-go" });
  });
  test("ignores other remotes", () => {
    expect(parseAnvilRemote("git@github.com:me/redis.git")).toBeNull();
    expect(parseAnvilRemote("https://github.com/me/redis.git")).toBeNull();
  });
});

describe("parseTestArgs", () => {
  test("reads --stage and --remote", () => {
    expect(parseTestArgs([])).toEqual({});
    expect(parseTestArgs(["--stage", "3", "--remote", "local"])).toEqual({ stage: 3, remote: "local" });
  });
  test("rejects unknown flags, missing values and bad stages", () => {
    expect(() => parseTestArgs(["--nope"])).toThrow();
    expect(() => parseTestArgs(["--stage"])).toThrow();
    expect(() => parseTestArgs(["--stage", "x"])).toThrow();
  });
});

function repoWithRemotes(remotes: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  git(dir, "init", "-q", "-b", "main");
  for (const [name, url] of Object.entries(remotes)) git(dir, "remote", "add", name, url);
  return dir;
}

describe("findAnvil", () => {
  test("picks the only anvil remote, from a subfolder too", () => {
    const dir = repoWithRemotes({ origin: "http://127.0.0.1:4300/git/demo.git", github: "git@github.com:me/x.git" });
    mkdirSync(join(dir, "src"));
    expect(findAnvil(join(dir, "src"))).toEqual({ base: "http://127.0.0.1:4300", repo: "demo", root: dir, remote: "origin" });
  });
  test("explains when there is none, or several without --remote", () => {
    expect(() => findAnvil(repoWithRemotes({ github: "git@github.com:me/x.git" }))).toThrow(/no anvil remote/);
    const two = repoWithRemotes({ a: "http://127.0.0.1:4300/git/one.git", b: "http://127.0.0.1:4300/git/two.git" });
    expect(() => findAnvil(two)).toThrow(/--remote/);
    expect(findAnvil(two, "b").repo).toBe("two");
  });
});

describe("packWorkingTree", () => {
  test("packs tracked, new and unignored files only", async () => {
    const { workDir } = await makeFixtureRepo();
    writeFileSync(join(workDir, ".gitignore"), "target/\n");
    writeFileSync(join(workDir, "gone.txt"), "x");
    git(workDir, "add", "-A");
    git(workDir, "commit", "-q", "-m", "more");
    rmSync(join(workDir, "gone.txt")); // deleted but still tracked
    writeFileSync(join(workDir, "your_program.sh"), "#!/bin/sh\necho changed\n"); // modified
    writeFileSync(join(workDir, "new.txt"), "new"); // untracked, not ignored
    mkdirSync(join(workDir, "target"));
    writeFileSync(join(workDir, "target", "big"), "build output"); // ignored
    const tar = await packWorkingTree(workDir);
    const list = Bun.spawnSync(["tar", "-t"], { stdin: tar }).stdout.toString().trim().split("\n").sort();
    expect(list).toEqual([".codecrafters/compile.sh", ".gitignore", "new.txt", "your_program.sh"]);
  });

  test("a nested repo's build output and .git stay local", async () => {
    const { workDir } = await makeFixtureRepo();
    const nested = join(workDir, "nested");
    mkdirSync(join(nested, "target"), { recursive: true });
    git(nested, "init", "-q");
    writeFileSync(join(nested, "target", "x"), "build output");
    const tar = await packWorkingTree(workDir);
    const list = Bun.spawnSync(["tar", "-t"], { stdin: tar }).stdout.toString();
    expect(list).not.toContain("nested/target");
    expect(list).not.toContain("nested/.git");
  });
});

async function anvil() {
  const base = await loadConfig(join(import.meta.dir, "fixtures/config.yml"));
  const dataDir = mkdtempSync(join(tmpdir(), "cli-anvil-"));
  const config: Config = { ...base, dataDir };
  const store = new Store(":memory:");
  const server = startServer({
    config, store, events: new RunEvents(), queues: new SerialQueues(), dataDir, port: 0, hookToken: "t",
    viewUrl: () => "", catalog: { get: async () => ({ fetchedAt: 0, stale: false, courses: [] }) },
    startCourse: async () => {
      throw new Error("unused");
    },
  });
  stops.push(server.stop);
  ensureBareRepo(dataDir, "demo", server.port, "t");
  return { store, url: remoteUrl(`http://127.0.0.1:${server.port}`, "demo") };
}

describe("runTest", () => {
  test("runTest passes an uncommitted fix and leaves progress alone", async () => {
    const { store, url } = await anvil();
    const { workDir } = await makeFixtureRepo();
    writeFileSync(join(workDir, "fail-at"), "1");
    git(workDir, "add", "-A");
    git(workDir, "commit", "-q", "-m", "broken");
    git(workDir, "remote", "add", "origin", url);
    rmSync(join(workDir, "fail-at")); // the fix, not committed
    const out: string[] = [];
    expect(await runTest({ cwd: workDir, out: (s) => out.push(s) })).toBe(0);
    expect(out.join("")).toContain("Stage 1: Bind to a port");
    const run = store.latestRun("demo")!;
    expect(run.branch).toBe("working tree");
    expect(run.commitSha).toBe(git(workDir, "rev-parse", "HEAD"));
    expect(store.latestStageResults("demo").size).toBe(0);
  });

  test("a failing working tree exits 1", async () => {
    const { url } = await anvil();
    const { workDir } = await makeFixtureRepo();
    git(workDir, "remote", "add", "origin", url);
    writeFileSync(join(workDir, "fail-at"), "1");
    expect(await runTest({ cwd: workDir, out: () => {} })).toBe(1);
  });

  test("refused request exits 2 with the reason", async () => {
    const { url } = await anvil();
    const { workDir } = await makeFixtureRepo();
    git(workDir, "remote", "add", "origin", url);
    const out: string[] = [];
    expect(await runTest({ cwd: workDir, stage: 3, out: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toContain("stage 3 is locked; pass stage 1 first");
  });

  test("a working tree over the upload cap exits 2 with a clear message", async () => {
    const { url } = await anvil();
    const { workDir } = await makeFixtureRepo();
    git(workDir, "remote", "add", "origin", url);
    const out: string[] = [];
    expect(await runTest({ cwd: workDir, out: (s) => out.push(s), uploadCap: 100 })).toBe(2);
    expect(out.join("")).toContain("larger than");
  });

  test("unreachable anvil exits 2", async () => {
    const { workDir } = await makeFixtureRepo();
    git(workDir, "remote", "add", "origin", "http://127.0.0.1:1/git/demo.git");
    const out: string[] = [];
    expect(await runTest({ cwd: workDir, out: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toContain("could not reach anvil");
  });
});

describe("parseSubmitArgs", () => {
  test("reads -m/--message, --stage and --remote", () => {
    expect(parseSubmitArgs([])).toEqual({});
    expect(parseSubmitArgs(["-m", "fix parser", "--stage", "2", "--remote", "local"])).toEqual({
      message: "fix parser", stage: 2, remote: "local",
    });
    expect(parseSubmitArgs(["--message", "x"])).toEqual({ message: "x" });
    expect(() => parseSubmitArgs(["-m"])).toThrow();
    expect(() => parseSubmitArgs(["--nope"])).toThrow();
  });
});

describe("runSubmit", () => {
  async function solution() {
    const env = await anvil();
    const { workDir } = await makeFixtureRepo();
    git(workDir, "remote", "add", "origin", env.url);
    git(workDir, "config", "user.name", "Learner"); // anvil submit commits as the user; tests bring their own identity
    git(workDir, "config", "user.email", "learner@example.com");
    const out: string[] = [];
    const submit = (opts: { stage?: number; message?: string } = {}) =>
      runSubmit({ cwd: workDir, out: (s) => out.push(s), ...opts });
    return { ...env, workDir, out, submit };
  }

  test("submit commits changes and pushes them to main", async () => {
    const { store, workDir, out, submit } = await solution();
    writeFileSync(join(workDir, "new.txt"), "work");
    expect(await submit()).toBe(0);
    expect(git(workDir, "log", "-1", "--format=%s")).toBe("anvil submit");
    expect(git(workDir, "status", "--porcelain")).toBe("");
    const run = store.latestRun("demo")!;
    expect([run.branch, run.commitSha]).toEqual(["main", git(workDir, "rev-parse", "HEAD")]);
    expect(store.latestStageResults("demo").get("at4")).toBe("passed");
    expect(out.join("")).toContain("Stage 1: Bind to a port");
  });

  test("submit uses the given message", async () => {
    const { workDir, submit } = await solution();
    writeFileSync(join(workDir, "new.txt"), "work");
    await submit({ message: "fix the parser" });
    expect(git(workDir, "log", "-1", "--format=%s")).toBe("fix the parser");
  });

  test("a failing submission exits 1", async () => {
    const { workDir, submit } = await solution();
    writeFileSync(join(workDir, "fail-at"), "1");
    expect(await submit()).toBe(1);
  });

  test("a clean tree pushes the current commit without a new one", async () => {
    const { workDir, submit } = await solution();
    const head = git(workDir, "rev-parse", "HEAD");
    expect(await submit()).toBe(0);
    expect(git(workDir, "rev-parse", "HEAD")).toBe(head);
  });

  test("nothing new to submit reports the last result", async () => {
    const { out, submit } = await solution();
    expect(await submit()).toBe(0);
    expect(await submit()).toBe(0);
    expect(out.join("")).toContain("Nothing new to submit");
  });

  test("--stage runs only that stage", async () => {
    const { store, workDir, submit } = await solution();
    writeFileSync(join(workDir, "fail-at"), "2");
    expect(await submit()).toBe(1); // current stage 2
    rmSync(join(workDir, "fail-at"));
    expect(await submit({ stage: 2 })).toBe(0);
    expect(store.latestRun("demo")!.stagesRequested).toEqual(["ia4"]);
  });

  test("a locked stage is refused before anything is committed or pushed", async () => {
    const { store, workDir, out, submit } = await solution();
    const head = git(workDir, "rev-parse", "HEAD");
    writeFileSync(join(workDir, "new.txt"), "work");
    expect(await submit({ stage: 3 })).toBe(2);
    expect(out.join("")).toContain("stage 3 is locked; pass stage 1 first");
    expect(git(workDir, "rev-parse", "HEAD")).toBe(head);
    expect(store.latestRun("demo")).toBeNull();
  });

  test("nothing new with --stage runs that stage on the current commit", async () => {
    const { store, submit } = await solution();
    expect(await submit()).toBe(0); // every stage passes
    expect(await submit({ stage: 2 })).toBe(0);
    const run = store.latestRun("demo")!;
    expect(run.stagesRequested).toEqual(["ia4"]);
    expect(run.status).toBe("passed");
  });

  test("a merge in progress is refused", async () => {
    const { workDir, out, submit } = await solution();
    writeFileSync(join(workDir, "f.txt"), "base\n");
    git(workDir, "add", "-A");
    git(workDir, "commit", "-q", "-m", "base");
    git(workDir, "checkout", "-q", "-b", "side");
    writeFileSync(join(workDir, "f.txt"), "side\n");
    git(workDir, "commit", "-qam", "side");
    git(workDir, "checkout", "-q", "main");
    writeFileSync(join(workDir, "f.txt"), "main\n");
    git(workDir, "commit", "-qam", "main");
    Bun.spawnSync(["git", "merge", "side"], { cwd: workDir }); // conflicts
    const head = git(workDir, "rev-parse", "HEAD");
    expect(await submit()).toBe(2);
    expect(out.join("")).toContain("a merge is in progress");
    expect(git(workDir, "rev-parse", "HEAD")).toBe(head);
  });

  test("a push that fails for another reason gets no pull hint", async () => {
    const { workDir, out, submit } = await solution();
    writeFileSync(join(workDir, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(workDir, "new.txt"), "work");
    expect(await submit()).toBe(2);
    expect(out.join("")).toContain("git push failed");
    expect(out.join("")).not.toContain("pull --rebase");
  });

  test("submit says when anvil is not running", async () => {
    const { workDir } = await makeFixtureRepo();
    git(workDir, "remote", "add", "origin", "http://127.0.0.1:1/git/demo.git");
    const out: string[] = [];
    expect(await runSubmit({ cwd: workDir, out: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toContain("could not reach anvil at http://127.0.0.1:1");
  });

  test("an unknown repo shows anvil's error", async () => {
    const { url } = await anvil();
    const { workDir } = await makeFixtureRepo();
    git(workDir, "remote", "add", "origin", url.replace("/demo.git", "/nope.git"));
    const out: string[] = [];
    expect(await runSubmit({ cwd: workDir, out: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toContain("unknown repo");
  });

  test("a rejected push exits 2", async () => {
    const { url, workDir, submit } = await solution();
    expect(await submit()).toBe(0);
    // Async git: a blocking call would stall the anvil server running in this same process.
    const gitAsync = async (cwd: string, ...args: string[]) => {
      const p = Bun.spawn(["git", "-c", "user.name=o", "-c", "user.email=o@o", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
      expect(await p.exited).toBe(0);
    };
    const other = mkdtempSync(join(tmpdir(), "other-"));
    await gitAsync(other, "clone", "-q", url, "c");
    writeFileSync(join(other, "c", "elsewhere.txt"), "x");
    await gitAsync(join(other, "c"), "add", "-A");
    await gitAsync(join(other, "c"), "commit", "-q", "-m", "from another clone");
    await gitAsync(join(other, "c"), "push", "-q", "origin", "HEAD:main");
    writeFileSync(join(workDir, "mine.txt"), "y");
    const out2: string[] = [];
    expect(await runSubmit({ cwd: workDir, out: (s) => out2.push(s) })).toBe(2);
    expect(out2.join("")).toContain("git pull --rebase");
  });
});
