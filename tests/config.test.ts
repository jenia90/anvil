import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { type CourseFetcher, addRepoEntry, loadConfig } from "../src/config";

const fixtureDir = join(import.meta.dir, "fixtures");

function writeConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  copyFileSync(join(fixtureDir, "course.yml"), join(dir, "course.yml"));
  const path = join(dir, "anvil.yml");
  writeFileSync(path, yaml);
  return path;
}

const base = `courses:\n  - definition: ./course.yml\n    tester: ./t\n`;

describe("loadConfig", () => {
  test("resolves relative paths against the config file directory", async () => {
    const cfg = await loadConfig(join(fixtureDir, "config.yml"));
    expect(cfg.courses.get("http-server")!.testerPath).toBe(join(fixtureDir, "fake-tester.ts"));
  });

  test("remembers the config file's absolute path", async () => {
    const cfg = await loadConfig(join(fixtureDir, "..", "fixtures", "config.yml"));
    expect(cfg.path).toBe(join(fixtureDir, "config.yml"));
  });

  test("url is optional and kept as an origin without a trailing slash", async () => {
    expect((await loadConfig(join(fixtureDir, "config.yml"))).url).toBeNull();
    for (const [raw, origin] of [
      ["https://iceman.tail1.ts.net", "https://iceman.tail1.ts.net"],
      ["https://iceman.tail1.ts.net/", "https://iceman.tail1.ts.net"],
      ["http://iceman:8080", "http://iceman:8080"],
    ]) {
      const path = writeConfig(`url: ${raw}\n${base}`);
      expect((await loadConfig(path)).url).toBe(origin);
    }
  });

  test.each(["iceman.ts.net", "ftp://iceman", "https://iceman/anvil", "https://iceman?x=1", "not a url"])(
    "rejects url %p",
    async (url) => {
      await expect(loadConfig(writeConfig(`url: "${url}"\n${base}`))).rejects.toThrow(/url/);
    },
  );

  test("defaults port to 4300 and dataDir to ./data beside the config", async () => {
    const cfg = await loadConfig(join(fixtureDir, "config.yml"));
    expect(cfg.port).toBe(4300);
    expect(cfg.dataDir).toBe(join(fixtureDir, "data"));
  });

  test("indexes courses by the slug inside the definition", async () => {
    const cfg = await loadConfig(join(fixtureDir, "config.yml"));
    expect([...cfg.courses.keys()]).toEqual(["http-server"]);
    expect(cfg.courses.get("http-server")!.course.stages.length).toBe(3);
    expect(cfg.repos).toEqual([{ name: "demo", course: "http-server", language: "rust" }]);
  });

  test("a local definition may be a course repo directory", async () => {
    const path = writeConfig(
      `courses:\n  - definition: ${join(fixtureDir, "course-repo")}\n    tester: ./t\nrepos:\n  - name: r\n    course: redis\n    language: rust\n`,
    );
    const cfg = await loadConfig(path);
    expect(cfg.courses.get("redis")!.course.stages.map((s) => s.slug)).toEqual(["jm1", "rg2", "mh6"]);
  });

  test("a course not listed under courses: is fetched, once per course", async () => {
    const asked: string[] = [];
    const fetchCourse: CourseFetcher = async (slug, dataDir) => {
      asked.push(`${slug} ${dataDir}`);
      return { definition: join(fixtureDir, "course-repo"), tester: "/fetched/tester" };
    };
    const repo = (name: string, course: string) => `  - name: ${name}\n    course: ${course}\n    language: rust\n`;
    const path = writeConfig(`${base}repos:\n${repo("a", "redis")}${repo("b", "redis")}${repo("c", "http-server")}`);
    const cfg = await loadConfig(path, fetchCourse);
    expect(asked).toEqual([`redis ${join(path, "..", "data")}`]);
    expect(cfg.courses.get("redis")!.testerPath).toBe("/fetched/tester");
    expect(cfg.courses.get("http-server")!.testerPath).toBe(join(path, "..", "t"));
  });

  test("a fetch failure names the repo", async () => {
    const path = writeConfig(`${base}repos:\n  - name: a\n    course: nope\n    language: rust\n`);
    const fetchCourse: CourseFetcher = async () => {
      throw new Error("no such course");
    };
    await expect(loadConfig(path, fetchCourse)).rejects.toThrow("repo a: no such course");
  });

  test("a fetched definition with a different slug is refused", async () => {
    const path = writeConfig(`${base}repos:\n  - name: a\n    course: shell\n    language: rust\n`);
    const fetchCourse: CourseFetcher = async () => ({ definition: join(fixtureDir, "course-repo"), tester: "/t" });
    await expect(loadConfig(path, fetchCourse)).rejects.toThrow(/has slug redis/);
  });

  test("without a fetcher, a repo whose course is not configured is rejected", async () => {
    const path = writeConfig(`${base}repos:\n  - name: a\n    course: nope\n    language: rust\n`);
    await expect(loadConfig(path)).rejects.toThrow(/unknown course/i);
  });

  test("rejects a repo without a language", async () => {
    const path = writeConfig(`${base}repos:\n  - name: a\n    course: http-server\n`);
    await expect(loadConfig(path)).rejects.toThrow(/missing language/i);
  });

  test("rejects duplicate repo names", async () => {
    const repo = `  - name: a\n    course: http-server\n    language: rust\n`;
    const path = writeConfig(`${base}repos:\n${repo}${repo}`);
    await expect(loadConfig(path)).rejects.toThrow(/duplicate/i);
  });

  test.each(["../x", "a b", "A", "a.b", "-a"])("rejects repo name %p", async (name) => {
    const path = writeConfig(`${base}repos:\n  - name: "${name}"\n    course: http-server\n    language: rust\n`);
    await expect(loadConfig(path)).rejects.toThrow(/repo name/i);
  });
});

describe("addRepoEntry", () => {
  const repo = { name: "redis-go", course: "redis", language: "go" };

  test("appends after the last item, with the items' indent, keeping comments and later keys", () => {
    const text = "port: 1\nrepos:\n    - name: a\n      course: x\n      language: rust\n    # trailing comment\n\ndataDir: ./d\n";
    const out = addRepoEntry(text, repo);
    expect(out).toBe(
      "port: 1\nrepos:\n    - name: a\n      course: x\n      language: rust\n    - name: redis-go\n      course: redis\n      language: go\n    # trailing comment\n\ndataDir: ./d\n",
    );
    expect((load(out) as { repos: unknown[] }).repos.length).toBe(2);
  });

  test("an empty repos: section gets its first item", () => {
    const out = addRepoEntry("repos:\n", repo);
    expect(load(out)).toEqual({ repos: [repo] });
  });

  test("a config without repos: gets the section at the end", () => {
    const out = addRepoEntry("port: 1", repo);
    expect(load(out)).toEqual({ port: 1, repos: [repo] });
  });
});
