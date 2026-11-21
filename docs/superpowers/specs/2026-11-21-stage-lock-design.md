# Stage lock and main-only progress (phase 1)

Phase 1 of the anvil improvements (order: stage lock, feedback loop, visibility, `anvil test`, hint button, sandbox).

## Intent

Work through a course the way CodeCrafters intends: one stage at a time, without reading ahead. A later stage's
instructions stay hidden until the learner reaches it. Separately, fix progress being moved by pushes to scratch
branches.

## Goals

- Stages after the current one are locked: name visible, instructions not sent to the browser.
- A stage stays unlocked once reached, even if a regression moves the current stage back.
- Only pushes to `main` move progress.

## Non-goals

- Changing what the tester runs. The first push still runs every stage, so existing code catches up and the stages
  it passes unlock.
- Hiding stage names (the course page timeline and the stage list still show them).
- `git push -o stage=N` and re-run: phase 2, and they will respect the lock.

## Approaches

- **Server-side lock (chosen).** The API omits instructions for locked stages and flags them `locked`. The text never
  reaches the browser; same effort as hiding it client-side.
- Client-side only (CSS/JS hiding). Rejected: text still served by the API and trivially readable.

## Design

### Lock rule (`src/progress.ts`)

A stage is **unlocked** when any of:

- there is no current stage (all pass),
- its index is at or before the current stage,
- it has a latest result (passed or failed) from an earlier run.

Otherwise it is **locked**. `stageViews` adds `locked: boolean`.

### API (`src/api.ts`, `GET /api/repos/:repo`)

Each stage gets `locked`. For locked stages `descriptionMd` is `""`.

### Web (`web/app.ts`)

- Stage list: locked stages render as non-link items with a 🔒 and the name.
- `/r/<repo>/<n>` for a locked stage: page body shows "Locked: pass stage X first" with a link to the current stage
  instead of instructions.
- Bottom nav: when the next stage is locked, show `🔒 <name>` as plain text, not a link.

### Main-only progress (`src/store.ts`)

`latestStageResults` counts only runs on branch `main` (the branch every anvil remote's HEAD points to). Runs on
other branches still execute (testing up to `main`'s current stage), are stored, and appear in the strip; they do not
move progress. Existing runs on other branches stop counting toward progress.

## Tests

- `progress.ts`: lock rule cases (fresh repo, mid-course, regression keeps reached stages unlocked, all passed).
- `store.ts`: results from non-`main` runs are ignored by `latestStageResults`.
- `api.ts`: locked stages have `locked: true` and empty `descriptionMd`.

## Left to the builder

Markup and styling of the lock icon and locked page, within the existing look.
