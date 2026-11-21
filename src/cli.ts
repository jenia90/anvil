#!/usr/bin/env bun
// Usage: anvil test|submit [...]   (run `bun link` in the anvil folder once to get `anvil`)
// test: runs the course tests on the working tree (uncommitted changes included) without moving progress.
// submit: commits every change and pushes to main on anvil, like `codecrafters submit`.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { TEST_UPLOAD_CAP } from "./limits";

const USAGE = `usage: anvil test [--stage N] [--remote <name>]
       anvil submit [-m <message>] [--stage N] [--remote <name>]

  test     runs the tests on your working tree, uncommitted changes included; never moves your progress
  submit   commits every change (git add -A) and pushes to main on anvil, which runs the tests and moves your
           progress, like codecrafters submit

  -m, --message <msg>  the commit message for submit (default: anvil submit)
  --stage N            run only stage N
  --remote <name>      the anvil remote to use when the repo has several

exit codes: 0 passed, 1 failed, 2 could not run`;

class UsageError extends Error {}
/** anvil did not answer at all (not running, wrong address). */
class UnreachableError extends Error {}

/** `<base>/git/<repo>.git` → base and repo; null for any other remote. */
export function parseAnvilRemote(url: string): { base: string; repo: string } | null {
  const m = /^(https?:\/\/.+)\/git\/([a-z0-9][a-z0-9-]*)\.git\/?$/.exec(url.trim());
  return m ? { base: m[1], repo: m[2] } : null;
}

type CliOptions = { stage?: number; remote?: string; message?: string };

function parseArgs(args: string[], allowMessage: boolean): CliOptions {
  const opts: CliOptions = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, value] = [args[i], args[i + 1]];
    if (flag === "--stage" && value !== undefined && /^\d+$/.test(value)) opts.stage = Number(value);
    else if (flag === "--remote" && value !== undefined) opts.remote = value;
    else if (allowMessage && (flag === "-m" || flag === "--message") && value !== undefined) opts.message = value;
    else throw new UsageError(`unexpected argument: ${flag}${flag === "--stage" ? " (expects a stage number)" : ""}`);
    i++;
  }
  return opts;
}

export const parseTestArgs = (args: string[]): { stage?: number; remote?: string } => parseArgs(args, false);
export const parseSubmitArgs = (args: string[]): CliOptions => parseArgs(args, true);

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
}

/** The anvil remote of the repo around `cwd`: its base URL, repo name and the repo's root folder. */
export function findAnvil(cwd: string, remote?: string): { base: string; repo: string; root: string; remote: string } {
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (!top.ok) throw new Error("not inside a git repository: run anvil test from your solution repo");
  const remotes = git(top.out, "remote").out.split("\n").filter(Boolean);
  const anvil = remotes.flatMap((name) => {
    const found = parseAnvilRemote(git(top.out, "remote", "get-url", name).out);
    return found ? [{ name, ...found }] : [];
  });
  const pick = remote === undefined ? anvil : anvil.filter((r) => r.name === remote);
  if (remote !== undefined && pick.length === 0) throw new Error(`${remote} is not an anvil remote of this repo`);
  if (pick.length === 0) {
    throw new Error("no anvil remote in this repo: add one with git remote add local http://127.0.0.1:4300/git/<repo>.git");
  }
  if (pick.length > 1) {
    throw new Error(`several anvil remotes (${pick.map((r) => r.name).join(", ")}): pick one with --remote <name>`);
  }
  return { base: pick[0].base, repo: pick[0].repo, root: top.out, remote: pick[0].name };
}

