# Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live run output on the stage page, re-run and single-stage runs (button and `git push -o stage=N`),
finish signals (title, favicon, notification), a pass celebration, and keyboard shortcuts.

**Architecture:** `RunEvents` gains log-line events with a per-run buffer; one `startRun` in `src/pushes.ts` serves
pushes and a new `POST /api/repos/:repo/runs`; the SSE stream forwards `log` events; the post-receive hook forwards
push options as headers. Page logic that can be pure lives in `web/render.ts` (unit-tested); `web/app.ts` wires it.

**Tech Stack:** Bun 1.3, TypeScript, `bun:sqlite`, `bun test`, plain DOM.

**Spec:** `docs/superpowers/specs/2026-11-21-feedback-loop-design.md`

## Global Constraints

- No new runtime or test dependencies. DOM wiring is checked by hand.
- Finished statuses: `passed`, `failed`, `build_failed`, `error`. Unfinished: `queued`, `building`, `testing`.
- Live buffer cap: 5,000 lines per run, oldest dropped first.
- Copy (exact): `anvil: stage N is locked; pass stage C first` · `anvil: no stage N in this course (1–M)` ·
  `anvil: ignoring unknown push option <opt>` · API 409 `push your code first`. (API `error` strings omit the
  `anvil: ` prefix.)
- Single-stage runs record branch `main` when started from the API.
- POST routes require `content-type: application/json` (415 otherwise) and go through the server's Host/Origin guard.
- Do not commit until the user asks; work on branch `feedback-loop` cut from `stage-lock`.

## Review Focus

- A stage that is unlocked at request time but locked when the job starts (a queued run moved current back) must end
  as `error` without running the tester: Task 2 test `stage locked when the job starts ends as error`.
- `-o stage=abc` / `stage=0` / `stage=99` must not create a run and must print the reason: Task 2 test
  `invalid stage option runs nothing and says why`.
- A page connecting mid-run must see lines already printed: Task 3 test `SSE replays buffered lines of unfinished runs`.
- Two unfinished runs: the page follows the newest id and ignores the other's lines: Task 5 test
  `followRun keeps the newest id`.
- A shortcut typed into the search/select must not trigger: Task 5 test `keyAction ignores editable targets and
  modifiers`.

---

### Task 1: Log lines in `RunEvents`

**Files:** Modify `src/events.ts`; Test `tests/events.test.ts`

**Interfaces:**
- Produces:
  - `type LogEvent = { repo: string; runId: number; line: string }`
  - `RunEvents.publishLine(e: LogEvent): void`: appends to the run's buffer (cap 5,000) and calls line subscribers.
  - `RunEvents.subscribeLines(repo: string, fn: (e: LogEvent) => void): () => void`
  - `RunEvents.bufferedLines(repo: string): LogEvent[]`: buffered lines of that repo's unfinished runs, by run id
    then order.
  - `RunEvents.publish(e: RunEvent)` (existing): when `e.run.status` is finished, drops that run's buffer.
  - `export const FINISHED: ReadonlySet<RunStatus>` (also used by later tasks).

