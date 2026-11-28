import { marked } from "marked";
import { ansiToHtml } from "../src/ansi";
import type { RunSummary } from "../src/api";
import { FINISHED } from "../src/events";
import type { Catalog, CatalogCourse } from "../src/catalog";
import {
  courseMarkHtml, type DiffView, type RepoListItem, type RunDetail, type RunListItemView, type StatsView, activityHtml, advanceOf, diffHtml,
  hintButtonLabel, hintHtml, runRowHtml, splitHintOutput, statsHtml, apiErrorMessage, courseHue, coursesHtml, esc, faviconHref, flyoutHtml,
  followRun, footerHtml, keyAction, liveLineText, liveLogHtml, lockedHtml, navHtml, notificationText, pageTitle, progressHtml,
  repoCardsHtml, setupHtml, shortcutsHtml, sparksHtml, stripText, titlePrefix, toastHtml,
} from "./render";

type StageInfo = {
  index: number; slug: string; name: string; difficulty: string; descriptionMd: string; extension: string | null;
  state: "done" | "current" | "upcoming"; lastResult: "passed" | "failed" | null; locked: boolean;
};
type RepoDetail = {
  name: string; course: { slug: string; name: string }; setupCommand: string; cloneCommand: string | null;
  currentIndex: number | null; stages: StageInfo[]; latestRun: RunSummary | null; canRun: boolean; hints: boolean;
};

const app = document.getElementById("app")!;
const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(apiErrorMessage(res.status, text));
  return JSON.parse(text) as T;
};
const md = (text: string) => marked.parse(text, { async: false });
const difficultyLabel = (d: string) => d.replace(/_/g, " ");
const mark = courseMarkHtml;

// Sparks from the forge, behind every page; outside #app so page changes do not restart them.
document.body.insertAdjacentHTML("afterbegin", sparksHtml(28));

// Copy buttons anywhere on the page: <button data-copy="text">.
document.addEventListener("click", async (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy ?? "");
    button.textContent = "Copied ✓";
    button.classList.add("done");
  } catch {
    button.textContent = "Select & copy";
  }
  setTimeout(() => {
    button.textContent = "Copy";
    button.classList.remove("done");
  }, 1600);
});

/** A calendar wider than the screen scrolls; start it at the newest week. */
const showToday = () => {
  for (const c of document.querySelectorAll<HTMLElement>(".heatmap-scroll")) c.scrollLeft = c.scrollWidth;
};

// Hints given per run and stage. Kept here, not in the markup, so re-rendering the run details keeps them.
const givenHints = new Map<string, string[]>();
const hintKey = (el: HTMLElement) => `${el.dataset.run}:${el.dataset.stage}`;

/** Fills every hint box under `root` from the hints given so far. */
function showHints(root: ParentNode): void {
  for (const box of root.querySelectorAll<HTMLElement>(".hint-box")) {
    const texts = givenHints.get(hintKey(box)) ?? [];
    box.querySelector(".hint-texts")!.innerHTML = hintHtml(texts);
    const button = box.querySelector<HTMLButtonElement>(".hint-button")!;
    button.textContent = hintButtonLabel(texts.length);
    button.disabled = texts.length >= 3 || box.dataset.busy === "1";
  }
}

// The Hint button: asks for the next level and streams the answer into the box.
document.addEventListener("click", async (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>(".hint-button");
  const box = button?.closest<HTMLElement>(".hint-box");
  if (!button || !box || button.disabled) return;
  const texts = givenHints.get(hintKey(box)) ?? [];
  if (texts.length >= 3) return;
  const repo = decodeURIComponent(location.pathname.split("/")[2] ?? "");
  box.dataset.busy = "1";
  button.disabled = true;
  button.textContent = "Writing a hint…";
  box.querySelector(".hint-error")?.remove();
  const live = document.createElement("div");
  live.className = "hint-text streaming";
  live.textContent = "…";
  box.querySelector(".hint-texts")!.append(live);
  try {
    const res = await fetch(`/api/repos/${encodeURIComponent(repo)}/runs/${box.dataset.run}/hint`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: box.dataset.stage, level: texts.length + 1, previous: texts }),
    });
    if (!res.ok) throw new Error(apiErrorMessage(res.status, await res.text()));
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of res.body!) {
      text += decoder.decode(chunk, { stream: true });
      live.textContent = splitHintOutput(text).hint;
    }
    // A failed command does not use up a level: show its error, keep the hints as they were.
    const { hint, error } = splitHintOutput(text);
    if (error) throw new Error(error);
    givenHints.set(hintKey(box), [...texts, hint]);
  } catch (err) {
    box.insertAdjacentHTML("beforeend", `<p class="error hint-error">${esc(err instanceof Error ? err.message : String(err))}</p>`);
  } finally {
    delete box.dataset.busy;
    live.remove();
    showHints(document); // the details may have been re-rendered while the hint was written
  }
});