/** A tar of the files git would commit: tracked (as they are now) and new ones it does not ignore. */
export async function packWorkingTree(root: string): Promise<Uint8Array<ArrayBuffer>> {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString().trim()}`);
  const exists = (path: string) => {
    try {
      lstatSync(join(root, path));
      return true;
    } catch {
      return false; // deleted but still tracked
    }
  };
  const paths = [...new Set(listed.stdout.toString().split("\0").filter(Boolean))].filter(exists);
  // --no-recursion: a submodule or nested repo is listed as a folder; its contents (build output, .git) stay local,
  // as with a push, which leaves a submodule empty.
  const tar = Bun.spawn(["tar", "-c", "--no-recursion", "-C", root, "--null", "-T", "-"], {
    stdin: new Blob([paths.map((p) => `${p}\0`).join("")]), stdout: "pipe", stderr: "pipe",
  });
  const [bytes, code] = await Promise.all([new Response(tar.stdout).bytes(), tar.exited]);
  if (code !== 0) throw new Error(`tar failed: ${(await new Response(tar.stderr).text()).trim()}`);
  return bytes;
}

/** Runs `anvil test`; returns the exit code (0 passed, 1 failed, 2 could not run). */
export async function runTest(opts: {
  cwd: string; stage?: number; remote?: string; out: (s: string) => void;
  /** Upload limit in bytes (the server's; smaller only in tests). */
  uploadCap?: number;
}): Promise<number> {
  const { out } = opts;
  const fail = (message: string) => {
    out(`anvil: ${message}\n`);
    return 2;
  };
  let target: ReturnType<typeof findAnvil>;
  let tar: Uint8Array<ArrayBuffer>;
  try {
    target = findAnvil(opts.cwd, opts.remote);
    tar = await packWorkingTree(target.root);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const cap = opts.uploadCap ?? TEST_UPLOAD_CAP;
  if (tar.byteLength > cap) {
    // Checked here: anvil's server refuses a body this big before it can say why.
    return fail(`the working tree is larger than ${Math.round(cap / 1024 / 1024)} MiB (${Math.round(tar.byteLength / 1024 / 1024)} MiB): add big files to .gitignore`);
  }
  const head = git(target.root, "rev-parse", "--verify", "-q", "HEAD");
  const api = `${target.base}/api/repos/${encodeURIComponent(target.repo)}`;

  let res: Response;
  try {
    res = await fetch(`${api}/test${opts.stage === undefined ? "" : `?stage=${opts.stage}`}`, {
      method: "POST",
      headers: { "content-type": "application/x-tar", "x-anvil-commit": head.ok ? head.out : "0".repeat(40) },
      body: tar,
    });
  } catch {
    return fail(`could not reach anvil at ${target.base}: is it running? (bun run start in the anvil folder)`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(body?.error ?? `anvil answered ${res.status}`);
  }
  const runId = res.headers.get("x-anvil-run");
  const decoder = new TextDecoder();
  for await (const chunk of res.body!) out(decoder.decode(chunk, { stream: true }));

  try {
    const run = (await (await fetch(`${api}/runs/${runId}`)).json()) as { status: string };
    return run.status === "passed" ? 0 : 1;
  } catch {
    return fail("could not read the run's result");
  }
}

type RunInfo = { id: number; branch: string; commitSha: string; status: string };
const FINISHED = new Set(["passed", "failed", "build_failed", "error"]);

/** An operation git has stopped in the middle of; committing then would record a half-done merge or rebase. */
function unfinishedOperation(root: string): string | null {
  const exists = (name: string) => {
    try {
      lstatSync(join(root, git(root, "rev-parse", "--git-path", name).out));
      return true;
    } catch {
      return false;
    }
  };
  if (exists("rebase-merge") || exists("rebase-apply")) return "a rebase";
  if (exists("MERGE_HEAD")) return "a merge";
  if (exists("CHERRY_PICK_HEAD")) return "a cherry-pick";
  if (exists("REVERT_HEAD")) return "a revert";
  if (git(root, "diff", "--name-only", "--diff-filter=U").out) return "conflict resolution";
  return null;
}

/**
 * Runs `anvil submit`: commits every change (if any) and pushes HEAD to main on anvil, whose push output carries the
 * test results. With nothing new to push it reports the current commit's result, or runs it again (for `--stage`, or
 * when it has none). Returns the exit code (0 passed, 1 failed, 2 could not run).
 */
export async function runSubmit(opts: CliOptions & { cwd: string; out: (s: string) => void }): Promise<number> {
  const { out } = opts;
  const fail = (message: string) => {
    out(`anvil: ${message}\n`);
    return 2;
  };
  let target: ReturnType<typeof findAnvil>;
  try {
    target = findAnvil(opts.cwd, opts.remote);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const { root } = target;
  const api = `${target.base}/api/repos/${encodeURIComponent(target.repo)}`;
  /** GET from the API; throws with anvil's own error message when it answers with one. */
  const getJson = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${api}${path}`).catch(() => {
      throw new UnreachableError(`could not reach anvil at ${target.base}: is it running? (bun run start in the anvil folder)`);
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || body === null) throw new Error(body?.error ?? `anvil answered ${res.status}`);
    return body;
  };
  const recentRuns = async () => (await getJson<{ runs: RunInfo[] }>("/runs?limit=200")).runs;
  const finished = async (id: number): Promise<RunInfo> => {
    for (;;) {
      const run = await getJson<RunInfo>(`/runs/${id}`);
      if (FINISHED.has(run.status)) return run;
      await Bun.sleep(500);
    }
  };
  const exitFor = (run: RunInfo) => (run.status === "passed" ? 0 : 1);

  let before: number;
  try {
    const detail = await getJson<{ currentIndex: number | null; stages: { index: number; locked: boolean }[] }>("");
    // Checked before committing: once pushed, main has moved even if anvil refuses to run the stage.
    if (opts.stage !== undefined) {
      const stage = detail.stages.find((s) => s.index === opts.stage);
      if (!stage) return fail(`no stage ${opts.stage} in this course (1–${detail.stages.length})`);
      if (stage.locked) return fail(`stage ${opts.stage} is locked; pass stage ${detail.currentIndex} first`);
    }
    before = (await recentRuns())[0]?.id ?? 0;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e)); // anvil's own error, or that it could not be reached
  }

  const busy = unfinishedOperation(root);
  if (busy) return fail(`${busy} is in progress: finish it (or abort it) before submitting`);
  const add = Bun.spawnSync(["git", "add", "-A"], { cwd: root, stderr: "pipe" });
  if (add.exitCode !== 0) return fail(`git add -A failed: ${add.stderr.toString().trim()}`);
  const staged = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: root }).exitCode !== 0;
  const hasHead = git(root, "rev-parse", "--verify", "-q", "HEAD").ok;
  if (staged || !hasHead) {
    const message = opts.message ?? "anvil submit";
    const commit = Bun.spawnSync(["git", "commit", "-q", "-m", message], { cwd: root, stderr: "pipe", stdout: "pipe" });
    if (commit.exitCode !== 0) {
      return fail(`git commit failed: ${[commit.stdout.toString(), commit.stderr.toString()].join("\n").trim()}`);
    }
    out(`Committed ${git(root, "rev-parse", "--short", "HEAD").out}: ${message}\n`);
  }
  const head = git(root, "rev-parse", "HEAD").out;

  const push = Bun.spawn(
    ["git", "push", ...(opts.stage === undefined ? [] : ["-o", `stage=${opts.stage}`]), target.remote, "HEAD:main"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  let pushed = "";
  const relay = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder(); // one per stream: chunks of the two may interleave
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      pushed += text;
      out(text);
    }
  };
  await Promise.all([relay(push.stdout), relay(push.stderr)]);
  if ((await push.exited) !== 0) {
    return fail(
      pushed.includes("[rejected]")
        ? "the push was refused: main on anvil has commits you do not have; bring them in first (git pull --rebase)"
        : "git push failed (see git's message above)",
    );
  }

  try {
    const runs = await recentRuns();
    const ours = runs.filter((r) => r.id > before && r.commitSha === head && r.branch === "main");
    // The run the push started is the oldest new one (a Re-run pressed meanwhile would be newer).
    if (ours.length > 0) return exitFor(await finished(ours[ours.length - 1].id));
    if (!pushed.includes("Everything up-to-date")) return fail("the push started no run (see the messages above)");

    const last = runs.find((r) => r.commitSha === head && r.branch === "main");
    if (last && opts.stage === undefined) {
      const run = await finished(last.id); // e.g. still running after a Ctrl-C'd submit
      out(`Nothing new to submit: main on anvil is already at ${head.slice(0, 7)}; its last run ${run.status}.\n`);
      return exitFor(run);
    }
    // Nothing to push, but a stage to run (or no result yet): run the commit on main again.
    out(`Nothing new to submit: running ${head.slice(0, 7)} again${opts.stage === undefined ? "" : ` (stage ${opts.stage})`}...\n`);
    const res = await fetch(`${api}/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.stage === undefined ? {} : { stage: opts.stage }),
    });
    const started = (await res.json().catch(() => null)) as { runId?: number; error?: string } | null;
    if (!res.ok || started?.runId === undefined) return fail(started?.error ?? `anvil answered ${res.status}`);
    const run = await finished(started.runId);
    out(`${run.status === "passed" ? "✔ Passed" : `✘ ${run.status.replace("_", " ")}`}: details at ${target.base}/r/${target.repo}\n`);
    return exitFor(run);
  } catch (e) {
    return fail(`could not read the run's result: ${e instanceof Error ? e.message : e}`);
  }
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "test" && command !== "submit") {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const out = (s: string) => void process.stdout.write(s);
    const cwd = process.cwd();
    process.exit(
      command === "test"
        ? await runTest({ cwd, ...parseTestArgs(rest), out })
        : await runSubmit({ cwd, ...parseSubmitArgs(rest), out }),
    );
  } catch (e) {
    console.error(e instanceof UsageError ? `${e.message}\n\n${USAGE}` : `anvil: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
}