- [ ] **Step 1: Failing tests**: `lines reach line subscribers of their repo only`;
  `bufferedLines returns lines of unfinished runs in order`; `publishing a finished run drops its buffer`;
  `buffer keeps the newest 5000 lines` (publish 5,001; first buffered line is line #2); `a throwing line subscriber
  is removed` (same rule as run subscribers).
- [ ] **Step 2:** `bun test tests/events.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement** in `src/events.ts`.
- [ ] **Step 4:** `bun test && bun run typecheck` → all pass.

---

### Task 2: `startRun`, stage option, validation, event order

**Files:** Modify `src/pushes.ts`; Test `tests/pushes.test.ts`

**Interfaces:**
- Consumes: Task 1 `publishLine`, `FINISHED`.
- Produces:
  - `class RunRequestError extends Error { constructor(message: string, readonly status: 400 | 409) }`
  - `startRun(deps: PushDeps, repoName: string, req: { branch: string; sha: string; stage?: number }, emit: (line: string) => void): { runId: number; done: Promise<void> }`:
    validates synchronously (throws `UnknownRepoError` or `RunRequestError` before creating a run), creates the run,
    enqueues it. Every emitted line also goes to `deps.events.publishLine` for that run id.
  - `checkStage(course: Course, latest: Map<string, StageStatus>, stage: number): void`: throws `RunRequestError`
    with 400 for a non-integer or out-of-range stage (message `no stage N in this course (1–M)`; non-integer:
    `stage must be a whole number`), 409 when locked (`stage N is locked; pass stage C first`).
  - `handlePush(deps, repoName, updates, rawEmit, options: string[] = [])`: parses `stage=N` (last wins; non-numeric
    → 400 message), emits `anvil: ignoring unknown push option <opt>` for others; on a `RunRequestError` emits
    `anvil: <message>` and starts no runs; else calls `startRun` per branch update with the stage.

- [ ] **Step 1: Failing tests** (use the existing `setup()`; extend `push` with an `options` argument):
  - `stage option runs only that stage`: first push with `FAKE_FAIL_AT=2` (current = 2), then push with
    `["stage=2"]` → second run `stagesRequested` is `["ia4"]`.
  - `invalid stage option runs nothing and says why`: options `stage=0`, `stage=99`, `stage=abc`, and `stage=3` while
    current is 2 → no new run in the store; output contains the matching copy.
  - `unknown push options are reported and ignored`: `["foo=bar"]` → output contains
    `anvil: ignoring unknown push option foo=bar`; a run happens.
  - `stage locked when the job starts ends as error`: enqueue a blocking job on the course queue, call `startRun`
    for stage 2 with results making it unlocked, then make stage 1 fail in a run on `main` via the store before
    releasing the queue → run status `error`, tester log contains `stage 2 is locked`.
  - `summary lines are published before the finished run`: subscribe to lines and runs; the last line event
    (`Current stage…`) arrives before the run event with a finished status.
  - `startRun output lines are published as log events with the run id`.
- [ ] **Step 2:** `bun test tests/pushes.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement.** Move the per-update job out of `handlePush` into `startRun`. Job: re-check the stage
  with current `main` progress (locked → finish as `error` with the message as tester log, emit it, publish); select
  `[stage N]` or `stagesToRun`; at the end `finishRun` → `summarize` → `publish`.
- [ ] **Step 4:** `bun test && bun run typecheck` → all pass.

---

### Task 3: Runs API and SSE log stream

**Files:** Modify `src/api.ts`, `src/server.ts`, `src/git-remote.ts`; Test `tests/api.test.ts`

**Interfaces:**
- Consumes: Task 1 `subscribeLines`, `bufferedLines`; Task 2 `startRun`, `RunRequestError`, `UnknownRepoError`.
- Produces:
  - `mainHead(dataDir: string, repoName: string): string | null` in `src/git-remote.ts` (`git rev-parse --verify -q refs/heads/main`).
  - `ApiDeps.startRun: (repo: string, stage: number | undefined) => { runId: number }`; wired in `server.ts` with
    `mainHead` (null → `RunRequestError("push your code first", 409)`), branch `main`, `emit` a no-op.
  - `POST /api/repos/:repo/runs` body `{ stage?: number }` → 202 `{ runId }`; 400/409 from `RunRequestError`, 404
    unknown repo, 415 non-JSON.
  - `GET /api/repos/:repo` adds `canRun: boolean` (`mainHead !== null`).
  - SSE: after the initial `run` event, `event: log` for each `bufferedLines(repo)` entry, then live ones; data
    `{ "runId": number, "line": string }`.

- [ ] **Step 1: Failing tests** (`boot()` takes an optional `startRun` stub like `startCourse`):
  - `POST runs starts a run and returns 202 with its id`; `POST runs passes the stage`;
  - `POST runs maps RunRequestError to its status` (409 locked message, 400 range);
  - `POST runs needs JSON` (415);
  - `repo detail says whether it can run` (`canRun` false for a repo with no commits);
  - `SSE replays buffered lines of unfinished runs` (publish two lines for an unfinished run before connecting;
    first chunks contain `event: log` with both, in order);
  - `SSE forwards new log lines`.
  - In `tests/push.integration.test.ts`: `server-wired re-run tests the head of main` (push, then POST runs, await
    the second run finishing: same `commitSha`, branch `main`).
- [ ] **Step 2:** `bun test tests/api.test.ts tests/push.integration.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `bun test && bun run typecheck` → all pass.

---

### Task 4: Push options through the hook

**Files:** Modify `src/git-remote.ts` (`ensureBareRepo`), `src/server.ts` (`postReceive`); Test
`tests/push.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 `handlePush(..., options)`.
- Produces: hook sends each option as header `x-anvil-push-option-<i>` (i = 0..count-1) using
  `GIT_PUSH_OPTION_COUNT` / `GIT_PUSH_OPTION_<i>`; `postReceive` collects them in index order.

- [ ] **Step 1: Failing tests:** `ensureBareRepo` test asserts `receive.advertisePushOptions` is `true`;
  `git push -o stage=1 runs only stage 1` (real `git push -o stage=1`; `stderr` contains `Stage 1` and the run's
  `stagesRequested` is `["at4"]`); `git push -o stage=9 says no such stage`.
- [ ] **Step 2:** `bun test tests/push.integration.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Hook in POSIX `sh`: build curl `-H` args in a loop with `set --`, then call curl with
  `"$@"`.
- [ ] **Step 4:** `bun test && bun run typecheck` → all pass.

---

### Task 5: Pure page helpers

**Files:** Modify `web/render.ts`; Test `tests/render.test.ts`

**Interfaces:**
- Consumes: Task 1 `FINISHED`.
- Produces (all in `web/render.ts`):
  - `followRun(current: RunSummary | null, incoming: RunSummary): RunSummary | null` → `incoming` when its id ≥
    current's id (or current null), else `current`.
  - `titlePrefix(run: RunSummary | null): string` → `"⏳ "` unfinished, `"✓ "` passed, `"✗ "` other finished, `""` null.
  - `faviconHref(run: RunSummary | null): string | null` → `data:image/svg+xml,…` anvil icon with a dot
    `#f59e0b` (unfinished) / `#22c55e` (passed) / `#ef4444` (other); `null` for no run (keep the page's icon).
  - `type Advance = { passed: number; next: { index: number; name: string } | null }`
  - `advanceOf(before: number | null, after: number | null, stages: { index: number; name: string }[]): Advance | null`
    → null when `before` is null or `after` is not past `before`; `passed` = (after ?? stages.length + 1) − 1.
  - `notificationText(repo: string, run: RunDetail, names: Map<number, string>, advance: Advance | null): { title: string; body: string }`
    title `<repo>: Passed|Failed|Build failed|Error`; body `Stage P passed — on to stage N: <name>` /
    `Course complete` / `Stage X failed: <failureLine>` / `Build failed` / `The run ended with an error` /
    `All tests passed` (passed, no advance).
  - `toastHtml(repo: string, advance: Advance): string` → `Stage P passed` + link `On to stage N: <name> →` to
    `/r/<repo>/N`, or `Course complete 🎉`; escaped.
  - `liveLogHtml(lines: string[]): string` → `<pre class="log live">` with `ansiToHtml` per line.
  - `liveLineText(line: string): string` → ANSI stripped, trimmed.
  - `type KeyAction = "next" | "prev" | "flyout" | "rerun" | "test" | "help" | "escape"`
  - `keyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; editable: boolean }): KeyAction | null`
    with the spec's table (`Escape` → `"escape"` even when editable).
  - `shortcutsHtml(): string` (the panel listing the table).

- [ ] **Step 1: Failing tests:** one `describe` per function with the cases above, including `followRun keeps the
  newest id`, `keyAction ignores editable targets and modifiers`, escaping in `toastHtml`, ANSI in `liveLogHtml`.
- [ ] **Step 2:** `bun test tests/render.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `bun test && bun run typecheck` → all pass.

---

### Task 6: Stage page wiring

**Files:** Modify `web/app.ts`, `web/style.css`

**Interfaces:**
- Consumes: Task 3 API (`canRun`, `POST …/runs`, SSE `log`), Task 5 helpers.

- [ ] **Step 1: Implement** per spec section 5:
  - follow the newest run (`followRun`); keep `lines: string[]` for the followed run from `log` events (reset when
    the followed id changes);
  - flyout: `liveLogHtml(lines)` while unfinished, following new lines unless scrolled up; result view when finished;
  - strip: newest `liveLineText` while unfinished; **Re-run** button (when `canRun`); 🔔 button while
    `Notification.permission === "default"`;
  - **Test this stage** button in the stage header for unlocked stages (when `canRun`); both buttons disabled while
    the followed run is unfinished; API errors shown inline;
  - title prefix and favicon from the followed run;
  - on the followed `main` run finishing live: compute `advanceOf(before, after)` from the detail refresh;
    notification when `document.hidden` and permission granted (click focuses the window); celebration burst
    (skip under `prefers-reduced-motion`) and `toastHtml` toast when advanced;
  - keyboard via `keyAction`; `?` toggles `shortcutsHtml`; replace the existing Escape listener.
- [ ] **Step 2:** `bun test && bun run typecheck` → all pass.
- [ ] **Step 3: Manual check** on a scratch anvil (fixture course, `FAKE_DELAY_MS=300`): live lines appear in the
  flyout and strip; Re-run and Test this stage start runs and disable while running; `git push -o stage=2` works;
  title/favicon change; passing stage advances with toast; shortcuts work and don't fire in inputs. The browser
  check is the user's (no browser on host); verify API/SSE with curl.
