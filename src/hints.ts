import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "./ansi";
import { languageName } from "./course";
import { bareRepoDir } from "./git-remote";

export type HintLevel = 1 | 2 | 3;
export type HintInput = {
  language: string;
  stage: { index: number; name: string; descriptionMd: string };
  /** The failed stage's tester log. */
  log: string;
  /** The diff since the stage last passed, or null when it never passed. */
  diff: string | null;
  /** The learner's code, most relevant first; the prompt takes as many as fit. */
  files: { path: string; text: string }[];
  /** Files left out before the budget (binary or too large). */
  skipped?: string[];
  /** Files never read because the code budget ran out first. */
  notRead?: string[];
  /** A working-tree run (`anvil test`): there is no commit, so no code and no diff. */
  workingTree: boolean;
  level: HintLevel;
  /** Hints already given for this stage of this run. */
  previous: string[];
  maxBytes: number;
};

const LOG_CAP = 20 * 1024;
const DIFF_CAP = 30 * 1024;
const PREVIOUS_CAP = 4 * 1024;
/** Names listed in a "left out" note before "and N more". */
const LIST_NAMES = 20;
const names = (paths: string[]) =>
  paths.length > LIST_NAMES ? `${paths.slice(0, LIST_NAMES).join(", ")} and ${paths.length - LIST_NAMES} more` : paths.join(", ");

const LEVELS: Record<HintLevel, string> = {
  1: "a nudge: one or two questions, or which part of the instructions or the test output to re-read",
  2: "the concept: explain the idea or protocol detail involved, in general terms",
  3: "where in their code: name the file and function (or the part of the code) that is wrong and what to check there, without writing the fix",
};

const bytes = (s: string) => new TextEncoder().encode(s).length;
/** The last `cap` bytes of `text`, starting at a line. */
function tail(text: string, cap: number): string {
  if (bytes(text) <= cap) return text;
  const cut = text.slice(-cap);
  return `[… earlier lines left out]\n${cut.slice(cut.indexOf("\n") + 1)}`;
}
const head = (text: string, cap: number) => (bytes(text) <= cap ? text : `${text.slice(0, cap)}\n[… cut]`);

/**
 * The prompt for a hint, for any command-line model. The rules (never code, never the answer) open and close it, so
 * a model whose context drops the start still sees them. The learner's code fills whatever budget is left.
 */
export function buildHintPrompt(input: HintInput): string {
  const lang = languageName(input.language);
  const level = `Hint level ${input.level} of 3: ${LEVELS[input.level]}.`;
  const rules = `You are a patient tutor for someone learning ${lang} by working through a CodeCrafters-style course ("build your own …"). A stage of their project fails its tests and they asked for a hint.

Strict rules:
- Never write code, pseudo-code, a patch or a fix, and never give the answer. No code blocks.
- Guide with a question, a concept or where to look; leave the solving to them.
- At most about 150 words, in plain prose.
- Do not repeat earlier hints: go one step further.

${level}`;
  const reminder = `Remember: never write code or give the answer; at most about 150 words. ${level}`;
  // Every part scales with the budget, so a small maxPromptKB (a small local model) still leaves room for code.
  const share = (fraction: number, cap = Number.POSITIVE_INFINITY) => Math.min(cap, Math.floor(input.maxBytes * fraction));
  const previous = input.previous.length
    ? `## Earlier hints for this stage\n\n${input.previous
        .slice(-3)
        .map((h, i) => `${i + 1}. ${head(h, share(0.05, PREVIOUS_CAP))}`)
        .join("\n\n")}`
    : "";
  const diff = input.workingTree
    ? "## Changes since this stage last passed\n\nNot available: this run tested the learner's uncommitted working tree."
    : input.diff
      ? `## Changes since this stage last passed\n\n${head(input.diff, share(0.15, DIFF_CAP))}`
      : "## Changes since this stage last passed\n\nNone to show: the stage has never passed.";
  const sections = [
    rules,
    `## Stage ${input.stage.index}: ${input.stage.name}\n\n${head(input.stage.descriptionMd, share(0.2))}`,
    `## Test output (failing)\n\n${tail(stripAnsi(input.log), share(0.2, LOG_CAP))}`,
    diff,
    previous,
  ].filter(Boolean);

  const codeHeading = "## The learner's code";
  const fixed = bytes(sections.join("\n\n")) + bytes(reminder) + bytes(codeHeading) + 200; // 200: notes and joins
  let budget = input.maxBytes - fixed;
  const included: string[] = [];
  const left: string[] = [];
  for (const file of input.files) {
    const block = `### ${file.path}\n\n${file.text}`;
    if (bytes(block) + 2 <= budget) {
      included.push(block);
      budget -= bytes(block) + 2;
    } else {
      left.push(file.path);
    }
  }
  const notes = [
    input.workingTree ? "Not available: this run tested the learner's uncommitted working tree." : "",
    left.length ? `Left out to fit: ${names(left)}` : "",
    input.notRead?.length ? `Not read (over the budget): ${names(input.notRead)}` : "",
    input.skipped?.length ? `Not shown (binary or large): ${names(input.skipped)}` : "",
  ].filter(Boolean);
  const code = [codeHeading, ...included, ...notes].join("\n\n");
  return [...sections, code, reminder].join("\n\n");
}

