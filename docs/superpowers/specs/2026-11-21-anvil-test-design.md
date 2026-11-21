# `anvil test`: test the working tree (phase 4)

Phase 4 of the anvil improvements (stage lock ✓, feedback loop ✓, visibility ✓, `anvil test`, hint button,
sandbox). Builds on phases 1–3: runs, live log, history, `-o stage=N` and its lock rule.

## Intent

Iterate without committing: run the course tests on the solution's working tree (uncommitted changes included) from
the solution folder, like CodeCrafters' `codecrafters test`. Pushes stay the record of progress.

## Goals

- `anvil test` in a solution repo runs stages 1..current on the working tree and streams the output to the terminal.
- `anvil test --stage N` runs only stage N (same validation and lock as `git push -o stage=N`).
- The run is a normal anvil run: same queue, runner, live log on the stage page, history row.
- Exit code says how it went, for scripts and editors.

## Non-goals

- Moving progress (the learner's choice): working-tree runs never count, like runs on non-`main` branches.
- Watching files and re-running automatically.
- Diffs for working-tree runs (there is no commit to compare).

## Anti-goals

- Sending ignored files (build output such as `target/`) or anything outside the repo.
- A run that behaves differently from a push of the same files.

## Approaches

- **Upload a tar of the working tree to a new API route; the runner extracts it instead of `git archive` (chosen).**
  Reuses everything after checkout.
- Make a temporary commit and push it to a hidden ref: touches the user's git state and the remote. Rejected.
- Copy files on the server from the user's path: only works on the same machine and needs path trust. Rejected.

## Design

### CLI (`src/cli.ts`, `package.json` `bin`)

- `package.json` gets `"bin": { "anvil": "src/cli.ts" }` (Bun shebang). `bun link` in the anvil folder makes `anvil`
  available everywhere. README documents it.
- `anvil test [--stage N] [--remote <name>]`, run anywhere inside the solution repo.
- Finding anvil and the repo: the remotes whose fetch URL matches `<base>/git/<name>.git` (base: an `http(s)` URL).
  One match → use it. Several → `--remote <name>` picks one, else an error listing them. None → an error explaining
  how to add the remote.
- Files: from the repo root, `git ls-files -z --cached --others --exclude-standard`, minus paths that no longer exist
  (deleted but still tracked), sent as an uncompressed tar.
- Recorded commit: the local `HEAD` sha, or 40 zeros before the first commit.
- Upload: `POST <base>/api/repos/<name>/test` with `content-type: application/x-tar`, query `stage=N` when given,
  `x-anvil-commit: <sha>` header. The response body streams the run's output lines; the CLI prints them as they come.
- After the stream ends, the CLI reads the run (`x-anvil-run` response header → `GET /api/repos/<name>/runs/<id>`)
  and exits 0 if `passed`, 1 for `failed`/`build_failed`/`error`. Exit 2 for usage errors, no anvil remote, anvil not
  reachable, or a refused request (the API's `error` is printed).
- Ctrl-C stops the CLI; the run carries on and finishes (as with a push).
- `anvil` with no or unknown subcommand prints usage (exit 2). Only `test` exists for now.

### Server (`src/api.ts` or `src/server.ts`, `src/pushes.ts`, `src/runner.ts`)

- `POST /api/repos/:repo/test?stage=N`:
  - Content-type must be `application/x-tar` (415 otherwise). With the existing Origin check, a cross-site page
    cannot send it (a non-simple content type needs a preflight this server never approves).
  - Body capped at 200 MiB (413); the server's request body limit is raised to match (Bun defaults to 128 MiB). Stored in a temp file, removed when the run ends.
  - Validation before any run is created: unknown repo 404; `stage` not a whole number 400; stage checks as
    `startRun` (400/409, JSON `error`).
  - Starts a run with branch `working tree` and the `x-anvil-commit` sha (40 zeros if absent or not hex), streams
    every emitted line as `text/plain`, with header `x-anvil-run: <id>`.
- `startRun` accepts an optional archive path; the runner extracts it with `tar -x -m` into the run dir instead of
  `git archive`. Everything after checkout is unchanged.
- Summary line for working-tree runs: `Working tree: tested, but only pushes to main move progress.` (instead of the
  branch line).

### Pages

The run appears live on the stage page and in history with branch `working tree` (the chip shows it). The
"Changes since stage N last passed" toggle is not shown for working-tree runs, and the diff route answers 400 for
them: the recorded `HEAD` is not what was tested, so a diff would mislead. *(Builder check; executor's call.)*

## Constraints

- No new dependencies; uses `git` and `tar` (already required).
- Tests: CLI pure parts (remote URL parsing, argument parsing) unit-tested; an integration test runs the CLI function
  against a real anvil server with a fixture repo that has an uncommitted change, checking the change was tested and
  progress did not move; the API route's validation; runner extraction from an archive.

## Left to the builder

- Module layout of the CLI.
- Usage text wording.
