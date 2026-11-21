import type { Catalog } from "./catalog";
import { type Config, appUrl } from "./config";
import type { RunEvents } from "./events";
import { hasCommits, remoteUrl } from "./git-remote";
import { renderStageMd } from "./course";
import { currentStageIndex, stageViews } from "./progress";
import { StartCourseError } from "./start-course";
import type { RunRecord, Store } from "./store";

export type RunSummary = Omit<RunRecord, "buildLog" | "testerLog">;
export type ApiDeps = {
  config: Config;
  store: Store;
  events: RunEvents;
  port: () => number;
  catalog: { get(): Promise<Catalog> };
  startCourse: (course: string, language: string) => Promise<{ name: string; cloneUrl: string }>;
};

export const toSummary = ({ buildLog: _b, testerLog: _t, ...rest }: RunRecord): RunSummary => rest;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = (what: string) => json({ error: `unknown ${what}` }, 404);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function apiRoutes({ config, store, events, port, catalog, startCourse }: ApiDeps) {
  // A repo's remote never loses its commits, so once seen they need no further git call.
  const seeded = new Set<string>();
  const hasCommitsCached = (name: string) => {
    if (!seeded.has(name) && hasCommits(config.dataDir, name)) seeded.add(name);
    return seeded.has(name);
  };
  const lookup = (name: string) => {
    const repo = config.repos.find((r) => r.name === name);
    return repo ? { repo, ...config.courses.get(repo.course)! } : null;
  };

  return {
    "/api/courses": async () => {
      try {
        return json(await catalog.get());
      } catch (e) {
        return json({ error: `could not load the course catalog: ${errorText(e)}` }, 502);
      }
    },

    "/api/courses/:slug": async (req: Request & { params: { slug: string } }) => {
      let courses: Catalog["courses"];
      try {
        courses = (await catalog.get()).courses;
      } catch (e) {
        return json({ error: `could not load the course catalog: ${errorText(e)}` }, 502);
      }
      const course = courses.find((c) => c.slug === req.params.slug);
      if (!course) return notFound("course");
      return json({ ...course, repos: config.repos.filter((r) => r.course === course.slug).map((r) => r.name) });
    },

    "/api/repos": {
      GET: () =>
      json(
        config.repos.map((repo) => {
          const { course } = config.courses.get(repo.course)!;
          const latest = store.latestStageResults(repo.name);
          const index = currentStageIndex(course, latest);
          return {
            name: repo.name, courseSlug: course.slug, courseName: course.name, language: repo.language,
            current: index === null ? null : { index, name: course.stages[index - 1].name },
            stageCount: course.stages.length,
            passedCount: course.stages.filter((s) => latest.get(s.slug) === "passed").length,
          };
        }),
      ),

      POST: async (req: Request) => {
        // JSON only: a browser sends JSON cross-site only after a CORS preflight, which this server never approves.
        if (!req.headers.get("content-type")?.startsWith("application/json")) {
          return json({ error: "expected content-type application/json" }, 415);
        }
        const body = (await req.json().catch(() => null)) as { course?: unknown; language?: unknown } | null;
        if (typeof body?.course !== "string" || typeof body.language !== "string") {
          return json({ error: "expected JSON {course, language}" }, 400);
        }
        try {
          return json(await startCourse(body.course, body.language), 201);
        } catch (e) {
          return json({ error: errorText(e) }, e instanceof StartCourseError ? e.status : 500);
        }
      },
    },

    "/api/repos/:repo": (req: Request & { params: { repo: string } }) => {
      const found = lookup(req.params.repo);
      if (!found) return notFound("repo");
      const latest = store.latestStageResults(found.repo.name);
      const url = remoteUrl(appUrl(config, port()), found.repo.name);
      const run = store.latestRun(found.repo.name);
      return json({
        name: found.repo.name,
        course: { slug: found.course.slug, name: found.course.name },
        remoteUrl: url,
        setupCommand: `git remote add local ${url}`,
        cloneCommand: hasCommitsCached(found.repo.name)
          ? `git clone ${url} codecrafters-${found.repo.course}-${found.repo.language}`
          : null,
        currentIndex: currentStageIndex(found.course, latest),
        stages: stageViews(found.course, latest).map((v) => ({
          index: v.stage.index, slug: v.stage.slug, name: v.stage.name, difficulty: v.stage.difficulty,
          extension: v.stage.extension, descriptionMd: renderStageMd(v.stage.descriptionMd, found.repo.language),
          state: v.state, lastResult: v.lastResult,
        })),
        latestRun: run ? toSummary(run) : null,
      });
    },

    "/api/repos/:repo/runs/:id": (req: Request & { params: { repo: string; id: string } }) => {
      const found = lookup(req.params.repo);
      if (!found) return notFound("repo");
      const run = store.getRun(Number(req.params.id));
      if (!run || run.repo !== found.repo.name) return notFound("run");
      const indexBySlug = new Map(found.course.stages.map((s) => [s.slug, s.index]));
      return json({
        ...run,
        stageResults: run.stageResults.map((r) => ({ ...r, stageIndex: indexBySlug.get(r.stageSlug) ?? 0 })),
      });
    },

    "/api/repos/:repo/events": (req: Request & { params: { repo: string } }) => {
      const found = lookup(req.params.repo);
      if (!found) return notFound("repo");
      const encoder = new TextEncoder();
      let cleanup = () => {};
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (run: RunRecord) =>
            controller.enqueue(encoder.encode(`event: run\ndata: ${JSON.stringify(toSummary(run))}\n\n`));
          const latest = store.latestRun(found.repo.name);
          if (latest) send(latest);
          const off = events.subscribe(found.repo.name, (e) => send(e.run));
          const keepAlive = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 15000);
          cleanup = () => {
            off();
            clearInterval(keepAlive);
          };
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  };
}