const FILE_CAP = 50 * 1024;

/**
 * The text files of `sha` in the repo's remote: `changed` first (in that order), then the rest by path. Binary
 * files and files over 50 KB are skipped; reading stops once `maxTotal` bytes are gathered.
 */
export function gatherCode(
  dataDir: string, repoName: string, sha: string, changed: string[], maxTotal: number,
): { files: { path: string; text: string }[]; skipped: string[]; notRead: string[] } {
  const gitDir = bareRepoDir(dataDir, repoName);
  const listed = Bun.spawnSync(["git", "--git-dir", gitDir, "ls-tree", "-r", "-l", "-z", sha]);
  if (listed.exitCode !== 0) return { files: [], skipped: [], notRead: [] };
  const entries = listed.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .flatMap((line) => {
      // <mode> SP <type> SP <object> SP+ <size> TAB <path>
      const [meta, path] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
      const [, type, object, size] = meta.split(/\s+/);
      return type === "blob" ? [{ path, object, size: Number(size) }] : [];
    });
  // Changed files first (in order), then source, then setup files, lockfiles and docs, which rarely hold the bug.
  const background = (path: string) =>
    path.split("/").some((part) => part.startsWith(".")) || /(^|\/)(readme[^/]*|[^/]*\.(lock|md|sum)|package-lock\.json)$/i.test(path);
  const rank = (path: string) => {
    const i = changed.indexOf(path);
    return i >= 0 ? i : changed.length + (background(path) ? 1 : 0);
  };
  entries.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));

  const files: { path: string; text: string }[] = [];
  const skipped: string[] = [];
  const notRead: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (total >= maxTotal) {
      notRead.push(entry.path);
      continue;
    }
    if (entry.size > FILE_CAP) {
      skipped.push(entry.path);
      continue;
    }
    const blob = Bun.spawnSync(["git", "--git-dir", gitDir, "cat-file", "blob", entry.object]).stdout;
    if (blob.includes(0)) {
      skipped.push(entry.path);
      continue;
    }
    files.push({ path: entry.path, text: blob.toString() });
    total += blob.length;
  }
  return { files, skipped, notRead };
}

const OUTPUT_CAP = 20 * 1024;
export const HINT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Runs the configured hint command (`sh -c`, in an empty folder so a model with tools has no project to read) with the
 * prompt on stdin, and streams its stdout (capped). A failure or timeout ends the stream with a bracketed line.
 * Closing the stream kills the command. `onEnd` runs once, however it ends.
 */
export function runHintCommand(command: string, prompt: string, timeoutMs: number, onEnd: () => void): ReadableStream<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "anvil-hint-"));
  const spawn = () =>
    Bun.spawn(["sh", "-c", command], {
      cwd: dir, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", detached: true,
    });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    onEnd();
    throw e;
  }
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  };
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    kill();
    onEnd(); // first: a failed cleanup must not leave hints blocked
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let sent = 0;
        for await (const chunk of proc.stdout) {
          if (sent >= OUTPUT_CAP) continue; // keep draining so the command can finish
          const part = chunk.subarray(0, OUTPUT_CAP - sent);
          sent += part.length;
          controller.enqueue(part);
        }
        const code = await proc.exited;
        // A failure ends with NUL + message, so the page can tell it from the hint (splitHintOutput).
        if (timedOut) controller.enqueue(encoder.encode("\n\0hint timed out\n"));
        else if (code !== 0) {
          const first = (await new Response(proc.stderr).text()).trim().split("\n")[0] || `exit ${code}`;
          controller.enqueue(encoder.encode(`\n\0hint command failed: ${first}\n`));
        }
        controller.close();
      } catch {
        // the page went away mid-hint
      } finally {
        clearTimeout(timer);
        end();
      }
    },
    cancel() {
      clearTimeout(timer);
      end();
    },
  });
}
