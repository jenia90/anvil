import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog, CatalogCourse } from "../src/catalog";
import { loadConfig } from "../src/config";
import { RunRequestError } from "../src/pushes";
import { StartCourseError } from "../src/start-course";
import { makeFixtureRepo } from "./helpers";
import { RunEvents } from "../src/events";
import { SerialQueues } from "../src/queue";
import { startServer } from "../src/server";
import { Store } from "../src/store";

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

const sampleCourse: CatalogCourse = {
  slug: "http-server", name: "Build your own HTTP server", shortDescriptionMd: "Short.", descriptionMd: "Long.",
  difficulty: "easy", releaseStatus: "live", languages: [{ slug: "rust", name: "Rust" }],
  stages: [{ name: "Bind to a port", extension: null }],
};
const sampleCatalog: Catalog = { fetchedAt: 1, stale: false, courses: [sampleCourse] };

type BootOptions = {
  catalog?: () => Promise<Catalog>;
  startCourse?: (course: string, language: string) => Promise<{ name: string; cloneUrl: string }>;
  startRun?: (repo: string, stage: number | undefined) => { runId: number };
};

async function boot(configPath = join(import.meta.dir, "fixtures/config.yml"), opts: BootOptions = {}) {
  const config = await loadConfig(configPath);
  const store = new Store(":memory:");
  const events = new RunEvents();
  const started: string[] = [];
  const server = startServer({
    config, store, events, queues: new SerialQueues(), dataDir: config.dataDir, port: 0, hookToken: "test-token", viewUrl: () => "",
    catalog: { get: opts.catalog ?? (async () => sampleCatalog) },
    startCourse:
      opts.startCourse ??
      (async (course, language) => {
        started.push(`${course}-${language}`);
        return { name: `${course}-${language}`, cloneUrl: `http://x/git/${course}-${language}.git` };
      }),
    startRun: opts.startRun,
  });
  stops.push(server.stop);
  const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
  return { store, events, get, post, started, port: server.port };
}

function seed(store: Store) {
  const run = store.createRun("demo", "main", "abc1234def", ["at4", "ia4"]);
  store.finishRun(run.id, {
    status: "failed", buildLog: "BUILD", testerLog: "TESTER",
    results: [
      { slug: "at4", status: "passed", log: "ok", failureLine: null },
      { slug: "ia4", status: "failed", log: "bad", failureLine: "got 404" },
    ],
  });
  return run;
}

async function rawRequest(port: number, request: string): Promise<string> {
  let out = "";
  await new Promise<void>((resolve) => {
    void Bun.connect({
      hostname: "127.0.0.1", port,
      socket: {
        open(socket) { socket.write(request); },
        data(_socket, data) { out += new TextDecoder().decode(data); },
        close() { resolve(); },
        error() { resolve(); },
      },
    });
  });
  return out;
}

