# Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run history page with stats and calendar, diff since a failed stage last passed, and a combined activity
strip on the home page.

**Architecture:** `Store` gains light read queries; a pure `src/stats.ts` computes per-stage attempts and time to
pass; `src/git-remote.ts` gains a capped diff; `src/api.ts` adds four GET routes. Pure page logic (days, streak,
calendar, formatting, diff HTML) in `web/render.ts`; `web/app.ts` adds the history page, diff sections and home strip.

**Tech Stack:** Bun 1.3, TypeScript, `bun:sqlite`, `bun test`, plain DOM.

**Spec:** `docs/superpowers/specs/2026-11-21-visibility-design.md`

## Global Constraints

- No new dependencies. DOM wiring checked by hand.
- Calendar: 52 weeks (user request), GitHub-style labels, 7 rows, Monday first; shade steps by count 0 / 1–2 / 3–5 / 6+.
- History page size: default 50, max 200.
- Diff patch cap: 200 KiB (204,800 bytes), `truncated` when cut.
- Attempts and time to pass use `main` runs only; calendar, totals and pass rate use all runs.
- Copy: "Changes since stage N last passed" · "Stage N has never passed, so there is nothing to compare." ·
  "No changes since stage N last passed (`<sha7>`)." · "A commit in this comparison is no longer in anvil's copy of
  the repo."
- Work on branch `visibility` from `feedback-loop`; commit at the end when the user agrees.

## Review Focus

- A run in progress in the history list: no duration, label from status: Task 3 test `runRowHtml shows running`.
- Streak when today has no runs but yesterday has: Task 3 test `streak counts from yesterday when today is empty`.
- Times near midnight bucket into the browser's local day: Task 3 test `dayKey uses local dates`.
- A stage requested by a build failure counts as an attempt: Task 1 test `build failures count as attempts`.
- A diff whose base commit was garbage-collected returns `missing`: Task 2 test `diff reports a missing commit`.

---

### Task 1: Store queries and stage stats

**Files:** Modify `src/store.ts`; Create `src/stats.ts`; Test `tests/store.test.ts`, `tests/stats.test.ts`

**Interfaces:**
- Produces:
  - `type RunListItem = RunSummary-like fields (id, repo, branch, commitSha, status, stagesRequested, createdAt, finishedAt) & { results: { stageSlug: string; status: StageStatus }[] }`
  - `Store.listRuns(repo: string, opts: { before?: number; limit: number }): { runs: RunListItem[]; more: boolean }` newest first, no logs.
  - `Store.runTimes(repo?: string): number[]` createdAt of all runs (one repo or all), oldest first.
  - `Store.runCounts(repo: string): { total: number; finished: number; passed: number }`
  - `Store.mainRuns(repo: string): RunListItem[]` oldest first, branch `main`.
  - `Store.lastPassingCommit(repo: string, stageSlug: string, beforeRunId: number): string | null` commit of the newest `main` run with id < beforeRunId where the stage passed.
  - `stageStats(course: Course, mainRuns: RunListItem[]): { index: number; name: string; attempts: number; firstPassAt: number | null; timeToPassMs: number | null }[]` in `src/stats.ts`; only stages with ≥ 1 attempt.

- [ ] **Step 1: Failing tests:** `listRuns pages newest first with results` (5 runs, limit 2 → ids 5,4, more true; before 4 → 3,2); `runTimes for one repo and all`; `runCounts counts finished and passed`; `lastPassingCommit finds the newest earlier main pass` (ignores other branches and later runs); `stageStats counts attempts up to the first pass`; `build failures count as attempts`; `never-passed stage has null time`; `time to pass is first attempt createdAt to passing finishedAt`.
- [ ] **Step 2:** `bun test tests/store.test.ts tests/stats.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `bun test && bun run typecheck` → pass.

---

### Task 2: Diff and API routes

**Files:** Modify `src/git-remote.ts`, `src/api.ts`, `src/server.ts` (route order if needed); Test `tests/api.test.ts`, `tests/git-diff.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `diffCommits(dataDir: string, repoName: string, base: string, head: string, capBytes: number): { files: { path: string; added: number | null; removed: number | null }[]; patch: string; truncated: boolean } | { missing: true }` (`git diff --no-color --numstat`, then `git diff --no-color`; binary files have null counts; any non-zero git exit → missing).
  - `GET /api/repos/:repo/runs?before&limit` → `{ runs: (RunListItem with results mapped to { stageIndex, status })[], more }`; invalid `limit`/`before` → 400.
  - `GET /api/repos/:repo/stats` → `{ runTimes, totalRuns, finishedRuns, passedRuns, stages }`.
  - `GET /api/activity` → `{ runTimes }`.
  - `GET /api/repos/:repo/runs/:id/diff?stage=<slug>` → per spec (`{ base: null }`, `{ base, files, patch, truncated }`, `{ base, missing: true }`); 404 unknown repo/run; 400 when the stage did not fail in that run.

