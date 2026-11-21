import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAnvil, packWorkingTree, parseAnvilRemote, parseTestArgs, runTest } from "../src/cli";
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
    expect(findAnvil(join(dir, "src"))).toEqual({ base: "http://127.0.0.1:4300", repo: "demo", root: dir });
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
