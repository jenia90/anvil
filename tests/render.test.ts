import { describe, expect, test } from "bun:test";
import {
  type RunDetail, TEMPER_HUES, advanceOf, apiErrorMessage, faviconHref, followRun, keyAction, liveLineText, liveLogHtml,
  notificationText, shortcutsHtml, titlePrefix, toastHtml, footerHtml, sparksHtml, courseHue, coursesHtml, flyoutHtml, lockedHtml, navHtml, progressHtml, repoCardsHtml, setupHtml, stripText,
} from "../web/render";
import type { RunSummary } from "../src/api";
import type { RunStatus } from "../src/store";

const names = new Map([[1, "Bind to a port"], [2, "Respond with 200"], [3, "Extract URL path"]]);

function run(status: RunStatus, over: Partial<RunDetail> = {}): RunDetail {
  return {
    id: 1, repo: "demo", branch: "main", commitSha: "a1b2c3d4e5f6", status, stagesRequested: [],
    createdAt: 0, finishedAt: null, buildLog: "", testerLog: "", stageResults: [], ...over,
  };
}
const result = (stageIndex: number, status: "passed" | "failed", log: string, failureLine: string | null = null) =>
  ({ runId: 1, stageSlug: `s${stageIndex}`, stageIndex, status, log, failureLine });

describe("stripText", () => {
  test("shows the short hash, branch and state for each status", () => {
    const expected: Record<RunStatus, string> = {
      queued: "Queued", building: "Building…", testing: "Testing…", passed: "Passed",
      failed: "Failed", build_failed: "Build failed", error: "Error",
    };
    for (const [status, label] of Object.entries(expected)) {
      expect(stripText(run(status as RunStatus))).toBe(`a1b2c3d · main · ${label}`);
    }
  });

  test("says so when there are no pushes", () => {
    expect(stripText(null)).toBe("No pushes yet");
  });
});