describe("host guard", () => {
  test("a request whose Host is not this server is refused (DNS rebinding)", async () => {
    const { port } = await boot();
    const res = await rawRequest(port, "GET /api/repos HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
    expect(res.startsWith("HTTP/1.1 403")).toBe(true);
  });

  test("localhost and 127.0.0.1 hosts are accepted", async () => {
    const { port } = await boot();
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const res = await rawRequest(port, `GET /api/repos HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      expect(res.startsWith("HTTP/1.1 200")).toBe(true);
    }
  });
});

describe("api", () => {
  test("repos list shows the current stage", async () => {
    const { store, get } = await boot();
    let repos = await (await get("/api/repos")).json();
    expect(repos).toEqual([
      { name: "demo", courseSlug: "http-server", courseName: "Build your own HTTP server", language: "rust",
        current: { index: 1, name: "Bind to a port" }, stageCount: 3, passedCount: 0 },
    ]);
    seed(store);
    repos = await (await get("/api/repos")).json();
    expect(repos[0].current).toEqual({ index: 2, name: "Respond with 200" });
    expect(repos[0].passedCount).toBe(1);
  });

  test("repo detail has stage states, setup command and the latest run without logs", async () => {
    const { store, get, port } = await boot();
    seed(store);
    const detail = await (await get("/api/repos/demo")).json();
    expect(detail.course).toEqual({ slug: "http-server", name: "Build your own HTTP server" });
    expect(detail.remoteUrl).toBe(`http://127.0.0.1:${port}/git/demo.git`);
    expect(detail.setupCommand).toBe(`git remote add local ${detail.remoteUrl}`);
    expect(detail.currentIndex).toBe(2);
    expect(detail.stages.map((s: any) => [s.index, s.state, s.lastResult])).toEqual([
      [1, "done", "passed"], [2, "current", "failed"], [3, "upcoming", null],
    ]);
    expect(detail.stages[0].descriptionMd).toContain("4221");
    expect(detail.latestRun.status).toBe("failed");
    expect(detail.latestRun.buildLog).toBeUndefined();
  });

  test("locked stages have no instructions", async () => {
    const { store, get } = await boot();
    seed(store);
    const { stages } = await (await get("/api/repos/demo")).json();
    expect(stages.map((s: any) => s.locked)).toEqual([false, false, true]);
    expect(stages[2].descriptionMd).toBe("");
    expect(stages[1].descriptionMd).not.toBe("");
  });

  test("stage text is rendered for the repo's language and extension stages carry their extension", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "api-")), "anvil.yml");
    const repo = (name: string, language: string) => `  - name: ${name}\n    course: redis\n    language: ${language}\n`;
    writeFileSync(
      path,
      `courses:\n  - definition: ${join(import.meta.dir, "fixtures/course-repo")}\n    tester: ./t\nrepos:\n${repo("r-rust", "rust")}${repo("r-go", "go")}`,
    );
    const { get } = await boot(path);
    const rust = await (await get("/api/repos/r-rust")).json();
    const go = await (await get("/api/repos/r-go")).json();
    expect(rust.stages[0].descriptionMd).toContain("TcpListener");
    expect(go.stages[0].descriptionMd).not.toContain("TcpListener");
    expect(go.stages[0].descriptionMd).toContain("Don't use Go's built-in helpers.");
    expect(rust.stages.map((s: any) => s.extension)).toEqual([null, null, "Lists"]);
  });

  test("run detail includes stage results with stageIndex and logs", async () => {
    const { store, get } = await boot();
    const run = seed(store);
    const detail = await (await get(`/api/repos/demo/runs/${run.id}`)).json();
    expect(detail.buildLog).toBe("BUILD");
    expect(detail.stageResults.map((r: any) => [r.stageIndex, r.status, r.failureLine])).toEqual([
      [1, "passed", null], [2, "failed", "got 404"],
    ]);
  });

  test("a run of another repo or a missing run is 404", async () => {
    const { store, get } = await boot();
    const other = store.createRun("elsewhere", "main", "a", []);
    expect((await get(`/api/repos/demo/runs/${other.id}`)).status).toBe(404);
    expect((await get("/api/repos/demo/runs/999")).status).toBe(404);
  });

  test("unknown repo is 404 with an error body", async () => {
    const { get } = await boot();
    const res = await get("/api/repos/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/unknown repo/i);
  });

  test("SSE sends the latest run on connect and then a published event", async () => {
    const { store, events, get } = await boot();
    const run = seed(store);
    const res = await get("/api/repos/demo/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);

    const first = await next();
    expect(first).toContain("event: run");
    expect(JSON.parse(first.split("data: ")[1]).id).toBe(run.id);

    store.setStatus(run.id, "building");
    events.publish({ repo: "demo", run: store.getRun(run.id)! });
    const second = await next();
    const payload = JSON.parse(second.split("data: ")[1]);
    expect(payload.status).toBe("building");
    expect(payload.buildLog).toBeUndefined();
    await reader.cancel();
  });
});

