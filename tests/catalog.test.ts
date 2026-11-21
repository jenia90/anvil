import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CourseCatalog } from "../src/catalog";

const HOUR = 60 * 60 * 1000;

function definition(slug: string, status: string, extra = ""): string {
  return `slug: "${slug}"
name: "Build your own ${slug}"
short_name: "${slug}"
release_status: "${status}"
description_md: |-
  Long ${slug} description.
short_description_md: |-
  Short ${slug}.
marketing:
  difficulty: medium
languages:
  - slug: "rust"
  - slug: "cpp"
  - slug: "swift"
    release_status: "alpha"
extensions:
  - slug: "lists"
    name: "Lists"
stages:
  - slug: "aa1"
    name: "First"
  - slug: "bb2"
    name: "Second"
    primary_extension_slug: "lists"
${extra}`;
}

type Fake = { requests: string[]; fetch: typeof fetch; fail: boolean; rawStatus: number | null };

/** GitHub with `repos` in the org; `defs` maps course slug to its course-definition.yml. */
function fakeGitHub(repos: string[], defs: Record<string, string>): Fake {
  const fake: Fake = { requests: [], fail: false, rawStatus: null, fetch: undefined as unknown as typeof fetch };
  fake.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fake.requests.push(url);
    if (fake.fail) throw new Error("network down");
    const page = /^https:\/\/api\.github\.com\/orgs\/codecrafters-io\/repos\?per_page=100&page=(\d+)$/.exec(url);
    if (page) {
      const n = Number(page[1]);
      return Response.json(repos.slice((n - 1) * 100, n * 100).map((name) => ({ name, archived: false })));
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/codecrafters-io\/build-your-own-([a-z0-9-]+)\/HEAD\/course-definition\.yml$/.exec(url);
    if (raw && fake.rawStatus !== null) return new Response("rate limited", { status: fake.rawStatus });
    if (raw && defs[raw[1]] !== undefined) return new Response(defs[raw[1]]);
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  return fake;
}

const standard = () =>
  fakeGitHub(
    ["build-your-own-redis", "build-your-own-shell", "build-your-own-claude-code", "build-your-own-tokenizer",
      "build-your-own-dummy", "build-your-own-docker", "build-your-own-x", "redis-tester", "course-sdk"],
    {
      redis: definition("redis", "live"),
      shell: definition("shell", "live"),
      "claude-code": definition("claude-code", "beta"),
      tokenizer: definition("tokenizer", "early_access"),
      dummy: definition("dummy", "alpha"),
      docker: definition("docker", "deprecated"),
    },
  );

const dataDir = () => mkdtempSync(join(tmpdir(), "catalog-"));

describe("CourseCatalog", () => {
  test("lists live, beta and early_access courses with languages, stages and difficulty", async () => {
    const catalog = await new CourseCatalog(dataDir(), { fetch: standard().fetch }).get();
    expect(catalog.stale).toBe(false);
    expect(catalog.courses.map((c) => [c.slug, c.releaseStatus])).toEqual([
      ["redis", "live"],
      ["shell", "live"],
      ["claude-code", "beta"],
      ["tokenizer", "early_access"],
    ]);
    const redis = catalog.courses[0];
    expect(redis).toEqual({
      slug: "redis",
      name: "Build your own redis",
      shortDescriptionMd: "Short redis.",
      descriptionMd: "Long redis description.",
      difficulty: "medium",
      releaseStatus: "live",
      languages: [
        { slug: "rust", name: "Rust" },
        { slug: "cpp", name: "C++" },
      ],
      stages: [
        { name: "First", extension: null },
        { name: "Second", extension: "Lists" },
      ],
    });
  });

  test("follows org pagination", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => `other-repo-${i}`);
    const fake = fakeGitHub([...filler, "build-your-own-redis"], { redis: definition("redis", "live") });
    const catalog = await new CourseCatalog(dataDir(), { fetch: fake.fetch }).get();
    expect(catalog.courses.map((c) => c.slug)).toEqual(["redis"]);
    expect(fake.requests.filter((u) => u.includes("/orgs/")).length).toBe(2);
  });

  test("caches to catalog.json and reuses it for 24 hours", async () => {
    const dir = dataDir();
    let now = 1_000_000;
    const first = standard();
    await new CourseCatalog(dir, { fetch: first.fetch, now: () => now }).get();
    expect(existsSync(join(dir, "catalog.json"))).toBe(true);

    const second = standard();
    now += 23 * HOUR;
    const cached = await new CourseCatalog(dir, { fetch: second.fetch, now: () => now }).get();
    expect(second.requests).toEqual([]);
    expect(cached.courses.length).toBe(4);

    now += 2 * HOUR;
    await new CourseCatalog(dir, { fetch: second.fetch, now: () => now }).get();
    expect(second.requests.length).toBeGreaterThan(0);
  });

  test("forceRefresh ignores a fresh cache", async () => {
    const dir = dataDir();
    await new CourseCatalog(dir, { fetch: standard().fetch }).get();
    const again = standard();
    await new CourseCatalog(dir, { fetch: again.fetch, forceRefresh: true }).get();
    expect(again.requests.length).toBeGreaterThan(0);
  });

  test("a failed refresh serves the cache marked stale", async () => {
    const dir = dataDir();
    await new CourseCatalog(dir, { fetch: standard().fetch }).get();
    const down = standard();
    down.fail = true;
    const catalog = await new CourseCatalog(dir, { fetch: down.fetch, forceRefresh: true }).get();
    expect(catalog.stale).toBe(true);
    expect(catalog.courses.length).toBe(4);
  });

  test("a failed first load rejects", async () => {
    const down = standard();
    down.fail = true;
    await expect(new CourseCatalog(dataDir(), { fetch: down.fetch }).get()).rejects.toThrow(/network down/);
  });

  test("concurrent get() calls share one load", async () => {
    const fake = standard();
    const catalog = new CourseCatalog(dataDir(), { fetch: fake.fetch });
    const [a, b] = await Promise.all([catalog.get(), catalog.get()]);
    expect(a).toBe(b);
    expect(fake.requests.filter((u) => u.includes("/orgs/")).length).toBe(1);
  });

  test("a course whose definition fails to load or parse is skipped, others still listed", async () => {
    const fake = fakeGitHub(["build-your-own-redis", "build-your-own-broken", "build-your-own-gone"], {
      redis: definition("redis", "live"),
      broken: "slug: [unclosed",
    });
    const catalog = await new CourseCatalog(dataDir(), { fetch: fake.fetch }).get();
    expect(catalog.courses.map((c) => c.slug)).toEqual(["redis"]);
  });

  test("when definition downloads fail, the refresh fails: the saved catalog is served stale and kept", async () => {
    const dir = dataDir();
    await new CourseCatalog(dir, { fetch: standard().fetch }).get();
    const saved = readFileSync(join(dir, "catalog.json"), "utf8");
    const limited = standard();
    limited.rawStatus = 429;
    const catalog = await new CourseCatalog(dir, { fetch: limited.fetch, forceRefresh: true }).get();
    expect(catalog.stale).toBe(true);
    expect(catalog.courses.length).toBe(4);
    expect(readFileSync(join(dir, "catalog.json"), "utf8")).toBe(saved);
  });

  test("when definition downloads fail and nothing is saved, loading rejects instead of listing no courses", async () => {
    const limited = standard();
    limited.rawStatus = 503;
    await expect(new CourseCatalog(dataDir(), { fetch: limited.fetch }).get()).rejects.toThrow(/503/);
  });

  test("a listing with no courses is an error, never saved", async () => {
    const dir = dataDir();
    const empty = fakeGitHub(["course-sdk"], {});
    await expect(new CourseCatalog(dir, { fetch: empty.fetch }).get()).rejects.toThrow(/no courses/);
    expect(existsSync(join(dir, "catalog.json"))).toBe(false);
  });

  test("a download that never answers times out", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const started = Date.now();
    await expect(new CourseCatalog(dataDir(), { fetch: hang, timeoutMs: 50 }).get()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("after a failed refresh, GitHub is tried again at most every 5 minutes", async () => {
    const dir = dataDir();
    let now = 1_000_000;
    const fake = standard();
    const catalog = new CourseCatalog(dir, { fetch: fake.fetch, now: () => now });
    await catalog.get();
    fake.fail = true;
    now += 25 * HOUR;
    expect((await catalog.get()).stale).toBe(true);
    const tries = fake.requests.length;
    now += 60 * 1000;
    expect((await catalog.get()).stale).toBe(true);
    expect(fake.requests.length).toBe(tries);
    now += 5 * 60 * 1000;
    fake.fail = false;
    expect((await catalog.get()).stale).toBe(false);
    expect(fake.requests.length).toBeGreaterThan(tries);
  });
});
