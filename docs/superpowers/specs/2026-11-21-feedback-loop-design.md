# Feedback loop (phase 2)

Phase 2 of the anvil improvements (order: stage lock ✓, feedback loop, visibility, `anvil test`, hint button,
sandbox). Builds on phase 1 (`docs/superpowers/specs/2026-11-21-stage-lock-design.md`): locked stages, progress
from `main` only.

## Intent

Make the push → result loop feel fast and alive. Today the tester output streams only into the `git push` terminal;
the stage page learns only status changes, every retry needs a new commit, and every push re-runs stages 1..current.
The learner works one stage at a time and wants to iterate on that stage quickly, see what is happening without
switching to the terminal, and get a clear, satisfying signal when a stage passes.

## Goals

1. **Live log:** tester and build output appear on the stage page line by line while a run is in progress.
2. **Notification, favicon, title:** the learner knows a run finished without looking at the tab.
3. **Re-run:** run the tests again on the latest pushed `main` commit without a new commit.
4. **Single stage:** `git push -o stage=N` and a "Test this stage" button run only stage N.
5. **Celebration:** passing the current stage is marked with a burst of sparks and a toast.
6. **Keyboard shortcuts** on the stage page.

## Non-goals

- Live output on the home or course pages (they have no run stream).
- Keeping live lines after a run ends: the stored build and tester logs already cover finished runs.
- Sound, multi-tab coordination, notification settings beyond the browser's permission.
- Running uncommitted code (phase 4, `anvil test`).

## Anti-goals

- Anything that lets a learner read or run a locked stage.
- A run that is triggered from the page but behaves differently from a push of the same commit (same queue, same
  runner, same stored records).
- Animations that ignore `prefers-reduced-motion`.

## Approaches

**Live log transport**
- **Extend the existing per-repo SSE stream (`/api/repos/:repo/events`) with a `log` event (chosen).** One
  connection already exists on the stage page; the server already publishes run updates through `RunEvents`.
- WebSocket: a second channel and protocol for one-way data. Rejected.
- Polling the run: laggy and wasteful. Rejected.

**Re-run and single-stage runs**
- **Extract the per-branch run from `handlePush` into one function used by pushes and by the new API (chosen).** Same
  queue, runner, store and summary; the only difference is where `emit` lines go.
- Fake a `git push` from the server. Rejected: hacky, and needs a new commit or a forced ref update.

**`-o stage=N` semantics:** run only stage N (learner's choice, option A). Its result counts toward progress like any
`main` result.

## Design

### 1. Run starts (`src/pushes.ts`)

One function starts a run for one commit; `handlePush` calls it per updated branch, and the re-run API calls it once.

- Inputs: repo, branch, commit sha, optional single stage index, `emit` for the pusher's terminal (a no-op for
  page-triggered runs).
- Stage selection: without a stage, `stagesToRun` as today. With stage N: exactly that stage.
- Validation for stage N, using `main` progress (`stageViews`): N must be an integer within the course and not
  locked. Otherwise no run is created and the reason is reported:
  - push: `anvil: stage N is locked; pass stage C first` or `anvil: no stage N in this course (1–M)` as `remote:`
    lines; the push itself is still accepted (post-receive cannot refuse).
  - API: 400 for out of range or not an integer, 409 for locked, with the same message as `error`.
