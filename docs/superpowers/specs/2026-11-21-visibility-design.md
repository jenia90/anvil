# Visibility: run history, diff since last pass, stats (phase 3)

Phase 3 of the anvil improvements (stage lock ✓, feedback loop ✓, visibility, `anvil test`, hint button, sandbox).
Builds on phases 1–2: progress counts `main` only; runs come from pushes, re-runs and single-stage runs.

## Intent

Let the learner see how they got here: every run, what changed since a failing stage last worked, and how they are
doing over time. Fun and motivating (streaks, a calendar), and practical for regressions (the diff).

## Goals

1. **Run history page** per repo, newest first, with each run's details on demand.
2. **Diff since last pass** for each failed stage in a failed run's details.
3. **Per-repo stats** on the history page: runs, pass rate, a 52-week calendar, day streak, per-stage attempts and
   time to pass.
4. **Combined activity** on the home page: a 52-week calendar and day streak across all repos.

## Non-goals

- Diffs for build failures or errors (no stage to anchor "last pass" on).
- Editing, deleting or exporting history.
- Charts beyond the calendar and the per-stage table.
- New data collection: everything comes from the existing `runs` and `stage_results` tables and git.

## Anti-goals

- Anything that reveals a locked stage's instructions (names are fine; they are already visible).
- Loading every run's logs to render the history list.

## Approaches

- **Server returns data, the page computes day buckets (chosen).** The API returns run timestamps; the browser buckets
  them into local-time days, so the calendar is right when anvil is opened from another device (Tailscale) in a
  different time zone. Per-stage attempts and times are computed on the server (they need no time zone).
- All on the server: wrong days for a browser in another time zone. Rejected.
- All in the browser from a full run list: loads every run for stats. Rejected.

There is one sensible way to do the diff: `git diff` between two commits in the repo's bare remote.

## Design

### Definitions

- **Run** counts every run (pushes, re-runs, single-stage runs) on any branch, for the calendar and run totals.
- **Pass rate:** finished runs with status `passed` ÷ finished runs. Unfinished runs are excluded.
- **Day:** a local calendar day in the browser's time zone.
- **Streak:** the number of consecutive days with at least one run, ending today; if today has none yet, ending
  yesterday (so a morning visit does not show 0). No runs yesterday or today → 0.
- **Calendar:** the last 52 weeks (widened at the user's request; fills the page width), GitHub-style: a 7-row grid, weeks as columns oldest to newest, Monday first, Mon/Wed/Fri labelled on the left and month names above the week each month starts in, cells shaded in 4 steps by run
  count (0, 1–2, 3–5, 6+), each with a tooltip `<date>: N runs`.
- **Per-stage attempts** (on `main` only, like progress): the number of `main` runs whose `stagesRequested` includes
  the stage, from the first such run up to and including the first run where the stage passed (all such runs if it
  never passed). Build failures count as attempts (they had requested the stage).
- **Per-stage time to pass:** wall-clock from the `createdAt` of the stage's first attempt to the `finishedAt` of the
  run where it first passed. Null if it never passed.

### API (`src/api.ts`, `src/store.ts`)

- `GET /api/repos/:repo/runs?before=<id>&limit=<n>`: run summaries (no logs), newest first, `limit` default 50, max
  200; each with `results: { stageIndex, status }[]` (passed/failed stage results of that run). Returns
  `{ runs, more: boolean }`.
- `GET /api/repos/:repo/stats`: `{ runTimes: number[] }` (createdAt of every run, any branch, oldest first; all of
  history, so a streak longer than the 52-week calendar shows its true length *(builder check; executor's call)*),
  `totalRuns`, `finishedRuns`, `passedRuns`, and `stages: { index, name, attempts, firstPassAt: number | null,
  timeToPassMs: number | null }[]` for every stage with at least one attempt.
- `GET /api/activity`: `{ runTimes: number[] }` across all repos, all of history, oldest first.
- `GET /api/repos/:repo/runs/:id/diff?stage=<slug>` for a failed stage of that run: the base is the commit of the
  newest `main` run before this one where that stage passed.
  - No base → `{ base: null }`.
  - Base equals the run's commit → `{ base, files: [], patch: "", truncated: false }` (nothing changed; the page
    says so).
  - Otherwise `{ base, files: { path, added, removed }[], patch, truncated }` from `git diff --numstat` and
    `git diff` (no colour) between base and the run's commit. Patch capped at 200 KiB; `truncated` true when cut.
  - Either commit no longer in the remote (a scratch branch deleted and garbage-collected) → `{ base, missing: true }`;
    the page says "A commit in this comparison is no longer in anvil's copy of the repo." *(Builder check; executor's
    call.)*
  - Unknown repo/run → 404; stage not failed in that run → 400.
  - Store queries needed: list runs by page with their stage results; stats aggregates; run times since a cutoff;
    newest passing run for a stage before a run id.

### Pages (`web/app.ts`, `web/render.ts`, `web/style.css`)

**Routing:** `/r/<repo>/runs` is the history page (today `/r/<repo>/<n>` is a stage; `runs` is not a number).

**History page:**
- Header: crumbs (My repos / course / repo / History), stats tiles (runs, pass rate, streak 🔥), the calendar, and the
  per-stage table (stage, attempts, time to pass formatted like `1h 12m`, `3d 2h`, `45s`; "—" if not passed).
- Run list: each row `#id`, short sha, branch, result label, stage summary (passed ranges and the failed stage, e.g.
  `✓ 1–5 ✗ 6`; single-stage runs show their one stage), duration (`finishedAt − createdAt`, or "running"), relative
  time ("2m ago"). Clicking a row expands it inline with the existing run details (`flyoutHtml`), fetched on expand.
- "Load more" button when `more` is true.
- Links to it: a "History" link on the stage page (in the crumbs line) and in the run details flyout header.

**Diff in run details** (flyout and history rows): under each failed stage, a collapsed `<details>` "Changes since
stage N last passed". Opening it fetches the diff and shows the file list (path, +added −removed) then the patch with
added/removed lines coloured. Messages: "Stage N has never passed, so there is nothing to compare." / "No changes since
stage N last passed (`abc1234`)." / a note when truncated.

**Home page:** above "My repos", an activity section: the combined 52-week calendar and `🔥 N-day streak` (hidden
when there are no runs at all).

## Constraints

- No new dependencies. Pure logic (day bucketing, streak, calendar HTML, stage summary text, duration and relative
  time formatting, diff HTML) in `web/render.ts`, unit-tested with a fixed "now" and an explicit time zone-independent
  input (tests pass local Dates).
- Server queries and the diff endpoint are covered by `bun test` (diff with a real bare repo with two commits).
- Same guard and JSON conventions as other API routes.

## Left to the builder

- Calendar and table styling, within the existing look.
- SQL shape of the store queries.