async function homePage(): Promise<void> {
  const [repos, activity] = await Promise.all([
    getJson<RepoListItem[]>("/api/repos"),
    getJson<{ runTimes: number[] }>("/api/activity"),
  ]);
  const passed = repos.reduce((n, r) => n + r.passedCount, 0);
  app.innerHTML = `${navHtml("home")}
    <main class="page">
      <section class="hero">
        <p class="eyebrow">Push · test · temper</p>
        <h1>Forge your own <span class="gradient-text">everything</span>.</h1>
        <p class="lede">CodeCrafters courses, tested on your machine.${
          repos.length ? ` ${repos.length} repo${repos.length === 1 ? "" : "s"} · ${passed} stages passed.` : ""
        }</p>
        <a class="button" href="/courses">Start a course</a>
      </section>
      ${activityHtml(activity.runTimes, Date.now())}
      <section>
        <h2 class="section-title">My repos</h2>
        ${repoCardsHtml(repos)}
      </section>
    </main>${footerHtml()}`;
  showToday();
}

const skeletonCards = (n: number) =>
  `<div class="card-grid">${'<div class="card skeleton" aria-hidden="true"><i></i><i></i><i></i></div>'.repeat(n)}</div>`;

async function coursesPage(): Promise<void> {
  app.innerHTML = `${navHtml("courses")}
    <main class="page">
      <section class="hero compact">
        <p class="eyebrow">Catalog</p>
        <h1>What will you <span class="gradient-text">forge</span> next?</h1>
        <p class="lede">Every course from codecrafters-io, with the real tester and full instructions.</p>
        <label class="search"><span class="sr-only">Search courses</span><input id="search" type="search" placeholder="Search courses…" autocomplete="off" /></label>
      </section>
      <div id="catalog">${skeletonCards(6)}</div>
    </main>${footerHtml()}`;
  const target = document.getElementById("catalog")!;
  const res = await fetch("/api/courses");
  const text = await res.text();
  if (!res.ok) {
    target.innerHTML = `<div class="empty"><h2>Could not load the catalog</h2><p class="error">${esc(
      apiErrorMessage(res.status, text),
    )}</p><a class="button" href="/courses">Try again</a></div>`;
    return;
  }
  target.innerHTML = coursesHtml(JSON.parse(text) as Catalog);
  const search = document.getElementById("search") as HTMLInputElement;
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    for (const card of target.querySelectorAll<HTMLElement>(".course-card")) {
      card.hidden = q !== "" && !(card.dataset.search ?? "").includes(q);
    }
  };
}