describe("courses api", () => {
  test("GET /api/courses returns the catalog", async () => {
    const { get } = await boot();
    expect(await (await get("/api/courses")).json()).toEqual(sampleCatalog);
  });

  test("GET /api/courses is 502 with the error when the catalog cannot load", async () => {
    const { get } = await boot(undefined, {
      catalog: async () => {
        throw new Error("network down");
      },
    });
    const res = await get("/api/courses");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("network down");
  });

  test("GET /api/courses/:slug includes the repos started for it; unknown slug is 404", async () => {
    const { get } = await boot();
    expect(await (await get("/api/courses/http-server")).json()).toEqual({ ...sampleCourse, repos: ["demo"] });
    expect((await get("/api/courses/nope")).status).toBe(404);
  });

  test("POST /api/repos starts the course: 201 with name and clone URL", async () => {
    const { post, started } = await boot();
    const res = await post("/api/repos", { course: "redis", language: "go" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: "redis-go", cloneUrl: "http://x/git/redis-go.git" });
    expect(started).toEqual(["redis-go"]);
  });

  test("POST /api/repos maps StartCourseError to its status", async () => {
    const { post } = await boot(undefined, {
      startCourse: async () => {
        throw new StartCourseError("redis-go is already started", 409);
      },
    });
    const res = await post("/api/repos", { course: "redis", language: "go" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "redis-go is already started" });
  });

  test("POST /api/repos is 500 with the error for anything else", async () => {
    const { post } = await boot(undefined, {
      startCourse: async () => {
        throw new Error("GitHub down");
      },
    });
    const res = await post("/api/repos", { course: "redis", language: "go" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("GitHub down");
  });

  test.each([[{ course: "redis" }], [{ language: "go" }], [{ course: 1, language: "go" }], ["not json"]])(
    "POST /api/repos with body %p is 400",
    async (body) => {
      const { post, started } = await boot();
      expect((await post("/api/repos", body)).status).toBe(400);
      expect(started).toEqual([]);
    },
  );

  test("a POST from another site is refused before it reaches the handler", async () => {
    const { post, started, port } = await boot();
    expect((await post("/api/repos", { course: "redis", language: "go" }, { origin: "http://evil.example" })).status).toBe(403);
    expect(started).toEqual([]);
    const ok = await post("/api/repos", { course: "redis", language: "go" }, { origin: `http://127.0.0.1:${port}` });
    expect(ok.status).toBe(201);
  });
});

describe("repo detail clone command", () => {
  test("is null for a repo whose remote has no commits", async () => {
    const { get } = await boot();
    expect((await (await get("/api/repos/demo")).json()).cloneCommand).toBeNull();
  });

  test("is git clone into codecrafters-<course>-<language> once the remote has commits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "api-"));
    const path = join(dir, "anvil.yml");
    writeFileSync(
      path,
      `dataDir: ./data\ncourses:\n  - definition: ${join(import.meta.dir, "fixtures/course.yml")}\n    tester: ./t\nrepos:\n  - name: demo\n    course: http-server\n    language: rust\n`,
    );
    const { bareDir } = await makeFixtureRepo();
    mkdirSync(join(dir, "data/repos"), { recursive: true });
    Bun.spawnSync(["git", "clone", "-q", "--bare", bareDir, join(dir, "data/repos/demo.git")]);
    const { get, port } = await boot(path);
    const detail = await (await get("/api/repos/demo")).json();
    expect(detail.cloneCommand).toBe(`git clone http://127.0.0.1:${port}/git/demo.git codecrafters-http-server-rust`);
  });

  test("POST /api/repos needs a JSON content type (415), so a plain cross-site form cannot reach it", async () => {
    const { started, port } = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/api/repos`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ course: "redis", language: "go" }),
    });
    expect(res.status).toBe(415);
    expect(started).toEqual([]);
  });

  test("with url set, its host is trusted, its origin may start courses, and links use it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "api-"));
    const path = join(dir, "anvil.yml");
    writeFileSync(
      path,
      `url: https://iceman.tail1.ts.net\ncourses:\n  - definition: ${join(import.meta.dir, "fixtures/course.yml")}\n    tester: ./t\nrepos:\n  - name: demo\n    course: http-server\n    language: rust\n`,
    );
    const { port, started } = await boot(path);
    const viaTailnet = await rawRequest(port, "GET /api/repos/demo HTTP/1.1\r\nHost: iceman.tail1.ts.net\r\nConnection: close\r\n\r\n");
    expect(viaTailnet.startsWith("HTTP/1.1 200")).toBe(true);
    expect(viaTailnet).toContain('"remoteUrl":"https://iceman.tail1.ts.net/git/demo.git"');

    const body = JSON.stringify({ course: "redis", language: "go" });
    const post = (origin: string) =>
      rawRequest(
        port,
        `POST /api/repos HTTP/1.1\r\nHost: iceman.tail1.ts.net\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
      );
    expect((await post("https://iceman.tail1.ts.net")).startsWith("HTTP/1.1 201")).toBe(true);
    expect((await post("http://iceman.tail1.ts.net")).startsWith("HTTP/1.1 403")).toBe(true);
    expect(started).toEqual(["redis-go"]);

    const other = await rawRequest(port, "GET /api/repos HTTP/1.1\r\nHost: other.tail1.ts.net\r\nConnection: close\r\n\r\n");
    expect(other.startsWith("HTTP/1.1 403")).toBe(true);
  });

  test("POST runs starts a run and returns 202 with its id", async () => {
    const calls: [string, number | undefined][] = [];
    const { post } = await boot(undefined, { startRun: (repo, stage) => (calls.push([repo, stage]), { runId: 42 }) });
    const res = await post("/api/repos/demo/runs", {});
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: 42 });
    expect(calls).toEqual([["demo", undefined]]);
  });

  test("POST runs passes the stage", async () => {
    const calls: (number | undefined)[] = [];
    const { post } = await boot(undefined, { startRun: (_r, stage) => (calls.push(stage), { runId: 1 }) });
    await post("/api/repos/demo/runs", { stage: 2 });
    expect(calls).toEqual([2]);
  });

  test("POST runs maps RunRequestError to its status", async () => {
    const { post } = await boot(undefined, {
      startRun: (_r, stage) => {
        throw stage === 3 ? new RunRequestError("stage 3 is locked; pass stage 2 first", 409) : new RunRequestError("no stage 9 in this course (1–3)", 400);
      },
    });
    const locked = await post("/api/repos/demo/runs", { stage: 3 });
    expect(locked.status).toBe(409);
    expect((await locked.json()).error).toBe("stage 3 is locked; pass stage 2 first");
    expect((await post("/api/repos/demo/runs", { stage: 9 })).status).toBe(400);
  });

  test("POST runs rejects a stage that is not a number and an unknown repo", async () => {
    const { post } = await boot(undefined, { startRun: () => ({ runId: 1 }) });
    expect((await post("/api/repos/demo/runs", { stage: "2" })).status).toBe(400);
    expect((await post("/api/repos/nope/runs", {})).status).toBe(404);
  });

  test("POST runs needs JSON", async () => {
    const { port } = await boot(undefined, { startRun: () => ({ runId: 1 }) });
    const res = await fetch(`http://127.0.0.1:${port}/api/repos/demo/runs`, { method: "POST", body: "{}" });
    expect(res.status).toBe(415);
  });

  test("repo detail says whether it can run", async () => {
    const { get } = await boot();
    expect((await (await get("/api/repos/demo")).json()).canRun).toBe(false);
  });

  test("SSE replays buffered lines of unfinished runs", async () => {
    const { store, events, get } = await boot();
    const run = store.createRun("demo", "main", "abc1234def", []);
    events.publishLine({ repo: "demo", runId: run.id, line: "first" });
    events.publishLine({ repo: "demo", runId: run.id, line: "second" });
    const res = await get("/api/repos/demo/events");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes('"second"')) text += decoder.decode((await reader.read()).value);
    const logs = text.split("\n\n").filter((c) => c.startsWith("event: log"));
    expect(logs.map((c) => JSON.parse(c.split("data: ")[1]))).toEqual([
      { runId: run.id, line: "first" }, { runId: run.id, line: "second" },
    ]);
    await reader.cancel();
  });

  test("SSE forwards new log lines", async () => {
    const { store, events, get } = await boot();
    const run = store.createRun("demo", "main", "abc1234def", []);
    const res = await get("/api/repos/demo/events");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain("event: run");
    events.publishLine({ repo: "demo", runId: run.id, line: "live" });
    const next = decoder.decode((await reader.read()).value);
    expect(next).toContain("event: log");
    expect(JSON.parse(next.split("data: ")[1])).toEqual({ runId: run.id, line: "live" });
    await reader.cancel();
  });
});
