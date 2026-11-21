import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { type CourseFetcher, loadConfig } from "../src/config";
import { bareRepoDir, hasCommits } from "../src/git-remote";
import { CourseNotFoundError } from "../src/github-courses";
import { SerialQueues } from "../src/queue";
import { StartCourseError, startCourse } from "../src/start-course";
import { git, gitEnv } from "./helpers";

const courseRepo = join(import.meta.dir, "fixtures/course-repo");
const fetchCourse: CourseFetcher = async () => ({ definition: courseRepo, tester: "/fetched/tester" });
const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

/** A stand-in for the app that counts post-receive hook calls. */
function hookCounter() {
  const counter = { calls: 0, port: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (new URL(req.url).pathname.startsWith("/internal/post-receive/")) counter.calls++;
      await req.text();
      return new Response("ok\n");
    },
  });
  counter.port = server.port!;
  stops.push(() => server.stop(true));
  return counter;
}

async function setup(configText = "port: 4300\n# my repos\nrepos:\n") {
  const dir = mkdtempSync(join(tmpdir(), "start-"));
  const path = join(dir, "anvil.yml");
  writeFileSync(path, configText);
  const config = await loadConfig(path, fetchCourse);
  mkdirSync(config.dataDir, { recursive: true });
  const hooks = hookCounter();
  const deps = { config, fetchCourse, queues: new SerialQueues(), port: () => hooks.port, hookToken: "tok" };
  return { dir, path, config, deps, hooks };
}

const errorOf = async (p: Promise<unknown>): Promise<StartCourseError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StartCourseError) return e;
    throw e;
  }
  throw new Error("expected a StartCourseError");
};

describe("startCourse", () => {
  test("seeds the bare repo with one starter commit and registers the repo", async () => {
    const { path, config, deps, hooks } = await setup();
    const made = await startCourse(deps, "redis", "rust");
    expect(made).toEqual({ name: "redis-rust", cloneUrl: `http://127.0.0.1:${hooks.port}/git/redis-rust.git` });

    const bare = bareRepoDir(config.dataDir, "redis-rust");
    expect(git(bare, "log", "--format=%an <%ae>|%s", "main")).toBe("anvil <anvil@localhost>|init");
    expect(hasCommits(config.dataDir, "redis-rust")).toBe(true);
    const clone = join(mkdtempSync(join(tmpdir(), "clone-")), "c");
    git(join(clone, ".."), "clone", "-q", bare, clone);
    expect(statSync(join(clone, "your_program.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(clone, ".codecrafters/run.sh"))).toBe(true);

    expect(config.repos).toEqual([{ name: "redis-rust", course: "redis", language: "rust" }]);
    expect(config.courses.get("redis")!.testerPath).toBe("/fetched/tester");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# my repos");
    expect((load(text) as { repos: unknown[] }).repos).toEqual([{ name: "redis-rust", course: "redis", language: "rust" }]);
  });

  test("seeding fires no hook; a later push does", async () => {
    const { config, deps, hooks } = await setup();
    await startCourse(deps, "redis", "rust");
    expect(hooks.calls).toBe(0);

    const bare = bareRepoDir(config.dataDir, "redis-rust");
    const clone = join(mkdtempSync(join(tmpdir(), "clone-")), "c");
    git(join(clone, ".."), "clone", "-q", bare, clone);
    writeFileSync(join(clone, "src/main.rs"), "fn main() { println!(\"hi\"); }\n");
    const who = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    gitEnv(clone, who, "commit", "-qam", "work");
    // Async: the hook calls the stub server in this process, which must keep serving during the push.
    const push = Bun.spawn(["git", "push", "-q", "origin", "main"], { cwd: clone, stdout: "ignore", stderr: "ignore" });
    expect(await push.exited).toBe(0);
    expect(hooks.calls).toBe(1);
  });

  test("409 when the repo is already configured", async () => {
    const { deps } = await setup("repos:\n  - name: redis-rust\n    course: redis\n    language: rust\n");
    const e = await errorOf(startCourse(deps, "redis", "rust"));
    expect(e.status).toBe(409);
  });

  test("409 when the bare repo already exists, and it is left alone", async () => {
    const { config, deps } = await setup();
    const bare = bareRepoDir(config.dataDir, "redis-rust");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "keep"), "x");
    const e = await errorOf(startCourse(deps, "redis", "rust"));
    expect(e.status).toBe(409);
    expect(readFileSync(join(bare, "keep"), "utf8")).toBe("x");
  });

  test.each([
    ["../x", "rust"],
    ["redis", "Rust"],
    ["redis", ""],
  ])("400 for course %p language %p", async (course, language) => {
    const { deps } = await setup();
    expect((await errorOf(startCourse(deps, course, language))).status).toBe(400);
  });

  test("400 naming available starters for a missing language, and nothing created", async () => {
    const { path, config, deps } = await setup();
    const e = await errorOf(startCourse(deps, "redis", "cobol"));
    expect(e.status).toBe(400);
    expect(e.message).toBe("course redis has no cobol starter (available: go, rust)");
    expect(existsSync(bareRepoDir(config.dataDir, "redis-cobol"))).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("port: 4300\n# my repos\nrepos:\n");
    expect(config.repos).toEqual([]);
  });

  test("a config that cannot take the entry is restored; bare repo removed; not registered", async () => {
    const { path, config, deps } = await setup("repos: []\n");
    await expect(startCourse(deps, "redis", "rust")).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("repos: []\n");
    expect(existsSync(bareRepoDir(config.dataDir, "redis-rust"))).toBe(false);
    expect(config.repos).toEqual([]);
  });

  test("two concurrent starts of the same course and language: one succeeds, one gets 409", async () => {
    const { config, deps } = await setup();
    const results = await Promise.allSettled([startCourse(deps, "redis", "rust"), startCourse(deps, "redis", "rust")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as StartCourseError).status).toBe(409);
    expect(config.repos.length).toBe(1);
  });

  test("404 when the course does not exist", async () => {
    const { deps } = await setup();
    deps.fetchCourse = async () => {
      throw new CourseNotFoundError("nope");
    };
    const e = await errorOf(startCourse(deps, "nope", "rust"));
    expect(e.status).toBe(404);
  });

  test("400 when the downloaded course has another slug", async () => {
    const { deps } = await setup();
    const e = await errorOf(startCourse(deps, "shell", "rust"));
    expect(e.status).toBe(400);
  });

  test("409 when the repo was added to anvil.yml by hand after startup; the file is left alone", async () => {
    const { path, deps } = await setup();
    const text = "repos:\n  - name: redis-rust\n    course: redis\n    language: rust\n";
    writeFileSync(path, text);
    const e = await errorOf(startCourse(deps, "redis", "rust"));
    expect(e.status).toBe(409);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("the clone URL uses the configured url", async () => {
    const { deps } = await setup("url: https://iceman.tail1.ts.net\nrepos:\n");
    expect((await startCourse(deps, "redis", "rust")).cloneUrl).toBe("https://iceman.tail1.ts.net/git/redis-rust.git");
  });
});
