import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { type Config, type CourseFetcher, addRepoEntry, appUrl, loadConfig } from "./config";
import { loadCourse } from "./course";
import { bareRepoDir, ensureBareRepo, remoteUrl } from "./git-remote";
import { CourseNotFoundError } from "./github-courses";
import type { SerialQueues } from "./queue";

/** A start the user can fix: bad input or a missing starter (400), no such course (404), or a repo that exists (409). */
export class StartCourseError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

export type StartDeps = {
  config: Config;
  fetchCourse: CourseFetcher;
  queues: SerialQueues;
  port: () => number;
  hookToken: string;
};

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString().trim()}`);
}

/**
 * Starts `course` in `language` as CodeCrafters does: anvil's remote for `<course>-<language>` gets one commit
 * holding the course's starter code, ready to clone. The repo is added to anvil.yml and to the running app.
 * Starts run one at a time; a failed start leaves no repo and an unchanged config.
 */
export function startCourse(deps: StartDeps, course: string, language: string): Promise<{ name: string; cloneUrl: string }> {
  return deps.queues.enqueue("start-course", () => start(deps, course, language)).result;
}

async function start(deps: StartDeps, course: string, language: string): Promise<{ name: string; cloneUrl: string }> {
  const { config, fetchCourse } = deps;
  if (!SLUG.test(course)) throw new StartCourseError(`invalid course: ${JSON.stringify(course)}`, 400);
  if (!SLUG.test(language)) throw new StartCourseError(`invalid language: ${JSON.stringify(language)}`, 400);
  const name = `${course}-${language}`;
  const bare = bareRepoDir(config.dataDir, name);
  if (config.repos.some((r) => r.name === name)) throw new StartCourseError(`${name} is already started`, 409);
  if (existsSync(bare)) throw new StartCourseError(`${bare} already exists`, 409);

  // The file may list the repo already: added by hand since anvil started.
  const original = readFileSync(config.path, "utf8");
  const listed = ((load(original) ?? {}) as { repos?: { name?: string }[] }).repos ?? [];
  if (Array.isArray(listed) && listed.some((r) => r?.name === name)) {
    throw new StartCourseError(`${name} is already in ${config.path}; restart anvil to pick it up`, 409);
  }

  const fetched = await fetchCourse(course, config.dataDir).catch((e) => {
    throw e instanceof CourseNotFoundError ? new StartCourseError(e.message, 404) : e;
  });
  const loaded = loadCourse(fetched.definition);
  if (loaded.slug !== course) {
    throw new StartCourseError(`course ${course} is published as ${loaded.slug}; start ${loaded.slug} instead`, 400);
  }
  const starters = join(fetched.definition, "compiled_starters");
  const starter = join(starters, language);
  if (!existsSync(starter)) {
    const available = existsSync(starters) ? readdirSync(starters).sort().join(", ") : "none";
    throw new StartCourseError(`course ${course} has no ${language} starter (available: ${available})`, 400);
  }

  const work = mkdtempSync(join(tmpdir(), "anvil-start-"));
  try {
    cpSync(starter, work, { recursive: true });
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(
      work, "-c", "user.name=anvil", "-c", "user.email=anvil@localhost", "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init",
    );
    // A fetch into the bare repo runs no receive hooks, and the hook is installed only afterwards:
    // seeding never starts a test run, the user's first push does.
    git(work, "init", "-q", "--bare", "-b", "main", bare);
    git(work, "--git-dir", bare, "fetch", "-q", work, "main:main");
    ensureBareRepo(config.dataDir, name, deps.port(), deps.hookToken);

    writeFileSync(config.path, addRepoEntry(original, { name, course, language }));
    const check = await loadConfig(config.path, fetchCourse);
    if (!check.repos.some((r) => r.name === name)) throw new Error(`could not add ${name} to ${config.path}`);
  } catch (e) {
    writeFileSync(config.path, original);
    rmSync(bare, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  if (!config.courses.has(course)) config.courses.set(course, { course: loaded, testerPath: fetched.tester });
  config.repos.push({ name, course, language });
  return { name, cloneUrl: remoteUrl(appUrl(config, deps.port()), name) };
}