async function coursePage(slug: string): Promise<void> {
  const course = await getJson<CatalogCourse & { repos: string[] }>(`/api/courses/${encodeURIComponent(slug)}`);
  document.title = pageTitle(course.name);
  let lastExtension: string | null = null;
  const stages = course.stages
    .map((s, i) => {
      const heading = s.extension && s.extension !== lastExtension ? `<li class="timeline-group">${esc(s.extension)}</li>` : "";
      lastExtension = s.extension;
      return `${heading}<li><span class="num">${i + 1}</span>${esc(s.name)}</li>`;
    })
    .join("");
  const status = course.releaseStatus === "live" ? "" : ` <span class="badge">${esc(difficultyLabel(course.releaseStatus))}</span>`;
  const started = course.repos.length
    ? `<div class="started"><p class="muted">Already started</p>${course.repos
        .map((r) => `<a class="chip link" href="/r/${esc(r)}">${esc(r)} →</a>`)
        .join("")}</div>`
    : "";

  app.innerHTML = `${navHtml("courses")}
    <main class="page" style="--hue:${courseHue(course.slug)}">
      <section class="hero course-hero">
        <p class="crumbs"><a href="/courses">Courses</a> / ${esc(course.slug)}</p>
        <div class="hero-title">${mark(course.slug, " big")}<h1>${esc(course.name)}${status}</h1></div>
        <div class="lede">${md(course.shortDescriptionMd)}</div>
        <div class="pills"><span class="pill">${esc(difficultyLabel(course.difficulty || "—"))}</span><span class="pill">${course.stages.length} stages</span><span class="pill">${course.languages.length} languages</span></div>
      </section>
      <div class="course-layout">
        <div>
          <article class="markdown">${md(course.descriptionMd)}</article>
          <h2 class="section-title">Stages</h2>
          <ol class="timeline">${stages}</ol>
        </div>
        <aside class="start-card card">
          <h2>Start this course</h2>
          <p class="muted">anvil creates a repo with the starter code. You clone it, commit, and push to run the tests.</p>
          <form id="start">
            <label for="language">Language</label>
            <select id="language" name="language">${course.languages
              .map((l) => `<option value="${esc(l.slug)}"${l.slug === "rust" ? " selected" : ""}>${esc(l.name)}</option>`)
              .join("")}</select>
            <button class="button wide" type="submit">Start ${esc(course.name.replace(/^Build your own /, ""))}</button>
            <p id="start-status" role="status"></p>
          </form>
          ${started}
        </aside>
      </div>
    </main>${footerHtml()}`;

  const form = document.getElementById("start") as HTMLFormElement;
  const button = form.querySelector("button")!;
  const statusLine = document.getElementById("start-status")!;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const language = (form.elements.namedItem("language") as HTMLSelectElement).value;
    button.disabled = true;
    button.classList.add("loading");
    statusLine.className = "muted";
    statusLine.textContent = "Setting up your repo… (the first start of a course downloads it)";
    try {
      const r = await fetch("/api/repos", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ course: course.slug, language }),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(apiErrorMessage(r.status, text));
      location.href = `/r/${encodeURIComponent((JSON.parse(text) as { name: string }).name)}`;
    } catch (err) {
      statusLine.className = "error";
      statusLine.textContent = err instanceof Error ? err.message : String(err);
      button.disabled = false;
      button.classList.remove("loading");
    }
  };
}

const stageSymbol = (s: StageInfo) => (s.locked ? "🔒" : s.state === "done" ? "✓" : s.state === "current" ? "▶" : "");

