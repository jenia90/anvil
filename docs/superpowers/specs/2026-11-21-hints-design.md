# Hint button (phase 5)

Phase 5 of the anvil improvements (stage lock ✓, feedback loop ✓, visibility ✓, `anvil test`/`submit` ✓, hints,
sandbox).

## Intent

When a stage fails, the learner can ask for a hint from a model of their choice. The courses are for learning: a hint
guides with concepts, questions and where to look, and never gives the solution or code. Anvil must not depend on
Claude: any command-line model works, including fully local ones.

## Goals

- A **Hint** button under each failed stage in a run's details (stage page flyout and history rows).
- Each click goes one level deeper: 1 a nudge (a question or what to re-read), 2 the concept involved, 3 where in
  the learner's code the problem is (file and function, described, not fixed). After level 3 the button is disabled.
- Hints stream into the page as they are written.
- The hint provider is a command in `anvil.yml`; with none configured, `claude -p` is used if `claude` is on PATH;
  otherwise there is no Hint button and the page says how to enable it.

## Non-goals

- Chat or follow-up questions; tool use by the model (reading files itself); remembering hints across reloads.
- Hints for passed runs, build failures or errors (only failed stages).
- Per-repo or per-course provider settings.

## Anti-goals

- A hint that contains a solution, a code fix, or code the learner can paste. The rule is in anvil's prompt, for every
  provider.
- The command coming from anywhere but the config file (the web page only asks for a hint of a run's stage).

## Approaches

- **Generic command, anvil builds the whole prompt (chosen with the learner).** The prompt goes to the command's
  stdin; its stdout is the hint. Works with `claude -p`, `codex exec -`, `gemini -p`, `ollama run <model>`, `llm`.
- Let the model read the code with tools (Claude `--allowedTools`): Claude-only, flags differ per tool. Rejected.
- Call model APIs directly: provider SDKs and keys in anvil. Rejected.

## Design

### Config (`src/config.ts`)

```yaml
hint:
  command: claude -p   # any shell command: reads the prompt on stdin, writes the hint to stdout
```

- `hint.command`: a non-empty string, run with `sh -c` (so flags and pipes work). Invalid type → config error.
- `hint: false` turns hints off (even when `claude` is installed). *(Builder check; executor's call.)*
- `hint.maxPromptKB`: positive integer, default 150; small local models need less. The code section takes what the
  budget leaves after the rest. *(Builder check.)*
- Absent: `claude -p` when `Bun.which("claude")` finds it at startup, else hints are off.
- `Config.hint: { command: string; maxPromptBytes: number } | null`.
- The command runs in an empty temporary folder, so a provider with tools (Claude) has no project files to read.
  `claude -p` prints its answer when done: with the default the hint appears at once, after a "writing…" state.
  *(Builder check; executor's call.)*

### Prompt (`src/hints.ts`)

Built by a pure function from:
- the rules: you are a tutor for a learner doing a CodeCrafters-style course in <language>; never write code or a
  fix, never give the answer; answer in at most ~150 words; the requested level and what it means (levels above);
  do not repeat the previous hints (included);
- stage number, name and instructions (rendered for the repo's language);
- the failed stage's tester log (ANSI stripped; last 20 KB if longer);
- the diff since the stage last passed (from phase 3), if there is one (cap 30 KB);
- the learner's code at the failing commit: text files from `git ls-tree -r` + `git show`, changed files first, then
  the rest by path; skip files over 50 KB and binary files (NUL byte); stop at 100 KB total and say what was left out.
  Working-tree runs have no commit to read: no code and no diff (the prompt says so);
- previous hints for this stage of this run (sent by the page), capped at 3 × 4 KB.
- The rules are repeated at the end of the prompt (a small model's context may drop the start). Stage text is
  rendered with `reader_is_bot: true` (courses carry notes meant for AI tutors). Changed files = the files in the
  diff since the stage last passed. *(Builder check.)*

### API (`src/api.ts` or `src/server.ts`)

- `GET /api/repos/:repo` adds `hints: boolean` (a command is configured or detected).
- `POST /api/repos/:repo/runs/:id/hint`, JSON `{ stage: <slug>, level: 1|2|3, previous: string[] }` (JSON-only as
  other POSTs):
  - 404 unknown repo/run; 409 `hints are not set up: add hint.command to anvil.yml` when off; 400 when the stage did
    not fail in that run or the level is not 1–3.
  - Runs the command with the prompt on stdin, streams stdout as `text/plain`. stderr is kept; if the command exits
    non-zero, a final line `[hint command failed: <first stderr line>]` is appended. Output capped at 20 KB.
    Timeout 3 minutes (process group killed; final line `[hint timed out]`). If the client disconnects, the command
    is killed.
  - One hint at a time across the app: while one is being written, another request gets 409
    `a hint is already being written; try again when it is done`. *(Builder check; executor's call.)*

### Page (`web/render.ts`, `web/app.ts`, `web/style.css`)

- `flyoutHtml(run, names, opts: { hints: boolean })`: each failed stage section gets, after the diff toggle,
  `<div class="hint" data-run data-stage data-level="0"><button>💡 Hint</button><div class="hint-text"></div></div>`
  when hints are on, else (only on the stage page flyout) a muted line "Hints are off: set hint.command in anvil.yml".
- Hint state (texts and level per run+stage) lives in the page, so re-rendering the flyout keeps it. The model's
  text is HTML-escaped before markdown rendering.
- Clicking streams the hint into `.hint-text` (plain text while streaming, rendered as markdown when done), keeps the
  previous hints above it, and relabels the button `💡 Deeper hint (2/3)` / `(3/3)`; after level 3 it is disabled
  with "No deeper hints: you've got this". The button is disabled while a hint streams; an error shows inline.

## Constraints

- No new dependencies.
- Prompt building is pure and unit-tested (rules present, level text, caps, file order, binary/large skip,
  working-tree case). The endpoint is tested with a fake command (a script that echoes stdin length and a line,
  and one that fails, one that sleeps for the timeout with a small test timeout).
- README section: how to configure, examples for several tools, and that the learner's code and logs are sent to
  whatever the command talks to.

## Left to the builder

- Exact prompt wording within the rules above.
- Markup and styling within the existing look.
