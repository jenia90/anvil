import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bareRepoDir } from "../src/git-remote";
import { buildHintPrompt, gatherCode } from "../src/hints";
import { git, makeFixtureRepo } from "./helpers";

const input = (over: Partial<Parameters<typeof buildHintPrompt>[0]> = {}) =>
  buildHintPrompt({
    language: "rust",
    stage: { index: 2, name: "Respond with 200", descriptionMd: "Respond to `GET /` with a 200." },
    log: "\x1b[91m[stage-2] Expected status code 200, got 404\x1b[0m",
    diff: null, files: [], workingTree: false, level: 1, previous: [], maxBytes: 150 * 1024,
    ...over,
  });

describe("buildHintPrompt", () => {
  test("rules come first and are repeated at the end", () => {
    const prompt = input();
    expect(prompt.indexOf("Never write code")).toBeLessThan(100 * 1024);
    expect(prompt.indexOf("Never write code")).toBeLessThan(prompt.indexOf("Respond with 200"));
    expect(prompt.lastIndexOf("never write code")).toBeGreaterThan(prompt.indexOf("Expected status code"));
    expect(prompt).toContain("Rust");
  });

  test("states the level", () => {
    expect(input({ level: 1 })).toContain("Hint level 1 of 3");
    expect(input({ level: 3 })).toContain("Hint level 3 of 3");
    expect(input({ level: 3 })).toContain("where in their code");
  });

  test("includes the stage, the log without ANSI, and the diff", () => {
    const prompt = input({ diff: "+fn main() {}" });
    expect(prompt).toContain("Stage 2: Respond with 200");
    expect(prompt).toContain("Respond to `GET /` with a 200.");
    expect(prompt).toContain("[stage-2] Expected status code 200, got 404");
    expect(prompt).not.toContain("\x1b");
    expect(prompt).toContain("+fn main() {}");
    expect(input()).toContain("has never passed");
  });

  test("keeps the end of a long log", () => {
    const prompt = input({ log: `${"early line\n".repeat(5000)}the real failure` });
    expect(prompt).toContain("the real failure");
    expect(prompt.split("early line").length - 1).toBeLessThan(5000);
  });

  test("includes earlier hints, capped", () => {
    const prompt = input({ level: 2, previous: ["Look at the status line.", "x".repeat(10_000)] });
    expect(prompt).toContain("Look at the status line.");
    expect(prompt.split("x".repeat(100)).length).toBeLessThan(60);
  });

  test("says when there is no code (working tree)", () => {
    expect(input({ workingTree: true })).toContain("working tree");
  });

  test("code fills only the remaining budget", () => {
    const files = [
      { path: "src/main.rs", text: "a".repeat(3000) },
      { path: "src/big.rs", text: "b".repeat(20_000) },
    ];
    const prompt = input({ files, maxBytes: 12 * 1024 });
    expect(prompt).toContain("src/main.rs");
    expect(prompt).not.toContain("b".repeat(100));
    expect(prompt).toContain("Left out to fit: src/big.rs");
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(12 * 1024);
  });
});

test("the whole prompt stays within a small budget, keeping a small source file", () => {
  const prompt = input({
    log: "log line\n".repeat(10_000), diff: "+diff line\n".repeat(10_000),
    files: [{ path: "src/main.rs", text: "fn main() {}" }], maxBytes: 8 * 1024,
  });
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(8 * 1024);
  expect(prompt).toContain("fn main() {}");
  expect(prompt).toContain("Never write code");
});

test("files never read are named", () => {
  expect(input({ notRead: ["src/x.rs", "src/y.rs"] })).toContain("Not read (over the budget): src/x.rs, src/y.rs");
});

describe("gatherCode", () => {
  async function repo() {
    const { bareDir, workDir } = await makeFixtureRepo();
    mkdirSync(join(workDir, "src"));
    writeFileSync(join(workDir, "src", "a.rs"), "fn a() {}\n");
    writeFileSync(join(workDir, "src", "z.rs"), "fn z() {}\n");
    writeFileSync(join(workDir, "logo.png"), new Uint8Array([0x89, 0x50, 0, 0, 1]));
    writeFileSync(join(workDir, "huge.txt"), "h".repeat(60 * 1024));
    writeFileSync(join(workDir, "Cargo.lock"), "# lock\n");
    git(workDir, "add", "-A");
    git(workDir, "commit", "-q", "-m", "code");
    const sha = git(workDir, "rev-parse", "HEAD");
    const dataDir = mkdtempSync(join(tmpdir(), "hints-"));
    mkdirSync(dirname(bareRepoDir(dataDir, "demo")), { recursive: true });
    cpSync(bareDir, bareRepoDir(dataDir, "demo"), { recursive: true });
    git(workDir, "push", "-q", bareRepoDir(dataDir, "demo"), "HEAD:refs/heads/main");
    return { dataDir, sha };
  }

  test("changed files first, then the rest by path", async () => {
    const { dataDir, sha } = await repo();
    const { files } = gatherCode(dataDir, "demo", sha, ["src/z.rs"], 1024 * 1024);
    expect(files[0].path).toBe("src/z.rs");
    expect(files.map((f) => f.path)).toContain("src/a.rs");
    expect(files.find((f) => f.path === "src/a.rs")!.text).toBe("fn a() {}\n");
  });

  test("source comes before setup files, lockfiles and docs when nothing changed", async () => {
    const { dataDir, sha } = await repo();
    const paths = gatherCode(dataDir, "demo", sha, [], 1024 * 1024).files.map((f) => f.path);
    expect(paths.indexOf("src/a.rs")).toBeLessThan(paths.indexOf(".codecrafters/compile.sh"));
    expect(paths.indexOf("src/a.rs")).toBeLessThan(paths.indexOf("Cargo.lock"));
  });

  test("files left unread are reported", async () => {
    const { dataDir, sha } = await repo();
    const { files, notRead } = gatherCode(dataDir, "demo", sha, [], 5);
    expect(files.length).toBe(1);
    expect(notRead.length).toBeGreaterThan(0);
  });

  test("skips binary and large files", async () => {
    const { dataDir, sha } = await repo();
    const { files, skipped } = gatherCode(dataDir, "demo", sha, [], 1024 * 1024);
    expect(files.map((f) => f.path)).not.toContain("logo.png");
    expect(files.map((f) => f.path)).not.toContain("huge.txt");
    expect(skipped).toEqual(expect.arrayContaining(["logo.png", "huge.txt"]));
  });
});
