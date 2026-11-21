import { Marked, marked } from "marked";
import { ansiToHtml, stripAnsi } from "../src/ansi";
import type { RunSummary } from "../src/api";
import type { Catalog } from "../src/catalog";
import type { RunRecord, RunStatus, StageResultRecord } from "../src/store";
import { FINISHED } from "../src/events";

export type RunDetail = RunRecord & { stageResults: (StageResultRecord & { stageIndex: number })[] };

const LABELS: Record<RunStatus, string> = {
  queued: "Queued", building: "Building…", testing: "Testing…", passed: "Passed",
  failed: "Failed", build_failed: "Build failed", error: "Error",
};

/** The message to show for a failed API call: its JSON `error`, else the status and the start of the body. */
export function apiErrorMessage(status: number, body: string): string {
  try {
    const error = (JSON.parse(body) as { error?: unknown }).error;
    if (typeof error === "string") return error;
  } catch {}
  const text = body.trim().slice(0, 200);
  return text ? `${status}: ${text}` : String(status);
}

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Course accent hues: the temper colours steel takes on as it is heated (pale straw, straw, bronze, ember red,
 * purple, violet, blue, steel blue).
 */
export const TEMPER_HUES = [50, 40, 28, 10, 330, 285, 220, 200];

/** A stable accent hue per course, so a course looks the same on every page. */
export function courseHue(slug: string): number {
  let h = 7;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) % 3607;
  return TEMPER_HUES[h % TEMPER_HUES.length];
}

const ANVIL_LOGO = `<svg class="logo" viewBox="0 0 32 20" aria-hidden="true"><path d="M0 3.5 7 2h23v4.5h-5c-2.5.5-3.5 2-3.5 4V12l3.5 2.5V17H9v-2.5l3.5-2.5v-1.5c0-2-1.5-3.5-4.5-4C5 6 2 5 0 3.5Z"/></svg>`;

/**
 * Sparks rising from the forge glow at the bottom of the page, spread across its width. Seeded, so every page
 * gets the same sparks; negative delays start them mid-flight instead of all at once.
 */
export function sparksHtml(count: number): string {
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const round = (n: number) => Math.round(n * 10) / 10;
  const sparks = Array.from({ length: count }, (_, i) => {
    const dur = round(6 + random() * 8);
    const style = [
      `--x:${round(((i + random()) / count) * 100)}%`, // one spark per slice of the width
      `--dur:${dur}s`,
      `--delay:${round(-random() * dur)}s`,
      `--drift:${Math.round(-60 + random() * 120)}px`,
      `--rise:${Math.round(45 + random() * 50)}vh`,
      `--size:${round(1.5 + random() * 2.5)}px`,
    ].join(";");
    return `<i style="${style}"></i>`;
  });
  return `<div class="sparks" aria-hidden="true">${sparks.join("")}</div>`;
}

/** Attribution: anvil is unofficial; courses and testers are CodeCrafters' and are downloaded at runtime. */
export function footerHtml(): string {
  return `<footer class="site-footer"><p>anvil is an unofficial, independent project, not affiliated with CodeCrafters. Courses and testers are downloaded from <a href="https://github.com/codecrafters-io">CodeCrafters' public GitHub</a> and remain theirs. If you enjoy the courses, support them at <a href="https://codecrafters.io">codecrafters.io</a>.</p></footer>`;
}

export function navHtml(active: "home" | "courses" | null): string {
  const link = (href: string, label: string, key: "home" | "courses") =>
    `<a href="${href}"${active === key ? ' class="active" aria-current="page"' : ""}>${label}</a>`;
  return `<header class="topbar"><a class="brand" href="/">${ANVIL_LOGO}anvil</a><nav>${link(
    "/courses", "Courses", "courses",
  )}${link("/", "My repos", "home")}</nav></header>`;
}

export function progressHtml(done: number, total: number): string {
  const pct = total > 0 ? Math.round((done / total) * 1000) / 10 : 0;
  // The fill shows the part of a full-length heat scale it covers: early progress glows dull red, near done white-hot.
  const scale = pct > 0 ? Math.round(10000 / pct) : 100;
  return `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuenow="${done}" aria-valuemax="${total}"><span style="width:${pct}%;--fill-scale:${scale}%"></span></div>`;
}

