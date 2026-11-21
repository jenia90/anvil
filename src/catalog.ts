import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { languageName } from "./course";

/** What the course pages show about a CodeCrafters course, from its course-definition.yml. */
export type CatalogCourse = {
  slug: string;
  name: string;
  shortDescriptionMd: string;
  descriptionMd: string;
  difficulty: string;
  releaseStatus: ReleaseStatus;
  languages: { slug: string; name: string }[];
  stages: { name: string; extension: string | null }[];
};
export type Catalog = { fetchedAt: number; stale: boolean; courses: CatalogCourse[] };
export type CatalogOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  /** Ignore a fresh cache on the first load (`--update`). */
  forceRefresh?: boolean;
  /** Per request; default 10 s. */
  timeoutMs?: number;
};

type ReleaseStatus = "live" | "beta" | "early_access";
const SHOWN: ReleaseStatus[] = ["live", "beta", "early_access"];
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** After a failed refresh, the saved catalog is served this long before GitHub is tried again. */
const RETRY_AFTER_MS = 5 * 60 * 1000;
const ORG = "codecrafters-io";
const COURSE_REPO = /^build-your-own-([a-z0-9][a-z0-9-]*)$/;

type Definition = {
  slug?: string;
  name?: string;
  release_status?: string;
  description_md?: string;
  short_description_md?: string;
  marketing?: { difficulty?: string };
  languages?: { slug: string; release_status?: string }[];
  extensions?: { slug: string; name?: string }[];
  stages?: { slug: string; name?: string; primary_extension_slug?: string }[];
};

function toCourse(def: Definition): CatalogCourse | null {
  const status = def.release_status as ReleaseStatus;
  if (!def.slug || !def.name || !SHOWN.includes(status) || !Array.isArray(def.stages) || def.stages.length === 0) {
    return null;
  }
  const extensions = new Map((def.extensions ?? []).map((e) => [e.slug, e.name ?? e.slug]));
  return {
    slug: def.slug,
    name: def.name,
    shortDescriptionMd: def.short_description_md ?? "",
    descriptionMd: def.description_md ?? "",
    difficulty: def.marketing?.difficulty ?? "",
    releaseStatus: status,
    // Alpha languages are open only to invited testers on CodeCrafters.
    languages: (def.languages ?? [])
      .filter((l) => l.release_status !== "alpha")
      .map((l) => ({ slug: l.slug, name: languageName(l.slug) })),
    stages: def.stages.map((s) => ({
      name: s.name ?? s.slug,
      extension: s.primary_extension_slug ? (extensions.get(s.primary_extension_slug) ?? s.primary_extension_slug) : null,
    })),
  };
}

/**
 * The CodeCrafters course catalog: course repos in the codecrafters-io org and each one's course-definition.yml.
 * Cached in `<dataDir>/catalog.json` for 24 hours; when GitHub cannot be reached, the cache is served marked stale.
 */
export class CourseCatalog {
  private current: Catalog | null = null;
  private loading: Promise<Catalog> | null = null;
  private forceRefresh: boolean;
  private failedAt = Number.NEGATIVE_INFINITY;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly cacheFile: string;

  constructor(dataDir: string, opts: CatalogOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.forceRefresh = opts.forceRefresh ?? false;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.cacheFile = join(dataDir, "catalog.json");
  }

  get(): Promise<Catalog> {
    const fresh = (c: Catalog | null) => c && !c.stale && this.now() - c.fetchedAt < MAX_AGE_MS;
    if (fresh(this.current)) return Promise.resolve(this.current!);
    if (this.current?.stale && this.now() - this.failedAt < RETRY_AFTER_MS) return Promise.resolve(this.current);
    if (!this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async load(): Promise<Catalog> {
    const cached = this.current ?? this.readCache();
    const force = this.forceRefresh;
    this.forceRefresh = false;
    if (cached && !force && this.now() - cached.fetchedAt < MAX_AGE_MS) return (this.current = { ...cached, stale: false });
    try {
      const courses = await this.download();
      const catalog = { fetchedAt: this.now(), stale: false, courses };
      this.writeCache(catalog);
      return (this.current = catalog);
    } catch (e) {
      this.failedAt = this.now();
      if (!cached) throw e;
      return (this.current = { ...cached, stale: true });
    }
  }

  private async download(): Promise<CatalogCourse[]> {
    const token = process.env.GITHUB_TOKEN;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const slugs: string[] = [];
    for (let page = 1; ; page++) {
      const res = await this.fetchFn(`https://api.github.com/orgs/${ORG}/repos?per_page=100&page=${page}`, {
        headers, signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`listing ${ORG} repos failed: ${res.status} ${res.statusText}`);
      const repos = (await res.json()) as { name: string; archived?: boolean }[];
      for (const r of repos) {
        const slug = COURSE_REPO.exec(r.name)?.[1];
        if (slug && slug !== "x" && !r.archived) slugs.push(slug);
      }
      if (repos.length < 100) break;
    }
    const courses = await Promise.all(
      slugs.map(async (slug) => {
        // A download that fails (network, rate limit) fails the whole refresh, so a flaky GitHub never replaces
        // the catalog with a partial one; a repo without a definition, or one that does not parse, is skipped.
        const url = `https://raw.githubusercontent.com/${ORG}/build-your-own-${slug}/HEAD/course-definition.yml`;
        const res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
        try {
          return toCourse(load(await res.text()) as Definition);
        } catch {
          return null;
        }
      }),
    );
    const shown = courses.filter((c): c is CatalogCourse => c !== null);
    if (shown.length === 0) throw new Error(`no courses found in the ${ORG} GitHub org`);
    return shown.sort(
      (a, b) => SHOWN.indexOf(a.releaseStatus) - SHOWN.indexOf(b.releaseStatus) || a.name.localeCompare(b.name),
    );
  }

  private readCache(): Catalog | null {
    try {
      return existsSync(this.cacheFile) ? (JSON.parse(readFileSync(this.cacheFile, "utf8")) as Catalog) : null;
    } catch {
      return null;
    }
  }

  private writeCache(catalog: Catalog): void {
    const tmp = `${this.cacheFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(catalog));
    renameSync(tmp, this.cacheFile);
  }
}
