import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Downloads CodeCrafters courses from the codecrafters-io GitHub org into `<dataDir>/courses/<slug>/`:
 *   course/          course-definition.yml, stage_descriptions/ and compiled_starters/ (per-language starter code)
 *                    from build-your-own-<slug> at HEAD
 *   tester/          the latest release of <slug>-tester (binary `tester`, `test.sh`, bundled files)
 *   tester-version   the release tag in tester/
 * Same layout and release assets as CodeCrafters' own course-sdk uses.
 */

export type FetchedCourse = { definition: string; tester: string };
export type FetchOptions = {
  /** Re-download course content and fetch a newer tester release when one exists. */
  update?: boolean;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  /** OS/arch of the tester to download; defaults to this machine. */
  target?: string;
};

const ORG = "codecrafters-io";

/** GitHub has no build-your-own-<slug> repo: not a CodeCrafters course. */
export class CourseNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`no CodeCrafters course "${slug}" (github.com/${ORG}/build-your-own-${slug} does not exist)`);
  }
}
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function courseDir(dataDir: string, slug: string): string {
  return join(dataDir, "courses", slug);
}

function hostTarget(): string {
  const os = { linux: "linux", darwin: "darwin" }[process.platform as string];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch as string];
  if (!os || !arch) throw new Error(`no CodeCrafters tester builds for ${process.platform}/${process.arch}`);
  return `${os}_${arch}`;
}

async function download(fetchFn: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetchFn(url, { headers });
  if (!res.ok) {
    const err = new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res;
}

async function extract(tarball: Response, into: string, args: string[]): Promise<void> {
  const tar = Bun.spawn(["tar", "-xz", "-C", into, ...args], { stdin: "pipe", stderr: "pipe" });
  tar.stdin.write(new Uint8Array(await tarball.arrayBuffer()));
  await tar.stdin.end();
  if ((await tar.exited) !== 0) throw new Error(`could not extract download: ${await new Response(tar.stderr).text()}`);
}

/** Fills a fresh temp dir beside `target`, then swaps it in, so a failed download never leaves a half-written copy. */
async function replaceDir(target: string, fill: (tmp: string) => Promise<void>): Promise<void> {
  const parent = join(target, "..");
  mkdirSync(parent, { recursive: true });
  const tmp = mkdtempSync(join(parent, ".download-"));
  try {
    await fill(tmp);
    const old = `${tmp}.old`;
    const hadOld = existsSync(target);
    if (hadOld) renameSync(target, old);
    try {
      renameSync(tmp, target);
    } catch (e) {
      if (hadOld) renameSync(old, target);
      throw e;
    }
    rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Makes sure course `slug` is on disk and returns where. Downloads only what is missing unless `update` is set.
 * A failed update keeps the copy already on disk (with a warning); a failed first download throws.
 */
export async function ensureCourse(slug: string, dataDir: string, opts: FetchOptions = {}): Promise<FetchedCourse> {
  if (!SLUG.test(slug)) throw new Error(`invalid course slug: ${JSON.stringify(slug)}`);
  const log = opts.log ?? console.log;
  const fetchFn = opts.fetch ?? fetch;
  const dir = courseDir(dataDir, slug);
  const definition = join(dir, "course");
  const testerDir = join(dir, "tester");
  const versionFile = join(dir, "tester-version");
  const installed = existsSync(versionFile) && existsSync(testerDir) ? readFileSync(versionFile, "utf8").trim() : null;
  const courseRepo = `${ORG}/build-your-own-${slug}`;
  const testerRepo = `${ORG}/${slug}-tester`;

  /** missing: download or fail. outdated: download, keep the old copy on failure. current: download only on update. */
  const step = async (what: string, state: "missing" | "outdated" | "current", run: () => Promise<void>) => {
    if (state === "current" && !opts.update) return;
    try {
      await run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (state === "missing") {
        if (what === "course definition" && (e as { status?: number }).status === 404) throw new CourseNotFoundError(slug);
        throw new Error(`course ${slug}: could not download the ${what}: ${message}`);
      }
      log(`warning: course ${slug}: could not update the ${what}, keeping the copy on disk: ${message}`);
    }
  };

  // Copies downloaded before starters were kept lack compiled_starters/: they still run, but are downloaded again.
  const courseState = !existsSync(join(definition, "course-definition.yml"))
    ? "missing"
    : existsSync(join(definition, "compiled_starters"))
      ? "current"
      : "outdated";
  await step("course definition", courseState, async () => {
    log(`course ${slug}: downloading ${courseRepo}`);
    const tarball = await download(fetchFn, `https://codeload.github.com/${courseRepo}/tar.gz/HEAD`);
    await replaceDir(definition, async (tmp) => {
      // Keep only what anvil reads; the repo also carries solutions and starter templates for every language.
      const src = join(tmp, ".src");
      mkdirSync(src);
      await extract(tarball, src, ["--strip-components=1"]);
      for (const keep of ["course-definition.yml", "stage_descriptions", "compiled_starters"]) {
        if (existsSync(join(src, keep))) renameSync(join(src, keep), join(tmp, keep));
      }
      rmSync(src, { recursive: true, force: true });
      if (!existsSync(join(tmp, "course-definition.yml"))) throw new Error(`${courseRepo} has no course-definition.yml`);
    });
  });

  await step("tester", installed === null ? "missing" : "current", async () => {
    const token = process.env.GITHUB_TOKEN;
    const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const release = await download(fetchFn, `https://api.github.com/repos/${testerRepo}/releases/latest`, auth);
    const tag = String(((await release.json()) as { tag_name?: string }).tag_name ?? "");
    if (!/^[\w.-]+$/.test(tag)) throw new Error(`unexpected release tag ${JSON.stringify(tag)} for ${testerRepo}`);
    if (tag === installed) return;
    log(`course ${slug}: downloading ${testerRepo} ${tag}`);
    const asset = `${tag}_${opts.target ?? hostTarget()}.tar.gz`;
    const tarball = await download(fetchFn, `https://github.com/${testerRepo}/releases/download/${tag}/${asset}`);
    await replaceDir(testerDir, (tmp) => extract(tarball, tmp, []));
    writeFileSync(versionFile, `${tag}\n`);
  });

  return { definition, tester: join(testerDir, "tester") };
}
