# `anvil test` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `anvil test [--stage N] [--remote <name>]` runs the course tests on the solution's working tree through the
running anvil, streaming output, without moving progress.

**Architecture:** The runner gets an archive source beside the commit source; `startRun` passes it through; a new
streaming `POST /api/repos/:repo/test` route accepts a tar; `src/cli.ts` (package `bin`) finds the anvil remote,
packs the working tree with git + tar, uploads, prints the stream and exits by the run's status.

**Tech Stack:** Bun 1.3, TypeScript, `git`, `tar`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-21-anvil-test-design.md`

## Global Constraints

- Branch recorded for working-tree runs: exactly `working tree`. Never moves progress (progress counts `main` only).
- Upload: `content-type: application/x-tar` (else 415); cap 200 MiB = 209,715,200 bytes (else 413); Bun
  `maxRequestBodySize` raised to at least that.
- Commit header `x-anvil-commit`: 40–64 hex chars, else 40 zeros.
- Response: `text/plain` stream of emitted lines, header `x-anvil-run: <id>`.
- Summary line: `Working tree: tested, but only pushes to main move progress.`
- CLI exit codes: 0 passed; 1 failed / build_failed / error; 2 usage, no anvil remote, anvil unreachable, refused.
- No new dependencies. Work on branch `anvil-test`; commit at the end.

## Review Focus

- Deleted-but-tracked files must not break packing: Task 3 test `packs tracked, new and unignored files only`.
- Ignored build output (`target/`) is not sent: same test.
- A stage option that is locked or out of range is refused before a run exists, and the CLI exits 2 with the
  message: Task 3 test `refused request exits 2 with the reason`.
- A working-tree run that passes does not move progress: Task 3 integration test.
- The diff route refuses working-tree runs and the toggle is hidden: Task 1 tests.

---

### Task 1: Archive source in the runner and `startRun`; no diffs for working-tree runs

**Files:** Modify `src/runner.ts`, `src/pushes.ts`, `src/api.ts` (diff route), `web/render.ts` (`flyoutHtml`); Test
`tests/runner.test.ts`, `tests/pushes.test.ts`, `tests/api.test.ts`, `tests/render.test.ts`

**Interfaces:**
- Produces:
  - `RunInput.source: { bareRepoDir: string; sha: string } | { archive: string }` (replaces top-level
    `bareRepoDir`/`sha`; `sha` stays for messages via the commit source). Archive: `tar -x -m -f <archive> -C <dir>`;
    failure → `could not unpack the working tree: <stderr>` and status `error`.
  - `startRun(deps, repo, { branch, sha, stage?, archive? }, emit)`: passes `archive` to the runner when set.
  - `export const WORKING_TREE = "working tree"` in `src/pushes.ts`; summary uses the working-tree line for it.
  - Diff route: 400 `working-tree runs have no diff` when `run.branch === WORKING_TREE`.
  - `flyoutHtml`: no `details.diff` when `run.branch === "working tree"`.

- [ ] **Step 1: Failing tests:** runner `runs from an archive` (tar of a fixture dir; compile + tester run; status
  passed); runner `a broken archive ends as error`; pushes `working-tree run says progress does not move` (output
  contains the summary line; `latestStageResults` empty); api `diff refuses working-tree runs`; render `no diff toggle
  for working-tree runs`.
- [ ] **Step 2:** run them → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `bun test && bun run typecheck` → pass.

---

### Task 2: `POST /api/repos/:repo/test`

**Files:** Modify `src/server.ts` (route, `maxRequestBodySize`); Test `tests/push.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `startRun` with `archive`.
- Produces: route per Global Constraints; validation (404 repo, 415, 413, 400 stage not whole, startRun's
  `RunRequestError` status) answered as JSON `{ error }` before any run; temp archive removed after `done`.

- [ ] **Step 1: Failing tests** (real server via `boot()`): `test route runs the uploaded tree` (tar of the fixture
  work dir → 200, stream contains `Stage 1`, header `x-anvil-run`, run branch `working tree`, progress empty);
  `test route needs a tar` (415); `test route refuses a locked stage` (409, no run); `test route rejects a stage that
  is not a number` (400).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** (store the body with `Bun.write` to a `mkdtemp` file; check `content-length` and the
  written size against the cap).
- [ ] **Step 4:** `bun test && bun run typecheck` → pass.

---

### Task 3: CLI

**Files:** Create `src/cli.ts`; Modify `package.json` (`bin`), `README.md`; Test `tests/cli.test.ts`

**Interfaces:**
- Produces (exported from `src/cli.ts` for tests):
  - `parseAnvilRemote(url: string): { base: string; repo: string } | null` (`^(https?://.+)/git/([a-z0-9][a-z0-9-]*)\.git/?$`).
  - `parseTestArgs(args: string[]): { stage?: number; remote?: string }` (throws a usage error on unknown flags or a
    missing value).
  - `findAnvil(cwd: string, remote?: string): { base: string; repo: string; root: string }` (throws with a helpful
    message for none/several).
  - `packWorkingTree(root: string): Promise<Uint8Array>` (git ls-files as in the spec, existing paths only, `tar -c`).
  - `runTest(opts: { cwd: string; stage?: number; remote?: string; out: (s: string) => void }): Promise<number>`
    returns the exit code.
  - `import.meta.main`: `anvil test ...` → `process.exit(await runTest(...))`; anything else → usage, exit 2.

- [ ] **Step 1: Failing tests:** `parseAnvilRemote` cases (http, https with Tailscale host, trailing slash, non-anvil
  URL → null); `parseTestArgs` (`--stage 3`, `--remote local`, bad flag throws); `findAnvil` picks the only anvil
  remote, errors on none and on several without `--remote`; `packs tracked, new and unignored files only` (fixture
  repo: modified tracked file, new file, deleted tracked file, ignored `target/x`; listing the tar shows the right
  set); integration against a real server: `runTest passes an uncommitted fix and leaves progress alone` (fixture
  whose committed `your_program.sh` fails, working copy fixed via env-free fake tester flag file, exit 0, run branch
  `working tree`), `refused request exits 2 with the reason`, `unreachable anvil exits 2`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**; `package.json` `"bin": { "anvil": "src/cli.ts" }`; README section "Test without
  committing" (`bun link` once, then `anvil test`, `--stage N`, exit codes).
- [ ] **Step 4:** `bun test && bun run typecheck` → pass; manual: `bun link`, `anvil test` in the scratch work repo
  against the scratch anvil.