const copyButton = (text: string) =>
  `<button type="button" class="copy" data-copy="${esc(text)}" aria-label="Copy commands">Copy</button>`;

/** A terminal-style box with commands to run and a copy button. */
export function terminalHtml(title: string, commands: string): string {
  return `<div class="terminal"><div class="terminal-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="terminal-title">${esc(
    title,
  )}</span>${copyButton(commands)}</div><pre>${esc(commands)}</pre></div>`;
}

/** What to run before the first push: clone a seeded repo, or connect an existing one. */
export function setupHtml(detail: { setupCommand: string; cloneCommand: string | null }): string {
  if (detail.cloneCommand) {
    const dir = detail.cloneCommand.split(" ").pop()!;
    return `<section class="setup"><h2>Clone your repo, commit your changes, then push to run the tests</h2>${terminalHtml(
      "Get started", `${detail.cloneCommand}\ncd ${dir}\ngit push origin main`,
    )}</section>`;
  }
  return `<section class="setup"><h2>Connect your repo, then push to run the tests</h2>${terminalHtml(
    "Get started", `${detail.setupCommand}\ngit push local HEAD:main`,
  )}</section>`;
}

/** Shown instead of a locked stage's instructions: the stage opens once the current one passes. */
export function lockedHtml(repo: string, current: { index: number; name: string }): string {
  return `<section class="locked-notice"><p><span aria-hidden="true">🔒</span> Locked: pass stage ${current.index} first.</p><a href="/r/${esc(
    repo,
  )}/${current.index}">Go to stage ${current.index}: ${esc(current.name)} →</a></section>`;
}

export type RepoListItem = {
  name: string;
  courseSlug: string;
  courseName: string;
  language: string;
  current: { index: number; name: string } | null;
  stageCount: number;
  passedCount: number;
};

/** The home page's repo cards, or an empty state that points at the catalog. */
export function repoCardsHtml(repos: RepoListItem[]): string {
  if (repos.length === 0) {
    return `<div class="empty"><div class="empty-icon" aria-hidden="true">${ANVIL_LOGO}</div><h2>No repos yet</h2><p>Pick a course and a language; anvil sets up a repo for you to clone.</p><a class="button" href="/courses">Browse courses</a></div>`;
  }
  return `<div class="card-grid">${repos
    .map(
      (r) => `<a class="card repo-card" href="/r/${esc(r.name)}" style="--hue:${courseHue(r.courseSlug)}">
        <div class="card-head"><span class="course-mark" aria-hidden="true">${esc(r.courseSlug.charAt(0).toUpperCase())}</span><div><strong>${esc(
          r.name,
        )}</strong><span class="muted">${esc(r.courseName)}</span></div><span class="chip">${esc(r.language)}</span></div>
        <div class="progress-row">${progressHtml(r.passedCount, r.stageCount)}<span class="muted">${r.passedCount} / ${r.stageCount}</span></div>
        <p class="next">${r.current ? `<span class="pulse-dot" aria-hidden="true"></span>Stage ${r.current.index}: ${esc(r.current.name)}` : "✓ All stages pass"}</p>
      </a>`,
    )
    .join("")}</div>`;
}

const STATUS_BADGES: Record<string, string> = { beta: "Beta", early_access: "Early access" };

/** The catalog as course cards; each links to the course page. */
export function coursesHtml(catalog: Catalog): string {
  const note = catalog.stale
    ? `<p class="note">anvil could not reach GitHub; this is the catalog saved on ${esc(new Date(catalog.fetchedAt).toLocaleString())}.</p>`
    : "";
  const cards = catalog.courses
    .map((c) => {
      const badge = STATUS_BADGES[c.releaseStatus] ? ` <span class="badge">${STATUS_BADGES[c.releaseStatus]}</span>` : "";
      const meta = [c.difficulty, `${c.stages.length} stages`].filter(Boolean).join(" · ");
      return `<a class="course-card" href="/courses/${esc(c.slug)}" style="--hue:${courseHue(c.slug)}" data-search="${esc(
        `${c.name} ${c.slug}`.toLowerCase(),
      )}"><div class="card-head"><span class="course-mark" aria-hidden="true">${esc(c.slug.charAt(0).toUpperCase())}</span><strong>${esc(
        c.name,
      )}${badge}</strong></div>${marked.parse(c.shortDescriptionMd, { async: false })}<span class="meta">${esc(meta)}</span></a>`;
    })
    .join("");
  return `${note}<div class="card-grid">${cards}</div>`;
}