describe("flyoutHtml", () => {
  const failed = run("failed", {
    stageResults: [
      result(1, "passed", "[stage-1] Test passed."),
      result(2, "failed", "\x1b[33m[stage-2] \x1b[0mSent GET /\n\x1b[33m[stage-2] \x1b[0m\x1b[91mExpected status code 200, got 404\x1b[0m\n[stage-2] Test failed", "Expected status code 200, got 404"),
    ],
  });

  test("lists each failed stage with its name and log, and not the passed ones", () => {
    const html = flyoutHtml(failed, names);
    expect(html).toContain("Stage 2");
    expect(html).toContain("Respond with 200");
    expect(html).toContain("Sent GET /");
    expect(html).not.toContain("Bind to a port");
  });

  test("wraps the failing line in <mark>", () => {
    const html = flyoutHtml(failed, names);
    expect(html).toMatch(/<mark>.*Expected status code 200, got 404.*<\/mark>/);
    expect(html.match(/<mark>/g)?.length).toBe(1);
  });

  test("escapes html from program output", () => {
    const evil = run("failed", { stageResults: [result(2, "failed", "[your_program] <script>alert(1)</script>", null)] });
    const html = flyoutHtml(evil, names);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("build_failed shows the build log", () => {
    const html = flyoutHtml(run("build_failed", { buildLog: "error[E0425]: cannot find value `x`" }), names);
    expect(html).toContain("Build failed");
    expect(html).toContain("cannot find value");
  });

  test("passed shows the success message and a link to the next stage", () => {
    const html = flyoutHtml(run("passed", { stageResults: [result(1, "passed", ""), result(2, "passed", "")] }), names);
    expect(html).toContain("All tests passed");
    expect(html).toContain('href="/r/demo/3"');
  });

  test("an error run shows both logs", () => {
    const html = flyoutHtml(run("error", { buildLog: "no compile script", testerLog: "spawn failed" }), names);
    expect(html).toContain("no compile script");
    expect(html).toContain("spawn failed");
  });

  test("an in-progress run says so", () => {
    expect(flyoutHtml(run("testing"), names)).toContain("in progress");
  });
});

describe("lockedHtml", () => {
  test("lockedHtml links to the current stage", () => {
    const html = lockedHtml("demo", { index: 2, name: "Respond <200>" });
    expect(html).toContain('href="/r/demo/2"');
    expect(html).toContain("Respond &lt;200&gt;");
    expect(html).toContain("Locked");
  });
});

describe("setupHtml", () => {
  test("a seeded repo shows clone, cd and push to origin", () => {
    const html = setupHtml({
      setupCommand: "git remote add local http://127.0.0.1:4300/git/redis-go.git",
      cloneCommand: "git clone http://127.0.0.1:4300/git/redis-go.git codecrafters-redis-go",
    });
    expect(html).toContain("git clone http://127.0.0.1:4300/git/redis-go.git codecrafters-redis-go\ncd codecrafters-redis-go\ngit push origin main");
    expect(html).not.toContain("remote add");
  });

  test("a repo with no commits shows remote add and push to local", () => {
    const html = setupHtml({ setupCommand: "git remote add local http://x/git/a.git", cloneCommand: null });
    expect(html).toContain("git remote add local http://x/git/a.git\ngit push local HEAD:main");
  });
});

describe("coursesHtml", () => {
  const course = (slug: string, releaseStatus: "live" | "beta" | "early_access") => ({
    slug, name: `Build your own <${slug}>`, shortDescriptionMd: "Learn **things**.", descriptionMd: "", difficulty: "medium",
    releaseStatus, languages: [], stages: [{ name: "a", extension: null }, { name: "b", extension: "X" }],
  });

  test("one card per course linking to its page, with difficulty, stage count and a badge unless live", () => {
    const html = coursesHtml({ fetchedAt: 0, stale: false, courses: [course("redis", "live"), course("claude-code", "beta")] });
    expect(html.match(/<a class="course-card"/g)?.length).toBe(2);
    expect(html).toContain('href="/courses/redis"');
    expect(html).toContain("Build your own &lt;redis&gt;");
    expect(html).toContain("<strong>things</strong>");
    expect(html).toContain("medium · 2 stages");
    expect(html).toContain('<span class="badge">Beta</span>');
    expect(html.match(/class="badge"/g)?.length).toBe(1);
    expect(html).not.toContain("offline");
  });

  test("a stale catalog says it is the saved copy", () => {
    const html = coursesHtml({ fetchedAt: Date.UTC(2026, 10, 19), stale: true, courses: [course("redis", "live")] });
    expect(html).toContain("could not reach GitHub");
  });
});

describe("apiErrorMessage", () => {
  test("uses the JSON error field", () => {
    expect(apiErrorMessage(502, '{"error":"could not load the course catalog: offline"}')).toBe("could not load the course catalog: offline");
  });

  test("falls back to the status and the start of a non-JSON body", () => {
    expect(apiErrorMessage(500, "Internal Server Error")).toBe("500: Internal Server Error");
    expect(apiErrorMessage(503, "")).toBe("503");
  });
});

describe("progressHtml", () => {
  test("is an accessible progress bar filled to the share done", () => {
    const html = progressHtml(6, 124);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="6"');
    expect(html).toContain('aria-valuemax="124"');
    expect(html).toContain("width:4.8%");
  });

  test("an empty course is 0%", () => {
    expect(progressHtml(0, 0)).toContain("width:0%");
  });
});

describe("courseHue", () => {
  test("is the same for a slug every time, and within 0-359", () => {
    expect(courseHue("redis")).toBe(courseHue("redis"));
    for (const slug of ["redis", "shell", "git", "sqlite", "http-server"]) {
      expect(courseHue(slug)).toBeGreaterThanOrEqual(0);
      expect(courseHue(slug)).toBeLessThan(360);
    }
    expect(courseHue("redis")).not.toBe(courseHue("shell"));
  });

  test("is always one of the temper colours of heated steel", () => {
    for (const slug of ["redis", "shell", "git", "sqlite", "http-server", "grep", "kafka", "interpreter", "dns-server"]) {
      expect(TEMPER_HUES).toContain(courseHue(slug));
    }
  });
});

describe("repoCardsHtml", () => {
  const repo = {
    name: "redis-rust", courseSlug: "redis", courseName: "Build your own <Redis>", language: "rust",
    current: { index: 7, name: "Expiry" }, stageCount: 124, passedCount: 6,
  };

  test("a card per repo: link, course, language, progress and the current stage", () => {
    const html = repoCardsHtml([repo]);
    expect(html).toContain('href="/r/redis-rust"');
    expect(html).toContain("Build your own &lt;Redis&gt;");
    expect(html).toContain("rust");
    expect(html).toContain("6 / 124");
    expect(html).toContain("Stage 7: Expiry");
    expect(html).toContain(`--hue:${courseHue("redis")}`);
  });

  test("a finished repo says so", () => {
    expect(repoCardsHtml([{ ...repo, current: null, passedCount: 124 }])).toContain("All stages pass");
  });

  test("no repos is an empty state pointing at the catalog", () => {
    const html = repoCardsHtml([]);
    expect(html).toContain('href="/courses"');
    expect(html).toContain("No repos yet");
  });
});

describe("navHtml", () => {
  test("links home and to the catalog and marks the active one", () => {
    const html = navHtml("courses");
    expect(html).toContain('href="/"');
    expect(html).toContain('<a href="/courses" class="active" aria-current="page">Courses</a>');
    expect(html).toContain('<svg class="logo"');
  });
});

describe("setupHtml copy button", () => {
  test("offers the commands to copy", () => {
    const html = setupHtml({ setupCommand: "x", cloneCommand: "git clone u codecrafters-a-b" });
    expect(html).toContain('data-copy="git clone u codecrafters-a-b\ncd codecrafters-a-b\ngit push origin main"');
  });
});

describe("sparksHtml", () => {
  const parse = (html: string) =>
    [...html.matchAll(/<i style="([^"]+)"><\/i>/g)].map((m) =>
      Object.fromEntries(m[1].split(";").filter(Boolean).map((d) => d.split(":") as [string, string])),
    );

  test("a hidden, decorative layer with one spark per count", () => {
    const html = sparksHtml(24);
    expect(html.startsWith('<div class="sparks" aria-hidden="true">')).toBe(true);
    expect(parse(html).length).toBe(24);
  });

  test("sparks spread across the whole width with varied timing", () => {
    const sparks = parse(sparksHtml(24));
    const xs = sparks.map((s) => Number.parseFloat(s["--x"]));
    expect(Math.min(...xs)).toBeLessThan(15);
    expect(Math.max(...xs)).toBeGreaterThan(85);
    for (const s of sparks) {
      expect(Number.parseFloat(s["--x"])).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(s["--x"])).toBeLessThanOrEqual(100);
      expect(s["--delay"]).toMatch(/^-?\d+(\.\d+)?s$/);
      expect(s["--dur"]).toMatch(/^\d+(\.\d+)?s$/);
    }
    expect(new Set(sparks.map((s) => s["--dur"])).size).toBeGreaterThan(5);
  });

  test("is the same every time (no layout shift between pages)", () => {
    expect(sparksHtml(24)).toBe(sparksHtml(24));
  });
});

