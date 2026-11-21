import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCourse, renderStageMd } from "../src/course";

const fixture = join(import.meta.dir, "fixtures/course.yml");

describe("loadCourse", () => {
  test("loads slug, name, short name and description", () => {
    const course = loadCourse(fixture);
    expect(course.slug).toBe("http-server");
    expect(course.name).toBe("Build your own HTTP server");
    expect(course.shortName).toBe("HTTP server");
    expect(course.descriptionMd.length).toBeGreaterThan(0);
  });

  test("numbers stages from 1 in file order", () => {
    const { stages } = loadCourse(fixture);
    expect(stages.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(stages.map((s) => s.slug)).toEqual(["at4", "ia4", "ih0"]);
    expect(stages[0].descriptionMd).toContain("4221");
    expect(stages[2].difficulty).toBe("easy");
  });

  test("ignores the extensions section", () => {
    expect(loadCourse(fixture).stages.length).toBe(3);
  });

  test("a stage with only a slug gets the slug as its name and empty instructions", () => {
    const { stages } = loadCourse(join(import.meta.dir, "fixtures/course-sparse.yml"));
    expect(stages[1]).toEqual({ index: 2, slug: "bb2", name: "bb2", difficulty: "", descriptionMd: "", extension: null });
  });

  test("throws a clear error when the file is missing", () => {
    expect(() => loadCourse("/nonexistent/course.yml")).toThrow(/course definition not found/i);
  });

  test("throws when stages are missing or empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "course-"));
    const path = join(dir, "course.yml");
    writeFileSync(path, "slug: x\nname: X\nshort_name: X\ndescription_md: d\nstages: []\n");
    expect(() => loadCourse(path)).toThrow(/stages/i);
  });

  test("loads a course repo directory: stage text from stage_descriptions, extension stages tagged", () => {
    const course = loadCourse(join(import.meta.dir, "fixtures/course-repo"));
    expect(course.slug).toBe("redis");
    expect(course.stages.map((s) => [s.index, s.slug, s.extension])).toEqual([
      [1, "jm1", null],
      [2, "rg2", null],
      [3, "mh6", "Lists"],
    ]);
    expect(course.stages[1].descriptionMd).toBe("Reply with `+PONG\\r\\n`.\n");
    expect(course.stages[2].descriptionMd).toBe("Handle RPUSH.\n");
  });

  test("a course repo directory without course-definition.yml is a clear error", () => {
    expect(() => loadCourse(mkdtempSync(join(tmpdir(), "course-")))).toThrow(/course-definition\.yml/);
  });
});

describe("renderStageMd", () => {
  const md = loadCourse(join(import.meta.dir, "fixtures/course-repo")).stages[0].descriptionMd;

  test("keeps the repo language's blocks, drops other languages' and bot-only blocks", () => {
    const out = renderStageMd(md, "rust");
    expect(out).toContain("std::net::TcpListener");
    expect(out).not.toContain("your language's TCP API");
    expect(out).not.toContain("Only for bots");
    expect(out).not.toContain("{{");
  });

  test("inverted language blocks show for other languages; language_name is not HTML-escaped", () => {
    const out = renderStageMd(md, "cpp");
    expect(out).toContain("Use your language's TCP API.");
    expect(out).not.toContain("TcpListener");
    expect(out).toContain("Don't use C++'s built-in helpers.");
  });

  test("delimiter changes keep literal braces", () => {
    expect(renderStageMd("```{{=<~ ~>=}}\n{{}}\n```", "rust")).toBe("```\n{{}}\n```");
  });
});
