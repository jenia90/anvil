import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripAnsi } from "./ansi";
import { type CaseResult, type TestCase, parseTesterLog } from "./tester-log";

export type RunInput = {
  bareRepoDir: string;
  sha: string;
  /** A tar of a working tree (`anvil test`): unpacked instead of checking out `sha`. */
  archive?: string;
  testerPath: string;
  cases: TestCase[];
  emit: (line: string) => void;
  onPhase: (phase: "building" | "testing") => void;
  /** Per phase (compile, tester); a phase that runs longer is killed and the run ends as error. */
  timeoutMs?: number;
};
export type RunOutcome = {
  status: "passed" | "failed" | "build_failed" | "error";
  buildLog: string;
  testerLog: string;
  results: CaseResult[];
};

const LOG_CAP = 1024 * 1024;
const MAX_LINE = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TRUNCATED = "[log truncated]";

/** Keeps a log under LOG_CAP; lines matching `exempt` are always kept (they carry the tester's verdicts). */
class CappedLog {
  text = "";
  private full = false;
  constructor(private emit: (line: string) => void, private exempt: (line: string) => boolean = () => false) {}

  add(line: string): void {
    if (this.full && !this.exempt(line)) return;
    if (!this.full && this.text.length + line.length + 1 > LOG_CAP && !this.exempt(line)) {
      this.full = true;
      this.text += `${TRUNCATED}\n`;
      this.emit(TRUNCATED);
      return;
    }
    this.text += `${line}\n`;
    this.emit(line);
  }
}

async function pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    const parts = rest.split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) onLine(part);
    // Output with no newline must not pile up in memory: hand it over in pieces so the log cap applies.
    while (rest.length > MAX_LINE) {
      onLine(rest.slice(0, MAX_LINE));
      rest = rest.slice(MAX_LINE);
    }
  }
  rest += decoder.decode();
  if (rest) onLine(rest);
}

async function runStreaming(
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string> },
  log: CappedLog,
  timeoutMs: number,
): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
  const killGroup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);
  try {
    await Promise.all([pump(proc.stdout, (l) => log.add(l)), pump(proc.stderr, (l) => log.add(l))]);
    const code = await proc.exited;
    if (timedOut) throw new Error(`timed out after ${timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`} and was killed`);
    return code;
  } finally {
    clearTimeout(timer);
    killGroup(); // never leave the command's children running past the run
    await proc.exited;
  }
}

/**
 * Some testers move system binaries out of the way so a solution cannot shell out to them (grep-tester moves
 * `grep`, shell-tester moves `pwd`), using `sudo mv` when plain `mv` fails. On CodeCrafters that happens inside a
 * throwaway container; here it would touch the user's system or hang on a password prompt. Each test run gets a
 * private bin dir first on PATH: links to those binaries (the tester moves the links) and a `sudo` that runs its
 * command as the user, never with elevated rights.
 */
function makeShimDir(): string {
  const bin = mkdtempSync(join(tmpdir(), "anvil-bin-"));
  for (const cmd of ["grep", "pwd"]) {
    const real = Bun.which(cmd);
    if (real) symlinkSync(real, join(bin, cmd));
  }
  writeFileSync(join(bin, "sudo"), '#!/bin/sh\n# anvil: run as the current user; testers never get root here.\nexec "$@"\n');
  chmodSync(join(bin, "sudo"), 0o755);
  return bin;
}

const isProgramLine = (line: string) => stripAnsi(line).startsWith("[your_program]");

export async function executeRun(input: RunInput): Promise<RunOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "anvil-run-"));
  const shims = makeShimDir();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const build = new CappedLog(input.emit);
  const tester = new CappedLog(input.emit, (l) => !isProgramLine(l));
  const outcome = (status: RunOutcome["status"], results: CaseResult[] = []): RunOutcome => ({
    status, buildLog: build.text, testerLog: tester.text, results,
  });

  let phase: "building" | "testing" = "building";
  try {
    if (input.archive) {
      const unpack = Bun.spawn(["tar", "-x", "-m", "-f", input.archive, "-C", dir], { stderr: "pipe" });
      if ((await unpack.exited) !== 0) {
        build.add(`could not unpack the working tree: ${await new Response(unpack.stderr).text()}`.trim());
        return outcome("error");
      }
    }
    const archive = input.archive
      ? null
      : Bun.spawn(["git", "--git-dir", input.bareRepoDir, "archive", input.sha], { stdout: "pipe", stderr: "pipe" });
    // -m: stamp files with now, not the commit date; otherwise cargo reuses a stale binary built from a newer commit
    const tar = archive && Bun.spawn(["tar", "-x", "-m", "-C", dir], { stdin: archive.stdout, stderr: "pipe" });
    const [archiveCode, tarCode] = archive && tar ? await Promise.all([archive.exited, tar.exited]) : [0, 0];
    if (archive && (archiveCode !== 0 || tarCode !== 0)) {
      build.add(`could not check out ${input.sha}: ${await new Response(archive.stderr).text()}`.trim());
      return outcome("error");
    }

    // Same steps as CodeCrafters' test.sh: compile.sh if present, then .codecrafters/run.sh replaces your_program.sh.
    input.onPhase("building");
    const compile = join(dir, ".codecrafters/compile.sh");
    if (existsSync(compile)) {
      if ((await runStreaming(["sh", compile], { cwd: dir }, build, timeoutMs)) !== 0) return outcome("build_failed");
    } else {
      build.add("no .codecrafters/compile.sh in this commit; skipping the compile step");
    }
    const run = join(dir, ".codecrafters/run.sh");
    if (existsSync(run)) {
      copyFileSync(run, join(dir, "your_program.sh"));
      chmodSync(join(dir, "your_program.sh"), 0o755);
    }

    phase = "testing";
    input.onPhase("testing");
    const env = {
      ...(process.env as Record<string, string>),
      PATH: `${shims}:${process.env.PATH ?? ""}`,
      CODECRAFTERS_SUBMISSION_DIR: dir,
      CODECRAFTERS_REPOSITORY_DIR: dir,
      CODECRAFTERS_CURRENT_STAGE: String(input.cases.length),
      // Testers find files shipped beside the binary (e.g. shell-tester's built_executables/) through TESTER_DIR.
      TESTER_DIR: dirname(input.testerPath),
      CODECRAFTERS_TEST_CASES_JSON: JSON.stringify(
        input.cases.map((c) => ({ slug: c.slug, tester_log_prefix: c.prefix, title: c.title })),
      ),
    };
    const code = await runStreaming([input.testerPath], { cwd: dir, env }, tester, timeoutMs);
    const results = parseTesterLog(tester.text, input.cases);
    if (code === 0) return outcome("passed", results);
    return outcome(results.some((r) => r.status === "failed") ? "failed" : "error", results);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    (phase === "testing" ? tester : build).add(message);
    return outcome("error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(shims, { recursive: true, force: true });
  }
}