export function stripText(run: RunSummary | null): string {
  if (!run) return "No pushes yet";
  return `${run.commitSha.slice(0, 7)} · ${run.branch} · ${LABELS[run.status]}`;
}

function logHtml(log: string, failureLine: string | null = null): string {
  const lines = log.split("\n").map((line) => {
    const html = ansiToHtml(line);
    const hit = failureLine !== null && !stripAnsi(line).startsWith("[your_program]") && stripAnsi(line).endsWith(failureLine);
    return hit ? `<mark>${html}</mark>` : html;
  });
  return `<pre class="log">${lines.join("\n")}</pre>`;
}

/** `hints`: show the Hint button under failed stages; `offNote`: say how to turn hints on when they are off. */
export function flyoutHtml(
  run: RunDetail, stageNames: Map<number, string>, opts: { hints?: boolean; offNote?: boolean } = {},
): string {
  const hint = (slug: string) =>
    opts.hints
      ? `<div class="hint-box" data-run="${run.id}" data-stage="${esc(slug)}"><div class="hint-texts"></div><button type="button" class="ghost hint-button">${hintButtonLabel(0)}</button></div>`
      : opts.offNote
        ? '<p class="muted hint-off">Hints are off: set hint.command in anvil.yml (see the README).</p>'
        : "";
  switch (run.status) {
    case "queued":
    case "building":
    case "testing":
      return `<p>Run in progress (${LABELS[run.status].replace("…", "")}).</p>`;
    case "passed": {
      const last = Math.max(0, ...run.stageResults.map((r) => r.stageIndex));
      const next = stageNames.has(last + 1) ? `<p><a href="/r/${run.repo}/${last + 1}">Continue to stage ${last + 1}: ${ansiToHtml(stageNames.get(last + 1)!)}</a></p>` : "";
      return `<p class="ok">All tests passed.</p>${next}`;
    }
    case "build_failed":
      return `<h3>Build failed</h3>${logHtml(run.buildLog)}`;
    case "error":
      return `<h3>The run ended with an error</h3>${logHtml(run.buildLog)}${logHtml(run.testerLog)}`;
    case "failed":
      return run.stageResults
        .filter((r) => r.status === "failed")
        .map(
          (r) =>
            `<section class="fail"><h3>Stage ${r.stageIndex}: ${ansiToHtml(stageNames.get(r.stageIndex) ?? r.stageSlug)}</h3>${logHtml(
              r.log,
              r.failureLine,
            )}${run.branch === "working tree" ? "" : `<details class="diff" data-run="${run.id}" data-stage="${esc(r.stageSlug)}" data-index="${r.stageIndex}"><summary>Changes since stage ${
              r.stageIndex
            } last passed</summary><div class="diff-body"></div></details>`}${hint(r.stageSlug)}</section>`,
        )
        .join("");
  }
}

/** The run the stage page follows: the newest by id, so an older run's updates never take over the page. */
export function followRun(current: RunSummary | null, incoming: RunSummary): RunSummary | null {
  return current === null || incoming.id >= current.id ? incoming : current;
}

export function titlePrefix(run: RunSummary | null): string {
  if (!run) return "";
  if (!FINISHED.has(run.status)) return "⏳ ";
  return run.status === "passed" ? "✓ " : "✗ ";
}

