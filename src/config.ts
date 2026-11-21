import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { load } from "js-yaml";
import { type Course, loadCourse } from "./course";

export type RepoConfig = { name: string; course: string; language: string };
export type Config = {
  /** Absolute path of the config file. */
  path: string;
  port: number;
  /** Where anvil is reached besides 127.0.0.1 (e.g. a Tailscale address), as an origin; null when unset. */
  url: string | null;
  dataDir: string;
  courses: Map<string, { course: Course; testerPath: string }>;
  repos: RepoConfig[];
  /** The hint command (prompt on stdin, hint on stdout) and the prompt budget; null when hints are off. */
  hint: { command: string; maxPromptBytes: number } | null;
};

/** Provides a course that `courses:` does not list: where its definition and tester binary are on disk. */
export type CourseFetcher = (slug: string, dataDir: string) => Promise<{ definition: string; tester: string }>;

type RawConfig = {
  port?: number;
  url?: string;
  dataDir?: string;
  courses?: { definition: string; tester: string }[];
  repos?: RepoConfig[];
  hint?: false | { command?: unknown; maxPromptKB?: unknown };
};

const DEFAULT_PROMPT_KB = 150;

/** `hint:` → the command and budget; false turns hints off; unset uses `claude -p` when claude is installed. */
function parseHint(raw: RawConfig["hint"], which: (cmd: string) => string | null): Config["hint"] {
  if (raw === false) return null;
  if (raw === undefined || raw === null) {
    return which("claude") ? { command: "claude -p", maxPromptBytes: DEFAULT_PROMPT_KB * 1024 } : null;
  }
  if (typeof raw !== "object") throw new Error("invalid hint: expected false or { command, maxPromptKB }");
  if (typeof raw.command !== "string" || raw.command.trim() === "") {
    throw new Error("invalid hint.command: expected a command line such as claude -p");
  }
  const kb = raw.maxPromptKB ?? DEFAULT_PROMPT_KB;
  if (typeof kb !== "number" || !Number.isInteger(kb) || kb < 1) throw new Error("invalid hint.maxPromptKB: expected a whole number of KB");
  return { command: raw.command, maxPromptBytes: kb * 1024 };
}

const REPO_NAME = /^[a-z0-9][a-z0-9-]*$/;

function parseUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`invalid url: ${JSON.stringify(raw)} (expected e.g. https://my-machine.my-tailnet.ts.net)`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username) {
    throw new Error(`invalid url: ${JSON.stringify(raw)} (expected http(s)://host[:port] with nothing after it)`);
  }
  return url.origin;
}

/** The base of every link anvil shows (clone and remote commands, run links): `url` when set, else the local address. */
export function appUrl(config: Pick<Config, "url">, port: number): string {
  return config.url ?? `http://127.0.0.1:${port}`;
}

const noFetch: CourseFetcher = async (slug) => {
  throw new Error(`unknown course ${slug}`);
};

/**
 * Courses listed under `courses:` are used from local paths. Any other course a repo names is asked of `fetchCourse`
 * (in the app: downloaded from GitHub).
 */
export async function loadConfig(
  configPath: string,
  fetchCourse: CourseFetcher = noFetch,
  which: (cmd: string) => string | null = Bun.which,
): Promise<Config> {
  const dir = dirname(resolve(configPath));
  const raw = (load(readFileSync(configPath, "utf8")) ?? {}) as RawConfig;
  const dataDir = resolve(dir, raw.dataDir ?? "./data");

  const courses: Config["courses"] = new Map();
  for (const c of raw.courses ?? []) {
    const course = loadCourse(resolve(dir, c.definition));
    courses.set(course.slug, { course, testerPath: resolve(dir, c.tester) });
  }

  const repos: RepoConfig[] = [];
  for (const r of raw.repos ?? []) {
    if (!REPO_NAME.test(String(r.name))) throw new Error(`invalid repo name: ${JSON.stringify(r.name)}`);
    if (repos.some((x) => x.name === r.name)) throw new Error(`duplicate repo name: ${r.name}`);
    if (!r.language) throw new Error(`repo ${r.name}: missing language`);
    if (!courses.has(r.course)) {
      const fetched = await fetchCourse(String(r.course), dataDir).catch((e) => {
        throw new Error(`repo ${r.name}: ${e instanceof Error ? e.message : e}`);
      });
      const course = loadCourse(fetched.definition);
      if (course.slug !== r.course) throw new Error(`repo ${r.name}: course ${r.course} has slug ${course.slug}`);
      courses.set(course.slug, { course, testerPath: fetched.tester });
    }
    repos.push({ name: r.name, course: r.course, language: r.language });
  }

  return {
    path: resolve(configPath), port: raw.port ?? 4300, url: parseUrl(raw.url), dataDir, courses, repos,
    hint: parseHint(raw.hint, which),
  };
}

/**
 * Adds a repo entry to the config text, keeping its comments and layout: after the last item of `repos:`, with
 * the same indent as the first item, or as a new `repos:` section at the end.
 */
export function addRepoEntry(text: string, repo: RepoConfig): string {
  const lines = text.split("\n");
  const entry = (indent: string) => [
    `${indent}- name: ${repo.name}`,
    `${indent}  course: ${repo.course}`,
    `${indent}  language: ${repo.language}`,
  ];
  const start = lines.findIndex((l) => /^repos:\s*(#.*)?$/.test(l));
  if (start === -1) return `${text.replace(/\n*$/, "\n")}${["repos:", ...entry("  ")].join("\n")}\n`;

  let indent: string | null = null;
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[^\s#]/.test(line)) break; // the next top-level key ends the section
    if (!line.trim() || line.trim().startsWith("#")) continue;
    indent ??= /^(\s*)- /.exec(line)?.[1] ?? "  ";
    last = i;
  }
  lines.splice(last + 1, 0, ...entry(indent ?? "  "));
  return lines.join("\n");
}
