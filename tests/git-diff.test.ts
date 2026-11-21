import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bareRepoDir, diffCommits } from "../src/git-remote";
import { git, makeFixtureRepo } from "./helpers";

async function twoCommits(change: (workDir: string) => void) {
  const { bareDir, sha: base, workDir } = await makeFixtureRepo();
  const dataDir = mkdtempSync(join(tmpdir(), "diff-"));
  mkdirSync(dirname(bareRepoDir(dataDir, "demo")), { recursive: true });
  cpSync(bareDir, bareRepoDir(dataDir, "demo"), { recursive: true });
  change(workDir);
  git(workDir, "add", "-A");
  git(workDir, "commit", "-q", "-m", "second");
  const head = git(workDir, "rev-parse", "HEAD");
  git(workDir, "push", "-q", bareRepoDir(dataDir, "demo"), "HEAD:refs/heads/main");
  return { dataDir, base, head };
}

describe("diffCommits", () => {
  test("diffCommits lists files and patch", async () => {
    const { dataDir, base, head } = await twoCommits((w) => writeFileSync(join(w, "your_program.sh"), "#!/bin/sh\necho hi\n"));
    const diff = diffCommits(dataDir, "demo", base, head, 204_800);
    if ("missing" in diff) throw new Error("expected a diff");
    expect(diff.files).toEqual([{ path: "your_program.sh", added: 1, removed: 1 }]);
    expect(diff.patch).toContain("+echo hi");
    expect(diff.patch).not.toContain("\x1b");
    expect(diff.truncated).toBe(false);
  });

  test("diff is capped", async () => {
    const { dataDir, base, head } = await twoCommits((w) => writeFileSync(join(w, "big.txt"), "line\n".repeat(10_000)));
    const diff = diffCommits(dataDir, "demo", base, head, 1_000);
    if ("missing" in diff) throw new Error("expected a diff");
    expect(diff.truncated).toBe(true);
    expect(new TextEncoder().encode(diff.patch).length).toBeLessThanOrEqual(1_000);
  });

  test("diff reports a missing commit", async () => {
    const { dataDir, head } = await twoCommits((w) => writeFileSync(join(w, "a.txt"), "a\n"));
    expect(diffCommits(dataDir, "demo", "deadbeef".repeat(5), head, 1_000)).toEqual({ missing: true });
  });
});
