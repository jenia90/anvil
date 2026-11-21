import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CourseNotFoundError, courseDir, ensureCourse } from "../src/github-courses";

const courseRepoFixture = join(import.meta.dir, "fixtures/course-repo");

/** A .tar.gz of `files` at its top level, like a tester release asset. */
function tarball(files: Record<string, string>): Blob {
  const top = mkdtempSync(join(tmpdir(), "tarball-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(top, path, ".."), { recursive: true });
    writeFileSync(join(top, path), body);
  }
  const p = Bun.spawnSync(["tar", "-cz", "-C", top, ...Object.keys(files)]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return new Blob([new Uint8Array(p.stdout)]);
}

/** GitHub's source tarball: everything under one top folder, including files anvil must not keep. */
function courseTarball(): Blob {
  const root = mkdtempSync(join(tmpdir(), "src-"));
  const top = join(root, "build-your-own-redis-abc123");
  cpSync(courseRepoFixture, top, { recursive: true });
  writeFileSync(join(top, "README.md"), "not needed");
  mkdirSync(join(top, "compiled_starters/rust/.codecrafters"), { recursive: true });
  writeFileSync(join(top, "compiled_starters/rust/.codecrafters/compile.sh"), "cargo build");
  mkdirSync(join(top, "solutions/rust"), { recursive: true });
  writeFileSync(join(top, "solutions/rust/main.rs"), "fn main() {}");
  const p = Bun.spawnSync(["tar", "-cz", "-C", root, "build-your-own-redis-abc123"]);
  return new Blob([new Uint8Array(p.stdout)]);
}

type Fake = { requests: string[]; fetch: typeof fetch; tag: string; fail: boolean };

function fakeGitHub(tag = "v7"): Fake {
  const fake: Fake = { requests: [], tag, fail: false, fetch: undefined as unknown as typeof fetch };
  fake.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fake.requests.push(url);
    if (fake.fail) throw new Error("network down");
    if (url === "https://codeload.github.com/codecrafters-io/build-your-own-redis/tar.gz/HEAD") {
      return new Response(courseTarball());
    }
    if (url === "https://api.github.com/repos/codecrafters-io/redis-tester/releases/latest") {
      return Response.json({ tag_name: fake.tag });
    }
    if (url === `https://github.com/codecrafters-io/redis-tester/releases/download/${fake.tag}/${fake.tag}_linux_amd64.tar.gz`) {
      return new Response(tarball({ tester: `binary ${fake.tag}`, "test.sh": "#!/bin/sh\n", "built_executables/cat": "x" }));
    }
    return new Response("Not Found", { status: 404, statusText: "Not Found" });
  }) as typeof fetch;
  return fake;
}

const opts = (fake: Fake, extra: { update?: boolean } = {}) => {
  const log: string[] = [];
  return { log, opts: { fetch: fake.fetch, target: "linux_amd64", log: (l: string) => log.push(l), ...extra } };
};

describe("ensureCourse", () => {
  test("downloads the course definition and the latest tester release", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "data-"));
    const fake = fakeGitHub();
    const got = await ensureCourse("redis", dataDir, opts(fake).opts);
    const dir = courseDir(dataDir, "redis");
    expect(got).toEqual({ definition: join(dir, "course"), tester: join(dir, "tester", "tester") });
    expect(readdirSync(got.definition).sort()).toEqual(["compiled_starters", "course-definition.yml", "stage_descriptions"]);
    expect(existsSync(join(got.definition, "compiled_starters/rust/.codecrafters/compile.sh"))).toBe(true);
    expect(readdirSync(join(got.definition, "stage_descriptions")).length).toBe(3);
    expect(readFileSync(got.tester, "utf8")).toBe("binary v7");
    expect(existsSync(join(dir, "tester", "built_executables", "cat"))).toBe(true);
    expect(readFileSync(join(dir, "tester-version"), "utf8").trim()).toBe("v7");
    expect(readdirSync(dir).filter((f) => f.startsWith("."))).toEqual([]); // no temp dirs left
  });

  test("does nothing when the course is already on disk", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "data-"));
    const fake = fakeGitHub();
    await ensureCourse("redis", dataDir, opts(fake).opts);
    fake.requests.length = 0;
    await ensureCourse("redis", dataDir, opts(fake).opts);
    expect(fake.requests).toEqual([]);
  });

  test("update re-downloads the course and fetches only a newer tester", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "data-"));
    const fake = fakeGitHub();
    await ensureCourse("redis", dataDir, opts(fake).opts);

    fake.requests.length = 0;
    await ensureCourse("redis", dataDir, opts(fake, { update: true }).opts);
    expect(fake.requests.some((u) => u.includes("/releases/download/"))).toBe(false);
    expect(fake.requests.some((u) => u.includes("codeload"))).toBe(true);

    fake.tag = "v8";
    const got = await ensureCourse("redis", dataDir, opts(fake, { update: true }).opts);
    expect(readFileSync(got.tester, "utf8")).toBe("binary v8");
    expect(readFileSync(join(courseDir(dataDir, "redis"), "tester-version"), "utf8").trim()).toBe("v8");
  });

  test("a failed update keeps the copy on disk and warns", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "data-"));
    const fake = fakeGitHub();
    await ensureCourse("redis", dataDir, opts(fake).opts);
    fake.fail = true;
    const { log, opts: o } = opts(fake, { update: true });
    const got = await ensureCourse("redis", dataDir, o);
    expect(readFileSync(got.tester, "utf8")).toBe("binary v7");
    expect(existsSync(join(got.definition, "course-definition.yml"))).toBe(true);
    expect(log.filter((l) => l.startsWith("warning:")).length).toBe(2);
  });

  test("a course copy without starters is downloaded again, and kept if that fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "data-"));
    const fake = fakeGitHub();
    const got = await ensureCourse("redis", dataDir, opts(fake).opts);
    rmSync(join(got.definition, "compiled_starters"), { recursive: true });

    fake.fail = true;
    const { log, opts: o } = opts(fake);
    await ensureCourse("redis", dataDir, o);
    expect(log.filter((l) => l.startsWith("warning:")).length).toBe(1);
    expect(existsSync(join(got.definition, "course-definition.yml"))).toBe(true);

    fake.fail = false;
    await ensureCourse("redis", dataDir, opts(fake).opts);
    expect(existsSync(join(got.definition, "compiled_starters/rust"))).toBe(true);
  });

  test("an unknown course fails with a hint", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "data-"));
    await expect(ensureCourse("nope", dataDir, opts(fakeGitHub()).opts)).rejects.toThrow(
      'no CodeCrafters course "nope" (github.com/codecrafters-io/build-your-own-nope does not exist)',
    );
    expect(existsSync(join(courseDir(dataDir, "nope"), "course"))).toBe(false);
  });

  test.each(["../x", "a/b", "", "A"])("rejects slug %p before any request", async (slug) => {
    const fake = fakeGitHub();
    await expect(ensureCourse(slug, mkdtempSync(join(tmpdir(), "data-")), opts(fake).opts)).rejects.toThrow(/invalid course slug/);
    expect(fake.requests).toEqual([]);
  });

  test("an unknown course is a CourseNotFoundError", async () => {
    const err = await ensureCourse("nope", mkdtempSync(join(tmpdir(), "data-")), opts(fakeGitHub()).opts).catch((e) => e);
    expect(err).toBeInstanceOf(CourseNotFoundError);
  });
});