describe("footerHtml", () => {
  test("says anvil is unofficial and where courses and testers come from", () => {
    const html = footerHtml();
    expect(html).toContain("not affiliated with CodeCrafters");
    expect(html).toContain('href="https://github.com/codecrafters-io"');
    expect(html).toContain('href="https://codecrafters.io"');
  });
});

const summary = (id: number, status: RunStatus): RunSummary => {
  const { buildLog: _b, testerLog: _t, stageResults: _s, ...rest } = run(status, { id });
  return rest;
};
const stagesList = [{ index: 1, name: "Bind to a port" }, { index: 2, name: "Respond with 200" }, { index: 3, name: "Extract URL path" }];

describe("followRun", () => {
  test("followRun keeps the newest id", () => {
    expect(followRun(null, summary(3, "queued"))!.id).toBe(3);
    expect(followRun(summary(3, "queued"), summary(2, "testing"))!.id).toBe(3);
    expect(followRun(summary(3, "queued"), summary(3, "testing"))!.status).toBe("testing");
    expect(followRun(summary(3, "passed"), summary(4, "queued"))!.id).toBe(4);
  });
});

describe("titlePrefix", () => {
  test("marks running, passed and failed runs", () => {
    expect(titlePrefix(null)).toBe("");
    for (const s of ["queued", "building", "testing"] as const) expect(titlePrefix(summary(1, s))).toBe("⏳ ");
    expect(titlePrefix(summary(1, "passed"))).toBe("✓ ");
    for (const s of ["failed", "build_failed", "error"] as const) expect(titlePrefix(summary(1, s))).toBe("✗ ");
  });
});

describe("faviconHref", () => {
  test("is null without a run and a data URL with the status colour otherwise", () => {
    expect(faviconHref(null)).toBeNull();
    const colour = (s: RunStatus) => decodeURIComponent(faviconHref(summary(1, s))!);
    expect(colour("testing")).toStartWith("data:image/svg+xml,");
    expect(colour("testing")).toContain("#f59e0b");
    expect(colour("passed")).toContain("#22c55e");
    expect(colour("build_failed")).toContain("#ef4444");
  });
});

