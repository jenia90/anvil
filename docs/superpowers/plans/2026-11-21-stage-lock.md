# Stage Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock stage instructions until the learner reaches the stage, and make only `main` pushes move progress.

**Architecture:** The lock is computed in `src/progress.ts` (`stageViews`) and enforced by the API, which omits
instructions for locked stages. The web app renders locked stages without links and shows a locked notice instead of
instructions. `Store.latestStageResults` filters to branch `main`.

**Tech Stack:** Bun 1.3, TypeScript, `bun:sqlite`, `bun test`, plain DOM in `web/app.ts`.

**Spec:** `docs/superpowers/specs/2026-11-21-stage-lock-design.md`

## Global Constraints

- Locked = there is a current stage, the stage's index is after it, and the stage has no latest result.
- Locked stages: API sends `locked: true` and `descriptionMd: ""`.
- Progress branch is exactly `main`.
- Tester behaviour (`stagesToRun`) is unchanged.
- Do not commit; the user commits.

## Review Focus

- A regression (stage 2 fails after 1–5 passed) must keep 3–5 unlocked: Task 1 test `regression keeps reached stages unlocked`.
- First-push catch-up that passes 1–4 and fails 5 must unlock 1–5 and lock 6+: covered by the same rule (5 has a result, 6 has none); Task 1 test `catch-up unlocks every stage with a result`.
- All stages passed: nothing locked: Task 1 test `nothing is locked when all pass`.
- A run on branch `feature` that passes stage 1 must not unlock stage 2 or move the current stage: Task 2 test.
- `/r/<repo>/<n>` with `n` beyond the course or locked must not show instructions: Task 3 manual check.

---

### Task 1: Lock rule and API exposure

**Files:**
- Modify: `src/progress.ts` (`StageView`, `stageViews`)
- Modify: `src/api.ts` (`GET /api/repos/:repo` stage mapping)
- Test: `tests/progress.test.ts`, `tests/api.test.ts`

**Interfaces:**
- Produces: `StageView = { stage; state; lastResult; locked: boolean }`. API stage objects gain `locked: boolean`; `descriptionMd` is `""` when locked.

- [ ] **Step 1: Write failing tests in `tests/progress.test.ts`** (fixture course has stages at4, ia4, ih0)

```ts
describe("stageViews locked", () => {
  const locked = (o: Record<string, StageStatus>) => stageViews(course, results(o)).map((v) => v.locked);
  test("fresh repo locks everything after stage 1", () => expect(locked({})).toEqual([false, true, true]));
  test("mid-course locks stages after current", () =>
    expect(locked({ at4: "passed", ia4: "failed" })).toEqual([false, false, true]));
  test("regression keeps reached stages unlocked", () =>
    expect(locked({ at4: "failed", ia4: "passed", ih0: "passed" })).toEqual([false, false, false]));
  test("catch-up unlocks every stage with a result", () =>
    expect(locked({ at4: "passed", ia4: "failed" })[1]).toBe(false));
  test("nothing is locked when all pass", () =>
    expect(locked({ at4: "passed", ia4: "passed", ih0: "passed" })).toEqual([false, false, false]));
});
```

- [ ] **Step 2: Write failing test in `tests/api.test.ts`**

Test `locked stages have no instructions`: boot, `seed(store)` (at4 passed, ia4 failed), GET `/api/repos/demo`.
Assert `stages.map(s => s.locked)` equals `[false, false, true]`, `stages[2].descriptionMd === ""`,
`stages[1].descriptionMd !== ""`.

- [ ] **Step 3: Run, expect FAIL**

Run: `bun test tests/progress.test.ts tests/api.test.ts`
Expected: new tests fail (`locked` undefined).

- [ ] **Step 4: Implement**

`stageViews`: add `locked: current !== null && stage.index > current && !latest.has(stage.slug)`.
API: map `locked: v.locked` and `descriptionMd: v.locked ? "" : renderStageMd(...)`.

- [ ] **Step 5: Run, expect PASS**

Run: `bun test && bun run typecheck`
Expected: all pass, no type errors.

---

### Task 2: Progress counts only `main`

**Files:**
- Modify: `src/store.ts` (`latestStageResults`)
- Test: `tests/store.test.ts`

**Interfaces:**
- Produces: `latestStageResults(repo: string): Map<string, StageStatus>` unchanged signature; now only runs with `branch = 'main'`.

- [ ] **Step 1: Write failing test** `latestStageResults ignores branches other than main`

```ts
const store = new Store(":memory:");
const r1 = store.createRun("demo", "main", "a", []);
finish(store, r1.id, [result("at4", "failed")]);
const r2 = store.createRun("demo", "feature", "b", []);
finish(store, r2.id, [result("at4", "passed"), result("ia4", "passed")]);
expect([...store.latestStageResults("demo")]).toEqual([["at4", "failed"]]);
```

- [ ] **Step 2: Run, expect FAIL**: `bun test tests/store.test.ts`

- [ ] **Step 3: Implement**: add `AND r.branch = 'main'` to the query; doc comment saying why (scratch branches do not move progress).

- [ ] **Step 4: Run, expect PASS**: `bun test && bun run typecheck`. Fix any existing test that relied on non-main runs counting.

---

### Task 3: Web UI for locked stages

**Files:**
- Modify: `web/app.ts` (`StageInfo`, `stagePage`: `renderList`, instructions, bottom nav)
- Modify: `web/render.ts` (new `lockedHtml`)
- Modify: `web/style.css` (`.stage.locked`, `.stage-nav .locked`, `.locked-notice`)
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: API stage `locked: boolean` (Task 1).
- Produces: `lockedHtml(repo: string, current: { index: number; name: string }): string` in `web/render.ts`.

- [ ] **Step 1: Write failing test** `lockedHtml links to the current stage`: `lockedHtml("demo", { index: 2, name: "Respond <200>" })` contains `href="/r/demo/2"`, contains `Respond &lt;200&gt;`, contains `Locked`.

- [ ] **Step 2: Run, expect FAIL**: `bun test tests/render.test.ts`

- [ ] **Step 3: Implement**
  - `lockedHtml`: a `<section class="locked-notice">` with "🔒 Locked: pass stage N first" and a link to `/r/<repo>/<N>` named with the stage (escaped).
  - `StageInfo` gains `locked: boolean`.
  - `renderList`: a locked stage renders as `<span class="stage locked" aria-disabled="true">` with `🔒` in the dot, number and name; no `href`.
  - `stagePage`: if the requested stage is locked, render the stage header plus `lockedHtml(repo, current)` instead of the `<article class="markdown">`. Requested index outside `1..stages.length` falls back to `stages[0]` as today.
  - Bottom nav: when `next.locked`, render `<span class="locked">🔒 ${name}</span>` instead of the link.
  - CSS: locked items muted and `cursor: default`, no hover background; notice styled like `.setup`.

- [ ] **Step 4: Run, expect PASS**: `bun test && bun run typecheck`

- [ ] **Step 5: Manual check**: start anvil on a scratch config (fixture course), open a repo page; confirm the stage list shows 🔒 items without links, `/r/<repo>/3` shows the locked notice with no instructions, and the next link is a 🔒 label.