/** The anvil icon with a status dot, as a data URL; null when there is no run (the page keeps its own icon). */
export function faviconHref(run: RunSummary | null): string | null {
  if (!run) return null;
  const dot = !FINISHED.has(run.status) ? "#f59e0b" : run.status === "passed" ? "#22c55e" : "#ef4444";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d1b19"/><g transform="translate(6.4 20) scale(1.6)"><path fill="#ff8a24" d="M0 3.5 7 2h23v4.5h-5c-2.5.5-3.5 2-3.5 4V12l3.5 2.5V17H9v-2.5l3.5-2.5v-1.5c0-2-1.5-3.5-4.5-4C5 6 2 5 0 3.5Z"/></g><circle cx="50" cy="14" r="11" fill="${dot}" stroke="#1d1b19" stroke-width="3"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export type Advance = { passed: number; next: { index: number; name: string } | null };

/** How a run moved the current stage: null unless it moved forward (or completed the course). */
export function advanceOf(before: number | null, after: number | null, stages: { index: number; name: string }[]): Advance | null {
  if (before === null || (after !== null && after <= before)) return null;
  const passed = (after ?? stages.length + 1) - 1;
  const next = after === null ? null : stages.find((s) => s.index === after);
  return { passed, next: next ? { index: next.index, name: next.name } : null };
}

export function notificationText(
  repo: string, run: RunDetail, names: Map<number, string>, advance: Advance | null,
): { title: string; body: string } {
  const title = `${repo}: ${LABELS[run.status].replace("…", "")}`;
  const failed = run.stageResults.find((r) => r.status === "failed");
  const body =
    run.status === "passed"
      ? advance === null
        ? "All tests passed"
        : advance.next
          ? `Stage ${advance.passed} passed — on to stage ${advance.next.index}: ${advance.next.name}`
          : "Course complete"
      : run.status === "failed" && failed
        ? `Stage ${failed.stageIndex} failed: ${failed.failureLine ?? names.get(failed.stageIndex) ?? failed.stageSlug}`
        : run.status === "build_failed"
          ? "Build failed"
          : "The run ended with an error";
  return { title, body };
}

export function toastHtml(repo: string, advance: Advance): string {
  if (!advance.next) return `<div class="toast" role="status"><strong>Course complete 🎉</strong></div>`;
  return `<div class="toast" role="status"><strong>Stage ${advance.passed} passed</strong><a href="/r/${esc(repo)}/${
    advance.next.index
  }">On to stage ${advance.next.index}: ${esc(advance.next.name)} →</a></div>`;
}

export function liveLogHtml(lines: string[]): string {
  return `<pre class="log live">${lines.map(ansiToHtml).join("\n")}</pre>`;
}

/** A log line as one line of plain text, for the strip. */
export function liveLineText(line: string): string {
  return stripAnsi(line).trim();
}

export type KeyAction = "next" | "prev" | "flyout" | "rerun" | "test" | "help" | "escape";
const KEYS: Record<string, KeyAction> = {
  j: "next", ArrowRight: "next", k: "prev", ArrowLeft: "prev", l: "flyout", r: "rerun", t: "test", "?": "help",
};

/** The stage page shortcut for a key press; typing in a field or holding a modifier is never a shortcut. */
export function keyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; editable: boolean }): KeyAction | null {
  if (e.key === "Escape") return "escape";
  if (e.editable || e.ctrlKey || e.metaKey || e.altKey) return null;
  return KEYS[e.key] ?? null;
}

export function shortcutsHtml(): string {
  const rows: [string, string][] = [
    ["<kbd>j</kbd> <kbd>→</kbd>", "Next stage"], ["<kbd>k</kbd> <kbd>←</kbd>", "Previous stage"],
    ["<kbd>l</kbd>", "Run details"], ["<kbd>r</kbd>", "Re-run"], ["<kbd>t</kbd>", "Test this stage"],
    ["<kbd>?</kbd>", "This list"], ["<kbd>Esc</kbd>", "Close"],
  ];
  return `<div class="shortcuts" role="dialog" aria-label="Keyboard shortcuts"><h3>Keyboard shortcuts</h3><dl>${rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join("")}</dl></div>`;
}

/** A run in the history list: its summary plus its passed and failed stages. */
export type RunListItemView = RunSummary & { results: { stageIndex: number; status: "passed" | "failed" }[] };
export type StatsView = {
  runTimes: number[]; totalRuns: number; finishedRuns: number; passedRuns: number;
  stages: { index: number; name: string; attempts: number; firstPassAt: number | null; timeToPassMs: number | null }[];
};
export type DiffView = {
  base: string | null;
  files?: { path: string; added: number | null; removed: number | null }[];
  patch?: string;
  truncated?: boolean;
  missing?: true;
};

const pad = (n: number) => String(n).padStart(2, "0");
/** The local calendar day of a time, as YYYY-MM-DD (the browser's time zone, wherever anvil runs). */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const addDays = (t: number, days: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12).getTime(); // noon: safe across DST changes
};