describe("advanceOf", () => {
  test("is the last passed stage and the next one when current moved forward", () => {
    expect(advanceOf(2, 3, stagesList)).toEqual({ passed: 2, next: { index: 3, name: "Extract URL path" } });
    expect(advanceOf(1, 3, stagesList)).toEqual({ passed: 2, next: { index: 3, name: "Extract URL path" } });
  });

  test("completing the course has no next stage", () => {
    expect(advanceOf(3, null, stagesList)).toEqual({ passed: 3, next: null });
  });

  test("is null when current did not move forward or the course was already complete", () => {
    expect(advanceOf(2, 2, stagesList)).toBeNull();
    expect(advanceOf(3, 1, stagesList)).toBeNull();
    expect(advanceOf(null, null, stagesList)).toBeNull();
  });
});

describe("notificationText", () => {
  const failing = run("failed", {
    stageResults: [{ runId: 1, stageSlug: "ia4", stageIndex: 2, status: "failed", log: "", failureLine: "got 404" }],
  });
  test("titles carry the repo and the result", () => {
    expect(notificationText("demo", run("passed"), names, null).title).toBe("demo: Passed");
    expect(notificationText("demo", failing, names, null).title).toBe("demo: Failed");
    expect(notificationText("demo", run("build_failed"), names, null).title).toBe("demo: Build failed");
    expect(notificationText("demo", run("error"), names, null).title).toBe("demo: Error");
  });

  test("bodies say what happened", () => {
    const next = { passed: 1, next: { index: 2, name: "Respond with 200" } };
    expect(notificationText("demo", run("passed"), names, next).body).toBe("Stage 1 passed — on to stage 2: Respond with 200");
    expect(notificationText("demo", run("passed"), names, { passed: 3, next: null }).body).toBe("Course complete");
    expect(notificationText("demo", run("passed"), names, null).body).toBe("All tests passed");
    expect(notificationText("demo", failing, names, null).body).toBe("Stage 2 failed: got 404");
    expect(notificationText("demo", run("build_failed"), names, null).body).toBe("Build failed");
    expect(notificationText("demo", run("error"), names, null).body).toBe("The run ended with an error");
  });
});

describe("toastHtml", () => {
  test("links to the next stage, escaped", () => {
    const html = toastHtml("demo", { passed: 1, next: { index: 2, name: "Respond <200>" } });
    expect(html).toContain("Stage 1 passed");
    expect(html).toContain('href="/r/demo/2"');
    expect(html).toContain("On to stage 2: Respond &lt;200&gt; →");
  });

  test("celebrates a completed course", () => {
    expect(toastHtml("demo", { passed: 3, next: null })).toContain("Course complete 🎉");
  });
});

describe("live log", () => {
  test("liveLogHtml renders ANSI colour and escapes", () => {
    const html = liveLogHtml(["\x1b[31mred\x1b[0m", "<b>"]);
    expect(html).toStartWith('<pre class="log live">');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("\x1b");
  });

  test("liveLineText strips ANSI and trims", () => {
    expect(liveLineText("  \x1b[32m[stage-1] ok\x1b[0m  ")).toBe("[stage-1] ok");
  });
});

describe("keyAction", () => {
  const key = (k: string, over: Partial<Parameters<typeof keyAction>[0]> = {}) =>
    keyAction({ key: k, ctrlKey: false, metaKey: false, altKey: false, editable: false, ...over });

  test("maps the shortcut table", () => {
    expect(["j", "ArrowRight", "k", "ArrowLeft", "l", "r", "t", "?", "Escape"].map((k) => key(k))).toEqual([
      "next", "next", "prev", "prev", "flyout", "rerun", "test", "help", "escape",
    ]);
    expect(key("x")).toBeNull();
  });

  test("keyAction ignores editable targets and modifiers", () => {
    expect(key("j", { editable: true })).toBeNull();
    expect(key("r", { ctrlKey: true })).toBeNull();
    expect(key("r", { metaKey: true })).toBeNull();
    expect(key("t", { altKey: true })).toBeNull();
    expect(key("Escape", { editable: true })).toBe("escape");
  });
});

describe("shortcutsHtml", () => {
  test("lists every shortcut", () => {
    const html = shortcutsHtml();
    for (const k of ["j", "k", "l", "r", "t", "?", "Esc"]) expect(html).toContain(`<kbd>${k}</kbd>`);
  });
});