- The lock is checked twice: when the run is requested (so the push or API can answer at once) and again when the
  queued job starts, against progress at that moment (a run queued ahead may have moved the current stage back). If
  stage N is locked when the job starts, the run ends as `error` with the line
  `anvil: stage N is locked; pass stage C first` in its tester log and emitted output; no tester runs. *(Builder
  check; executor's call.)*
- Every line passed to `emit` is also published as a live log line for the run (see 2), including the summary lines
  (`✔ Stage …`, `Current stage is now …`). Page-triggered runs therefore show the same text a push would.
- Order at the end of a run: store the result, emit the summary lines, then publish the finished run. The summary
  lines therefore reach the live log before the buffer is dropped and the flyout switches to the result view.
  *(Builder check; executor's call.)*
- Phase 1 behaviour stays: runs on branches other than `main` are tested up to `main`'s current stage and say they do
  not move progress.

### 2. Live log (`src/events.ts`, `src/api.ts`)

- `RunEvents` carries a second kind of event: a log line for a run id (`{ repo, runId, line }`), alongside the
  existing run updates.
- `RunEvents` keeps the lines of runs that are queued or in progress, per run id, so a page that connects mid-run
  replays them. Cap: 5,000 lines per run (oldest dropped first; the runner's own 1 MiB log cap still applies). A
  run's buffer is dropped when the run is published as finished.
- SSE `/api/repos/:repo/events`: on connect, after the latest `run` event, replay the buffered lines of that repo's
  unfinished runs; then forward new lines as `event: log` with data `{ "runId": number, "line": string }`. Lines keep
  their ANSI codes; the page renders them with the existing `ansiToHtml`.

### 3. Re-run and "Test this stage" API (`src/api.ts`)

`POST /api/repos/:repo/runs`, JSON body `{ "stage"?: number }`, same JSON-only rule as `POST /api/repos`
(content-type `application/json`, else 415).

- Commit: the current head of `main` in the repo's bare remote. No commits on `main` → 409
  `push your code first`.
- Branch recorded: `main`.
- Response: 202 with `{ "runId": number }` once the run is created; the run proceeds in the course queue.
- Unknown repo → 404. Stage validation as in 1.

### 4. Push options (`src/git-remote.ts`, `src/server.ts`)

- `ensureBareRepo` sets `receive.advertisePushOptions true`, so `git push -o stage=N` works against anvil's remote
  (existing repos get it at startup, like the hook refresh).
- The post-receive hook forwards each push option to the app (as repeated request headers or equivalent; builder's
  choice). Push options cannot contain newlines (git rejects them), so header values are safe.
- The app recognizes `stage=N`. Any other option: `anvil: ignoring unknown push option <opt>`. If several
  `stage=` options are given, the last one wins.
- A stage option applies to every branch updated by that push.

### 5. Stage page (`web/app.ts`, `web/render.ts`, `web/style.css`)

**Which run the page follows.** A repo can have several unfinished runs (a push updating two branches, two quick
pushes, a push then a re-run). The page follows the **newest run by id**: a `run` event for an older id updates
nothing on the page except when it is the followed run; `log` events for other run ids are ignored. Everything below
that says "the latest run" means the followed run: live log, strip, button state, title, favicon, notification,
celebration. *(Builder check; executor's call.)*

**Live output in the flyout.** While the latest run is queued, building or testing, the flyout shows a terminal-style
log of its live lines; it follows new lines unless the learner has scrolled up. When the run finishes, the flyout
switches to today's result view (failure details, build log, or pass link). The flyout is not opened
automatically.

**Strip.** While a run is in progress, the strip label also shows the newest log line (ANSI stripped, truncated by
CSS with an ellipsis). The strip gets a **Re-run** button (runs `POST …/runs` with no stage) when the repo has a
commit on `main`.

**"Test this stage" button** in the stage header, for unlocked stages, when the repo has a commit on `main`. Calls
`POST …/runs` with the page's stage. Both buttons are disabled while the latest run is unfinished, and show the API
error inline if the request fails.

**Tab title and favicon.** The title gets a status prefix while on a stage page: `⏳` queued/building/testing,
`✓` passed, `✗` failed/build failed/error, none when there are no runs. The favicon is swapped for the anvil icon with
a coloured status dot (in progress amber, passed green, otherwise red), generated as an SVG data URL.

**Notifications.** When a run finishes while the tab is hidden and notification permission is granted, show one
notification: title `<repo>: <Passed|Failed|Build failed|Error>`, body the stage summary (`Stage 2 passed — on to
stage 3: <name>`, or the first failed stage and failure line). Clicking it focuses the tab. Permission is asked only
from a user action: a small 🔔 button in the strip, shown while permission is `default`; hidden once granted or
denied.

**Celebration.** When a finished `main` run moves the current stage forward (or completes the course), and only for
runs the page saw finish live (not on page load):
- a burst of sparks from the strip, in the course hue, built from the existing spark styling;
- a toast: `Stage N passed` with a link `On to stage N+1: <name> →`, or `Course complete 🎉` when all stages pass.
  The toast closes itself after a few seconds or on click.
- With `prefers-reduced-motion: reduce`, no burst; the toast still shows.

**Keyboard shortcuts** (stage page only; ignored while focus is in an input, select, textarea or contenteditable, or
with Ctrl/Meta/Alt held):

| Key | Action |
|---|---|
| `j` / `→` | next stage, if unlocked |
| `k` / `←` | previous stage |
| `l` | open/close the run details flyout |
| `r` | Re-run |
| `t` | Test this stage |
| `?` | show/hide a small panel listing the shortcuts |
| `Esc` | close the flyout or the panel (exists today for the flyout) |

`r` and `t` follow the same enabled rules as their buttons.

## Constraints

- No new runtime dependencies. No new test dependencies (there is no DOM test setup; DOM wiring is checked by hand).
- Everything new that can be pure (favicon SVG, title prefix, notification text, celebration detection, key → action
  mapping, strip line text) lives in `web/render.ts` and has unit tests.
- Server behaviour is covered by `bun test`: run start with and without a stage, validation, the runs API, SSE log
  replay and live lines, push options end to end through a real `git push -o` in the integration test.
- Same security model as today: API routes go through the Host/Origin guard; POST requires JSON.

## Left to the builder

- How the hook forwards push options.
- Exact markup and styling of the live log, buttons, toast, burst and shortcut panel, within the existing look.
- How the page tracks whether the learner scrolled up in the live log.
- Toast duration (a few seconds).