/** Days in a row with a run, ending today, or yesterday when today has none yet. */
export function streak(runTimes: number[], now: number): number {
  const days = new Set(runTimes.map(dayKey));
  let day = days.has(dayKey(now)) ? now : addDays(now, -1);
  let n = 0;
  while (days.has(dayKey(day))) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

const CALENDAR_WEEKS = 52;
const level = (n: number) => (n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : 3);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A GitHub-style heatmap of the last 52 weeks: one column per week (oldest left, newest right), Monday at the top,
 * shaded by the number of runs that day; Mon/Wed/Fri labelled on the left and each month above the week it starts in.
 */
export function calendarHtml(runTimes: number[], now: number): string {
  const counts = new Map<string, number>();
  for (const t of runTimes) counts.set(dayKey(t), (counts.get(dayKey(t)) ?? 0) + 1);
  const today = dayKey(now);
  const monday = addDays(now, -((new Date(now).getDay() + 6) % 7));
  const start = addDays(monday, -7 * (CALENDAR_WEEKS - 1));
  const cells = Array.from({ length: CALENDAR_WEEKS * 7 }, (_, i) => {
    const key = dayKey(addDays(start, i));
    if (key > today) return `<i title="${key}" data-level="future"></i>`;
    const n = counts.get(key) ?? 0;
    return `<i title="${key}: ${n} run${n === 1 ? "" : "s"}" data-level="${level(n)}"></i>`;
  });
  const months: { column: number; name: string }[] = [];
  for (let week = 0; week < CALENDAR_WEEKS; week++) {
    const month = new Date(addDays(start, 7 * week)).getMonth();
    if (months.at(-1)?.name !== MONTHS[month]) months.push({ column: week + 1, name: MONTHS[month] });
  }
  // The first week is usually mid-month: drop its label when the next month's would overlap it.
  if (months.length > 1 && months[1].column - months[0].column < 3) months.shift();
  const days = ["Mon", "", "Wed", "", "Fri", "", ""].map((d) => `<span>${d}</span>`).join("");
  return `<div class="heatmap" style="--weeks:${CALENDAR_WEEKS}" role="img" aria-label="Runs per day, last ${CALENDAR_WEEKS} weeks"><div class="days" aria-hidden="true">${days}</div><div class="heatmap-scroll"><div class="months" aria-hidden="true">${months
    .map((m) => `<span style="grid-column:${m.column}">${m.name}</span>`)
    .join("")}</div><div class="calendar">${cells.join("")}</div></div></div>`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

export function relativeTime(t: number, now: number): string {
  const s = Math.floor((now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(t).toLocaleDateString();
}

/** `✓ 1–5 ✗ 6`: passed stages as ranges, then failed ones. */
export function stageSummaryText(results: { stageIndex: number; status: "passed" | "failed" }[]): string {
  const ranges = (xs: number[]) => {
    const out: string[] = [];
    for (const x of [...xs].sort((a, b) => a - b)) {
      const last = out.at(-1);
      const end = last ? Number(last.split("–").at(-1)) : Number.NaN;
      if (last && x === end + 1) out[out.length - 1] = `${last.split("–")[0]}–${x}`;
      else out.push(String(x));
    }
    return out.join(", ");
  };
  const passed = results.filter((r) => r.status === "passed").map((r) => r.stageIndex);
  const failed = results.filter((r) => r.status === "failed").map((r) => r.stageIndex);
  return [passed.length ? `✓ ${ranges(passed)}` : "", failed.length ? `✗ ${ranges(failed)}` : ""].filter(Boolean).join(" ");
}

export function runRowHtml(repo: string, run: RunListItemView, now: number): string {
  const duration = run.finishedAt === null ? "running" : formatDuration(run.finishedAt - run.createdAt);
  return `<details class="run-row ${run.status}" data-run="${run.id}" data-repo="${esc(repo)}"><summary><span class="run-id">#${run.id}</span><code>${esc(
    run.commitSha.slice(0, 7),
  )}</code><span class="chip">${esc(run.branch)}</span><span class="run-status">${LABELS[run.status]}</span><span class="stages">${esc(
    stageSummaryText(run.results),
  )}</span><span class="muted">${duration}</span><span class="muted when">${esc(relativeTime(run.createdAt, now))}</span></summary><div class="run-detail"></div></details>`;
}

const patchLine = (line: string) => {
  const html = esc(line);
  if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="add">${html}</span>`;
  if (line.startsWith("-") && !line.startsWith("---")) return `<span class="del">${html}</span>`;
  return html;
};

export function diffHtml(stageIndex: number, diff: DiffView): string {
  if (diff.base === null) return `<p class="muted">Stage ${stageIndex} has never passed, so there is nothing to compare.</p>`;
  if (diff.missing) return `<p class="muted">A commit in this comparison is no longer in anvil's copy of the repo.</p>`;
  if (!diff.files?.length) {
    return `<p class="muted">No changes since stage ${stageIndex} last passed (<code>${esc(diff.base.slice(0, 7))}</code>).</p>`;
  }
  const files = diff.files
    .map(
      (f) =>
        `<li><code>${esc(f.path)}</code> ${
          f.added === null ? '<span class="muted">binary</span>' : `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`
        }</li>`,
    )
    .join("");
  const note = diff.truncated ? '<p class="note">The patch is long; it was truncated.</p>' : "";
  return `<p class="muted">Compared with <code>${esc(diff.base.slice(0, 7))}</code>, where stage ${stageIndex} last passed.</p><ul class="diff-files">${files}</ul>${note}<pre class="log diff-patch">${(
    diff.patch ?? ""
  )
    .split("\n")
    .map(patchLine)
    .join("\n")}</pre>`;
}

const tile = (value: string, label: string) => `<div class="tile"><strong>${value}</strong><span class="muted">${label}</span></div>`;

export function statsHtml(stats: StatsView, now: number): string {
  const rate = stats.finishedRuns ? `${Math.round((stats.passedRuns / stats.finishedRuns) * 100)}%` : "—";
  const days = streak(stats.runTimes, now);
  const rows = stats.stages
    .map(
      (s) =>
        `<tr><td class="n">${s.index}</td><td>${esc(s.name)}</td><td class="n">${s.attempts}</td><td class="n">${
          s.timeToPassMs === null ? "—" : formatDuration(s.timeToPassMs)
        }</td></tr>`,
    )
    .join("");
  const table = rows
    ? `<table class="stage-stats"><thead><tr><th>#</th><th>Stage</th><th>Attempts</th><th>Time to pass</th></tr></thead><tbody>${rows}</tbody></table>`
    : "";
  return `<section class="stats"><div class="tiles">${tile(String(stats.totalRuns), "runs")}${tile(rate, "passed")}${tile(
    `🔥 ${days}`,
    `${days}-day streak`,
  )}</div>${calendarHtml(stats.runTimes, now)}${table}</section>`;
}

/** The home page's activity strip across all repos; empty before the first run. */
export function activityHtml(runTimes: number[], now: number): string {
  if (runTimes.length === 0) return "";
  const days = streak(runTimes, now);
  return `<section class="activity"><div class="activity-head"><h2 class="section-title">Activity</h2><span class="streak">🔥 ${days}-day streak</span></div>${calendarHtml(
    runTimes,
    now,
  )}</section>`;
}

/** Markdown for model output: raw HTML in it is shown as text, never rendered (marked escapes code spans itself). */
const hintMarkdown = new Marked({ renderer: { html: ({ text }) => esc(text) } });

/** The hints given so far for a stage, rendered as markdown. */
export function hintHtml(texts: string[]): string {
  return texts
    .map((t, i) => `<div class="hint-text"><p class="eyebrow">Hint ${i + 1}</p><div class="markdown">${hintMarkdown.parse(t, { async: false })}</div></div>`)
    .join("");
}

/** The hint command's output: the hint, and the failure the server appended after a NUL, if any. */
export function splitHintOutput(text: string): { hint: string; error: string | null } {
  const at = text.indexOf("\0");
  const hint = (at < 0 ? text : text.slice(0, at)).trim();
  const error = at < 0 ? null : text.slice(at + 1).trim();
  return { hint, error: error ?? (hint ? null : "the hint command printed nothing") };
}

/** The Hint button's label after `given` hints: three levels, each deeper. */
export function hintButtonLabel(given: number): string {
  if (given === 0) return "💡 Hint";
  return given < 3 ? `💡 Deeper hint (${given + 1}/3)` : "No deeper hints: you've got this";
}
