#!/usr/bin/env bun
// Usage: anvil test [--stage N] [--remote <name>]   (run `bun link` in the anvil folder once to get `anvil`)
// Runs the course tests on the working tree (uncommitted changes included) through the running anvil, like a push,
// without moving progress.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { TEST_UPLOAD_CAP } from "./limits";

const USAGE = `usage: anvil test [--stage N] [--remote <name>]

  Runs the tests on your working tree, uncommitted changes included, through the running anvil.
  Only pushes to main move your progress; a test run never does.

  --stage N        run only stage N
  --remote <name>  the anvil remote to use when the repo has several

exit codes: 0 passed, 1 failed, 2 could not run`;

class UsageError extends Error {}

/** `<base>/git/<repo>.git` → base and repo; null for any other remote. */
export function parseAnvilRemote(url: string): { base: string; repo: string } | null {
  const m = /^(https?:\/\/.+)\/git\/([a-z0-9][a-z0-9-]*)\.git\/?$/.exec(url.trim());
  return m ? { base: m[1], repo: m[2] } : null;
}

export function parseTestArgs(args: string[]): { stage?: number; remote?: string } {
  const opts: { stage?: number; remote?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--stage" && value !== undefined && /^\d+$/.test(value)) opts.stage = Number(value);
    else if (args[i] === "--remote" && value !== undefined) opts.remote = value;
    else throw new UsageError(`unexpected argument: ${args[i]}${args[i] === "--stage" ? " (expects a stage number)" : ""}`);
    i++;
  }
  return opts;
}

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
}

/** The anvil remote of the repo around `cwd`: its base URL, repo name and the repo's root folder. */
export function findAnvil(cwd: string, remote?: string): { base: string; repo: string; root: string } {
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
  return { base: pick[0].base, repo: pick[0].repo, root: top.out };
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

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "test") {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const args = parseTestArgs(rest);
    process.exit(await runTest({ cwd: process.cwd(), ...args, out: (s) => process.stdout.write(s) }));
  } catch (e) {
    console.error(e instanceof UsageError ? `${e.message}\n\n${USAGE}` : `anvil: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
}