- [ ] **Step 1: Failing tests:** `diffCommits lists files and patch` and `diff is capped` and `diff reports a missing commit` (real bare repo from `makeFixtureRepo` plus a second commit); API: `runs list pages`, `runs list rejects a bad limit`, `stats returns counts, times and stages`, `activity spans repos`, `diff without an earlier pass has no base`, `diff 400 when the stage did not fail`, `diff 404 for another repo's run`.
- [ ] **Step 2:** run them → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `bun test && bun run typecheck` → pass.

---

### Task 3: Pure page helpers

**Files:** Modify `web/render.ts`; Test `tests/render.test.ts`

**Interfaces:**
- Produces:
  - `dayKey(t: number): string` local `YYYY-MM-DD`.
  - `streak(runTimes: number[], now: number): number` per spec.
  - `calendarHtml(runTimes: number[], now: number): string` 12×7 grid, cells `data-level="0..3"`, `title="<YYYY-MM-DD>: N runs"`.
  - `formatDuration(ms: number): string` → `45s`, `12m`, `1h 12m`, `3d 2h`.
  - `relativeTime(t: number, now: number): string` → `just now` (<60s), `5m ago`, `3h ago`, `2d ago`, else the local date.
  - `stageSummaryText(results: { stageIndex: number; status: "passed" | "failed" }[]): string` → passed indexes as ranges then failed, e.g. `✓ 1–5 ✗ 6`, `✓ 3`, `✗ 1`, `` for none.
  - `runRowHtml(repo: string, run: RunListItemView, now: number): string` (a `<details class="run-row" data-run="<id>">` whose summary has id, sha7, branch, label, stage summary, duration or `running`, relative time).
  - `type DiffView = { base: string | null; files?: { path: string; added: number | null; removed: number | null }[]; patch?: string; truncated?: boolean; missing?: true }`
  - `diffHtml(stageIndex: number, diff: DiffView): string` per spec copy; patch lines starting `+`/`-` (not `+++`/`---`) get classes `add`/`del`; escaped.
  - `statsHtml(stats, now): string` tiles (runs, pass rate %, streak), calendar, per-stage table.
  - `activityHtml(runTimes: number[], now: number): string` → `""` when empty, else the calendar and streak.

- [ ] **Step 1: Failing tests** for each, including `dayKey uses local dates` (two `new Date(y, m, d, 23, 59)` / `0, 1` values), `streak counts from yesterday when today is empty`, `streak is 0 after a gap`, `calendar has 84 cells and levels`, `runRowHtml shows running`, `diffHtml escapes and colours`, each diff message.
- [ ] **Step 2:** `bun test tests/render.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `bun test && bun run typecheck` → pass.

---

### Task 4: Pages

**Files:** Modify `web/app.ts`, `web/render.ts` (`flyoutHtml` failed sections get the diff `<details>` placeholder), `web/style.css`

- [ ] **Step 1:** `flyoutHtml` failed-stage sections append `<details class="diff" data-run="<id>" data-stage="<slug>" data-index="<n>"><summary>Changes since stage N last passed</summary><div class="diff-body"></div></details>`; update the existing `flyoutHtml` test expectations if needed (TDD: test the new summary text first).
- [ ] **Step 2:** `app.ts`: one delegated `toggle` listener for `details.diff` that fetches the diff once and renders `diffHtml`; route `/r/<repo>/runs` → `historyPage`; history page per spec (stats via `statsHtml`, list via `runRowHtml`, expand fetches `/runs/:id` and renders `flyoutHtml`, Load more); "History" link in stage crumbs and flyout header; home page fetches `/api/activity` and inserts `activityHtml` above My repos.
- [ ] **Step 3:** styles: calendar grid, levels in the course/accent hue, tiles, table, run rows, diff add/del.
- [ ] **Step 4:** `bun test && bun run typecheck` → pass; manual check on the scratch anvil via curl (API) and bundle contents; browser look is the user's.
