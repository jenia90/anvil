import { marked } from "marked";
import type { RunSummary } from "../src/api";
import type { Catalog, CatalogCourse } from "../src/catalog";
import {
  type RepoListItem, type RunDetail, apiErrorMessage, courseHue, coursesHtml, esc, flyoutHtml, navHtml, progressHtml,
  footerHtml, lockedHtml, repoCardsHtml, setupHtml, sparksHtml, stripText,
} from "./render";

type StageInfo = {
  index: number; slug: string; name: string; difficulty: string; descriptionMd: string; extension: string | null;
  state: "done" | "current" | "upcoming"; lastResult: "passed" | "failed" | null; locked: boolean;
};
type RepoDetail = {
  name: string; course: { slug: string; name: string }; setupCommand: string; cloneCommand: string | null;
  currentIndex: number | null; stages: StageInfo[]; latestRun: RunSummary | null;
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
const mark = (slug: string, extra = "") =>
  `<span class="course-mark${extra}" aria-hidden="true">${esc(slug.charAt(0).toUpperCase())}</span>`;

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

async function homePage(): Promise<void> {
  const repos = await getJson<RepoListItem[]>("/api/repos");
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
      <section>
        <h2 class="section-title">My repos</h2>
        ${repoCardsHtml(repos)}
      </section>
    </main>${footerHtml()}`;
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
        <p class="crumbs"><a href="/">My repos</a> / <a href="/courses/${esc(detail.course.slug)}">${esc(detail.course.name)}</a> / ${esc(detail.name)}</p>
        <div id="setup"></div>
        <header class="stage-head"><p class="eyebrow">${meta}</p><h1>${esc(stage.name)}</h1></header>
        <div id="stage-body"></div>
      </main>
    </div>
    <button id="run-strip" type="button" aria-controls="flyout"></button>
    <aside id="flyout" hidden aria-label="Run details"></aside>`;

  const list = document.getElementById("stage-list")!;
  const strip = document.getElementById("run-strip")!;
  const flyout = document.getElementById("flyout")!;
  const setup = document.getElementById("setup")!;
  const body = document.getElementById("stage-body")!;
  let latest = detail.latestRun;

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
    strip.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="label">${esc(stripText(latest))}</span>${
      latest ? `<span class="hint">${flyout.hidden ? "Details ↑" : "Close ↓"}</span>` : ""
    }`;
    setup.innerHTML = latest ? "" : setupHtml(detail);
  };
  const closeFlyout = () => {
    flyout.hidden = true;
    renderStrip();
  };
  const renderFlyout = async () => {
    if (!latest) return;
    const run = await getJson<RunDetail>(`/api/repos/${repo}/runs/${latest.id}`);
    flyout.innerHTML = `<header><div><p class="eyebrow">Latest run</p><strong>${esc(
      stripText(latest),
    )}</strong></div><button type="button" class="ghost" id="close-flyout" aria-label="Close">✕</button></header>${flyoutHtml(run, names())}`;
    document.getElementById("close-flyout")!.onclick = closeFlyout;
    flyout.querySelector("mark")?.scrollIntoView({ block: "center" });
  };

  strip.onclick = async () => {
    if (!latest) return;
    flyout.hidden = !flyout.hidden;
    renderStrip();
    if (!flyout.hidden) await renderFlyout();
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !flyout.hidden) closeFlyout();
  });

  renderList();
  renderBody();
  renderStrip();

  const source = new EventSource(`/api/repos/${repo}/events`);
  source.addEventListener("run", async (e) => {
    latest = JSON.parse((e as MessageEvent).data) as RunSummary;
    renderStrip();
    if (["passed", "failed", "build_failed", "error"].includes(latest.status)) {
      const wasLocked = detail.stages.map((s) => s.locked).join();
      detail = await getJson<RepoDetail>(`/api/repos/${repo}`);
      renderList();
      // Only when a lock changed: re-rendering the instructions would reset the reader's scroll and selection.
      if (detail.stages.map((s) => s.locked).join() !== wasLocked) renderBody();
    }
    if (!flyout.hidden) await renderFlyout();
  });
}

async function main(): Promise<void> {
  const [, area, repo, stage] = location.pathname.split("/");
  try {
    if (area === "r" && repo) await stagePage(decodeURIComponent(repo), stage ? Number(stage) : null);
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