async function stagePage(repo: string, requested: number | null): Promise<void> {
  let detail = await getJson<RepoDetail>(`/api/repos/${repo}`);
  const index = requested ?? detail.currentIndex ?? detail.stages.length;
  if (requested === null) history.replaceState(null, "", `/r/${repo}/${index}`);
  const stage = detail.stages.find((s) => s.index === index) ?? detail.stages[0];
  const names = () => new Map(detail.stages.map((s) => [s.index, s.name] as const));
  const meta = [`Stage ${stage.index} of ${detail.stages.length}`, stage.extension, difficultyLabel(stage.difficulty)]
    .filter((m): m is string => Boolean(m))
    .map(esc)
    .join(" · ");

  app.innerHTML = `${navHtml(null)}
    <div class="layout" style="--hue:${courseHue(detail.course.slug)}">
      <aside id="stage-list" class="sidebar"></aside>
      <main id="instructions">
        <p class="crumbs"><a href="/">My repos</a> / <a href="/courses/${esc(detail.course.slug)}">${esc(detail.course.name)}</a> / ${esc(detail.name)} · <a href="/r/${esc(repo)}/runs">History</a></p>
        <div id="setup"></div>
        <header class="stage-head"><p class="eyebrow">${meta}</p><div class="stage-title"><h1>${esc(stage.name)}</h1><button type="button" id="test-stage" class="ghost" hidden>Test this stage <kbd>t</kbd></button></div><p id="run-error" class="error" role="alert" hidden></p></header>
        <div id="stage-body"></div>
      </main>
    </div>
    <div id="run-strip" class="none">
      <button type="button" class="strip-main" aria-controls="flyout"></button>
      <button type="button" class="strip-action" id="rerun" hidden>Re-run</button>
      <button type="button" class="strip-action" id="notify" hidden title="Notify me when a run finishes" aria-label="Notify me when a run finishes">🔔</button>
    </div>
    <aside id="flyout" hidden aria-label="Run details"></aside>
    <div id="shortcuts" hidden></div>`;

  const list = document.getElementById("stage-list")!;
  const strip = document.getElementById("run-strip")!;
  const stripMain = strip.querySelector<HTMLButtonElement>(".strip-main")!;
  const rerunButton = document.getElementById("rerun") as HTMLButtonElement;
  const notifyButton = document.getElementById("notify") as HTMLButtonElement;
  const testButton = document.getElementById("test-stage") as HTMLButtonElement;
  const runError = document.getElementById("run-error")!;
  const flyout = document.getElementById("flyout")!;
  const shortcuts = document.getElementById("shortcuts")!;
  const setup = document.getElementById("setup")!;
  const body = document.getElementById("stage-body")!;
  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const pageIcon = favicon?.href ?? "";
  const baseTitle = pageTitle(detail.course.name, `Stage ${stage.index}: ${stage.name}`);
  let latest = detail.latestRun;
  let lines: string[] = [];
  let requesting = false; // a run request is in flight: buttons and shortcuts wait for its run to show up
  const seenRunning = new Set<number>(); // runs this page watched before they finished: only those celebrate
  const running = () => latest !== null && !FINISHED.has(latest.status);

  // Instructions (or the locked notice) and the prev/next links; re-rendered when a run unlocks stages.
  const renderBody = () => {
    const at = (i: number) => detail.stages.find((s) => s.index === i);
    const shown = at(stage.index) ?? stage;
    const [prev, next, current] = [at(stage.index - 1), at(stage.index + 1), at(detail.currentIndex ?? 0)];
    body.innerHTML = `${
      shown.locked && current
        ? lockedHtml(repo, current)
        : `<article class="markdown">${md(shown.descriptionMd || "_This course definition has no instructions for this stage._")}</article>`
    }
        <nav class="stage-nav">${prev ? `<a href="/r/${esc(repo)}/${prev.index}">← ${esc(prev.name)}</a>` : "<span></span>"}${
          !next ? "" : next.locked ? `<span class="locked">🔒 ${esc(next.name)}</span>` : `<a href="/r/${esc(repo)}/${next.index}">${esc(next.name)} →</a>`
        }</nav>`;
  };

  const renderList = () => {
    const passed = detail.stages.filter((s) => s.lastResult === "passed").length;
    list.innerHTML = `<div class="sidebar-head">${mark(detail.course.slug)}<div><strong>${esc(detail.course.name)}</strong><span class="muted">${passed} of ${
      detail.stages.length
    } passed</span></div></div>${progressHtml(passed, detail.stages.length)}<div class="stage-items">${detail.stages
      .map(
        (s, i) =>
          // Extension stages follow the base stages; each extension gets a heading where it starts.
          (s.extension && s.extension !== detail.stages[i - 1]?.extension ? `<h3 class="extension">${esc(s.extension)}</h3>` : "") +
          (s.locked
            ? // Locked stages are not links: their instructions open once the current stage passes.
              `<span class="stage locked${s.index === stage.index ? " selected" : ""}" aria-disabled="true"><span class="dot" aria-label="locked">${stageSymbol(s)}</span><span class="n">${s.index}</span><span class="name">${esc(s.name)}</span></span>`
            : `<a href="/r/${esc(repo)}/${s.index}" class="stage ${s.state}${s.index === stage.index ? " selected" : ""}${
                s.lastResult === "failed" ? " failed" : ""
              }"${s.index === stage.index ? ' aria-current="page"' : ""}><span class="dot">${stageSymbol(s)}</span><span class="n">${s.index}</span><span class="name">${esc(s.name)}</span></a>`),
      )
      .join("")}</div>`;
    list.querySelector(".selected")?.scrollIntoView({ block: "center" });
  };

  const renderStrip = () => {
    strip.className = latest?.status ?? "none";
    const live = running() && lines.length ? liveLineText(lines[lines.length - 1]) : "";
    stripMain.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="label">${esc(stripText(latest))}</span><span class="live-line">${esc(
      live,
    )}</span>${latest ? `<span class="hint">${flyout.hidden ? "Details ↑" : "Close ↓"}</span>` : ""}`;
    setup.innerHTML = latest ? "" : setupHtml(detail);
    rerunButton.hidden = !detail.canRun;
    rerunButton.disabled = running() || requesting;
    // Shown once the stage is unlocked, which can happen live while the page is open.
    testButton.hidden = !detail.canRun || (detail.stages.find((s) => s.index === stage.index)?.locked ?? true);
    testButton.disabled = running() || requesting;
    notifyButton.hidden = !("Notification" in window) || Notification.permission !== "default";
    document.title = `${titlePrefix(latest)}${baseTitle}`;
    const icon = faviconHref(latest);
    if (favicon) favicon.href = icon ?? pageIcon;
  };

  const closeFlyout = () => {
    flyout.hidden = true;
    renderStrip();
  };
  const flyoutHeader = () =>
    `<header><div><p class="eyebrow">${running() ? "Live output" : "Latest run"} · <a href="/r/${esc(repo)}/runs">History</a></p><strong>${esc(
      stripText(latest),
    )}</strong></div><button type="button" class="ghost" id="close-flyout" aria-label="Close">✕</button></header>`;
  const renderFlyout = async () => {
    if (!latest) return;
    if (running()) {
      flyout.innerHTML = `${flyoutHeader()}${liveLogHtml(lines)}`;
      flyout.scrollTop = flyout.scrollHeight;
    } else {
      const run = await getJson<RunDetail>(`/api/repos/${repo}/runs/${latest.id}`);
      flyout.innerHTML = `${flyoutHeader()}${flyoutHtml(run, names(), { hints: detail.hints, offNote: true })}`;
      showHints(flyout);
      flyout.querySelector("mark")?.scrollIntoView({ block: "center" });
    }
    document.getElementById("close-flyout")!.onclick = closeFlyout;
  };
  const toggleFlyout = async () => {
    if (!latest) return;
    flyout.hidden = !flyout.hidden;
    renderStrip();
    if (!flyout.hidden) await renderFlyout();
  };

  const startRun = async (stageIndex?: number) => {
    if (!detail.canRun || running() || requesting) return;
    runError.hidden = true;
    requesting = true;
    renderStrip();
    try {
      const r = await fetch(`/api/repos/${encodeURIComponent(repo)}/runs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(stageIndex === undefined ? {} : { stage: stageIndex }),
      });
      if (!r.ok) throw new Error(apiErrorMessage(r.status, await r.text()));
    } catch (err) {
      runError.textContent = err instanceof Error ? err.message : String(err);
      runError.hidden = false;
      requesting = false;
      renderStrip();
    }
  };

  const celebrate = (html: string) => {
    const toast = document.createElement("div");
    toast.className = "toast-wrap";
    toast.innerHTML = html;
    toast.onclick = () => toast.remove();
    document.body.append(toast);
    setTimeout(() => toast.remove(), 6000);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const burst = document.createElement("div");
    burst.className = "burst";
    burst.setAttribute("aria-hidden", "true");
    burst.style.setProperty("--hue", String(courseHue(detail.course.slug)));
    burst.innerHTML = Array.from({ length: 36 }, (_, i) => {
      const angle = (i / 36) * 360 + Math.random() * 10;
      const distance = 80 + Math.random() * 140;
      return `<i style="--angle:${angle}deg;--distance:${distance}px;--size:${2 + Math.random() * 3}px"></i>`;
    }).join("");
    document.body.append(burst);
    setTimeout(() => burst.remove(), 1400);
  };

  // A followed run on main finished while this page watched: refresh progress, then notify and celebrate.
  const onFinished = async (run: RunSummary) => {
    const before = detail.currentIndex;
    const wasLocked = detail.stages.map((s) => s.locked).join();
    detail = await getJson<RepoDetail>(`/api/repos/${repo}`);
    renderList();
    renderStrip();
    // Only when a lock changed: re-rendering the instructions would reset the reader's scroll and selection.
    if (detail.stages.map((s) => s.locked).join() !== wasLocked) renderBody();
    if (!seenRunning.has(run.id)) return;
    const advance = run.branch === "main" ? advanceOf(before, detail.currentIndex, detail.stages) : null;
    if (advance) celebrate(toastHtml(repo, advance));
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      const full = await getJson<RunDetail>(`/api/repos/${repo}/runs/${run.id}`);
      const { title, body } = notificationText(repo, full, names(), advance);
      const note = new Notification(title, { body, tag: `anvil-${repo}` });
      note.onclick = () => window.focus();
    }
  };

  stripMain.onclick = toggleFlyout;
  rerunButton.onclick = () => void startRun();
  testButton.onclick = () => void startRun(stage.index);
  notifyButton.onclick = async () => {
    await Notification.requestPermission();
    renderStrip();
  };

  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    const editable = !!target && (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable);
    const action = keyAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, editable });
    if (!action) return;
    const go = (s: StageInfo | undefined) => {
      if (s && !s.locked) location.href = `/r/${encodeURIComponent(repo)}/${s.index}`;
    };
    switch (action) {
      case "next":
        return go(detail.stages.find((s) => s.index === stage.index + 1));
      case "prev":
        return go(detail.stages.find((s) => s.index === stage.index - 1));
      case "flyout":
        return void toggleFlyout();
      case "rerun":
        return void startRun();
      case "test":
        return testButton.hidden ? undefined : void startRun(stage.index);
      case "help":
        shortcuts.hidden = !shortcuts.hidden;
        shortcuts.innerHTML = shortcuts.hidden ? "" : shortcutsHtml();
        return;
      case "escape":
        if (!shortcuts.hidden) shortcuts.hidden = true;
        else if (!flyout.hidden) closeFlyout();
        return;
    }
  });

  renderList();
  renderBody();
  renderStrip();

  const source = new EventSource(`/api/repos/${repo}/events`);
  // After a reconnect (sleep, network drop) the server replays the run and its buffered lines: start over.
  source.onopen = () => {
    lines = [];
    requesting = false;
  };
  source.addEventListener("run", async (e) => {
    const incoming = JSON.parse((e as MessageEvent).data) as RunSummary;
    const followed = followRun(latest, incoming);
    if (followed !== incoming) return; // an older run: the page follows the newest one
    if (latest?.id !== incoming.id) {
      lines = [];
      requesting = false; // the requested run (or a push) has shown up
    }
    const wasRunning = running();
    latest = incoming;
    if (running()) seenRunning.add(latest.id);
    renderStrip();
    if (!flyout.hidden && (running() || wasRunning)) await renderFlyout();
    if (!running()) await onFinished(latest);
  });
  source.addEventListener("log", (e) => {
    const { runId, line } = JSON.parse((e as MessageEvent).data) as { runId: number; line: string };
    if (runId !== latest?.id) return;
    lines.push(line);
    if (lines.length > 5000) lines.shift();
    stripMain.querySelector(".live-line")!.textContent = liveLineText(line);
    const log = flyout.hidden ? null : flyout.querySelector<HTMLElement>("pre.live");
    if (!log) return;
    const atBottom = flyout.scrollTop + flyout.clientHeight >= flyout.scrollHeight - 40; // follow unless scrolled up
    log.insertAdjacentHTML("beforeend", `${log.childNodes.length ? "\n" : ""}${ansiToHtml(line)}`);
    if (atBottom) flyout.scrollTop = flyout.scrollHeight;
  });
}

// Diffs in run details (stage page flyout and history rows) load when first opened. `toggle` does not bubble: capture.
document.addEventListener(
  "toggle",
  async (e) => {
    const details = e.target as HTMLElement;
    if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("diff") || !details.open) return;
    if (details.dataset.loaded) return;
    details.dataset.loaded = "1";
    const body = details.querySelector(".diff-body")!;
    const repo = decodeURIComponent(location.pathname.split("/")[2] ?? "");
    const { run, stage, index } = details.dataset;
    body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const diff = await getJson<DiffView>(
        `/api/repos/${encodeURIComponent(repo)}/runs/${run}/diff?stage=${encodeURIComponent(stage ?? "")}`,
      );
      body.innerHTML = diffHtml(Number(index), diff);
    } catch (err) {
      delete details.dataset.loaded; // let the learner try again
      body.innerHTML = `<p class="error">${esc(err instanceof Error ? err.message : String(err))}</p>`;
    }
  },
  true,
);

async function historyPage(repo: string): Promise<void> {
  const detail = await getJson<RepoDetail>(`/api/repos/${encodeURIComponent(repo)}`);
  const stats = await getJson<StatsView>(`/api/repos/${encodeURIComponent(repo)}/stats`);
  const names = new Map(detail.stages.map((s) => [s.index, s.name] as const));
  document.title = pageTitle("History", detail.course.name);
  app.innerHTML = `${navHtml(null)}
    <main class="page history" style="--hue:${courseHue(detail.course.slug)}">
      <section class="hero compact">
        <p class="crumbs"><a href="/">My repos</a> / <a href="/courses/${esc(detail.course.slug)}">${esc(detail.course.name)}</a> / <a href="/r/${esc(
          repo,
        )}">${esc(repo)}</a> / History</p>
        <h1>${esc(repo)} <span class="gradient-text">history</span></h1>
      </section>
      ${statsHtml(stats, Date.now())}
      <h2 class="section-title">Runs</h2>
      <div id="runs" class="run-list"></div>
      <button type="button" id="more" class="ghost" hidden>Load more</button>
    </main>${footerHtml()}`;
  showToday();

  const list = document.getElementById("runs")!;
  const more = document.getElementById("more") as HTMLButtonElement;
  let before: number | undefined;
  const load = async () => {
    more.disabled = true;
    const page = await getJson<{ runs: RunListItemView[]; more: boolean }>(
      `/api/repos/${encodeURIComponent(repo)}/runs${before === undefined ? "" : `?before=${before}`}`,
    );
    const now = Date.now();
    list.insertAdjacentHTML("beforeend", page.runs.map((r) => runRowHtml(repo, r, now)).join(""));
    if (page.runs.length === 0 && before === undefined) list.innerHTML = '<p class="muted">No runs yet: push to start one.</p>';
    before = page.runs.at(-1)?.id;
    more.hidden = !page.more;
    more.disabled = false;
  };
  more.onclick = () => void load();
  // A row's details load when it is first opened.
  list.addEventListener(
    "toggle",
    async (e) => {
      const row = e.target as HTMLDetailsElement;
      if (!row.classList?.contains("run-row") || !row.open || row.dataset.loaded) return;
      row.dataset.loaded = "1";
      const target = row.querySelector(".run-detail")!;
      try {
        const run = await getJson<RunDetail>(`/api/repos/${encodeURIComponent(repo)}/runs/${row.dataset.run}`);
        target.innerHTML = flyoutHtml(run, names, { hints: detail.hints });
        showHints(target);
      } catch (err) {
        delete row.dataset.loaded;
        target.innerHTML = `<p class="error">${esc(err instanceof Error ? err.message : String(err))}</p>`;
      }
    },
    true,
  );
  await load();
}

async function main(): Promise<void> {
  const [, area, repo, stage] = location.pathname.split("/");
  try {
    if (area === "r" && repo && stage === "runs") await historyPage(decodeURIComponent(repo));
    else if (area === "r" && repo) await stagePage(decodeURIComponent(repo), stage ? Number(stage) : null);
    else if (area === "courses" && repo) await coursePage(decodeURIComponent(repo));
    else if (area === "courses") await coursesPage();
    else await homePage();
  } catch (e) {
    app.innerHTML = `${navHtml(null)}<main class="page"><div class="empty"><h2>Something went wrong</h2><p class="error">${esc(
      e instanceof Error ? e.message : String(e),
    )}</p><a class="button" href="/">Back to my repos</a></div></main>`;
  }
}
void main();
