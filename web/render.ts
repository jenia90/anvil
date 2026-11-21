import { marked } from "marked";
import { ansiToHtml, stripAnsi } from "../src/ansi";
import type { RunSummary } from "../src/api";
import type { Catalog } from "../src/catalog";
import type { RunRecord, RunStatus, StageResultRecord } from "../src/store";

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

export function flyoutHtml(run: RunDetail, stageNames: Map<number, string>): string {
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
            `<section class="fail"><h3>Stage ${r.stageIndex}: ${ansiToHtml(stageNames.get(r.stageIndex) ?? r.stageSlug)}</h3>${logHtml(r.log, r.failureLine)}</section>`,
        )
        .join("");
  }
}
