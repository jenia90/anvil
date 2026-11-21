import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import Mustache from "mustache";

export type Stage = {
  index: number;
  slug: string;
  name: string;
  difficulty: string;
  descriptionMd: string;
  /** Name of the extension this stage belongs to; null for base stages. */
  extension: string | null;
};
export type Course = { slug: string; name: string; shortName: string; descriptionMd: string; stages: Stage[] };

type Definition = {
  slug: string;
  name: string;
  short_name: string;
  description_md?: string;
  extensions?: { slug: string; name?: string }[];
  stages?: {
    slug: string;
    name?: string;
    difficulty?: string;
    description_md?: string;
    primary_extension_slug?: string;
  }[];
};

/** Multi-file definitions keep stage text in `stage_descriptions/<extension>-<NN>-<slug>.md`. */
const DESCRIPTION_FILE = /^.+?-\d+-(.+)\.md$/;

function readDescriptions(dir: string): Map<string, string> {
  const bySlug = new Map<string, string>();
  if (!existsSync(dir)) return bySlug;
  for (const file of readdirSync(dir)) {
    const m = DESCRIPTION_FILE.exec(file);
    if (m) bySlug.set(m[1], readFileSync(join(dir, file), "utf8"));
  }
  return bySlug;
}

/**
 * Loads a course from a single-file definition (stage text inline as `description_md`) or from a course repo
 * directory such as `build-your-own-redis` (`course-definition.yml` plus `stage_descriptions/`).
 */
export function loadCourse(definitionPath: string): Course {
  if (!existsSync(definitionPath)) throw new Error(`course definition not found: ${definitionPath}`);
  const isRepoDir = statSync(definitionPath).isDirectory();
  const file = isRepoDir ? join(definitionPath, "course-definition.yml") : definitionPath;
  if (!existsSync(file)) throw new Error(`course definition not found: ${file}`);
  const def = load(readFileSync(file, "utf8")) as Definition;
  if (!def?.slug || !def.name) throw new Error(`invalid course definition (slug/name): ${file}`);
  if (!Array.isArray(def.stages) || def.stages.length === 0) {
    throw new Error(`course definition has no stages: ${file}`);
  }
  const descriptions = isRepoDir ? readDescriptions(join(definitionPath, "stage_descriptions")) : new Map();
  const extensionNames = new Map((def.extensions ?? []).map((e) => [e.slug, e.name ?? e.slug]));
  return {
    slug: def.slug,
    name: def.name,
    shortName: def.short_name ?? def.name,
    descriptionMd: def.description_md ?? "",
    stages: def.stages.map((s, i) => ({
      index: i + 1,
      slug: s.slug,
      name: s.name ?? s.slug,
      difficulty: s.difficulty ?? "",
      descriptionMd: s.description_md ?? descriptions.get(s.slug) ?? "",
      extension: s.primary_extension_slug
        ? (extensionNames.get(s.primary_extension_slug) ?? s.primary_extension_slug)
        : null,
    })),
  };
}

const LANGUAGE_NAMES: Record<string, string> = {
  c: "C", cpp: "C++", csharp: "C#", fsharp: "F#", go: "Go", javascript: "JavaScript", typescript: "TypeScript",
  php: "PHP", ocaml: "OCaml",
};

export const languageName = (slug: string) => LANGUAGE_NAMES[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);

/**
 * Stage text is a mustache template: `{{#lang_is_rust}}...{{/lang_is_rust}}` shows only for that language,
 * `{{#reader_is_bot}}` only to AI tutors, `{{language_name}}` is the display name. Rendered as a human reader would see it.
 */
export function renderStageMd(md: string, language: string): string {
  const view = { [`lang_is_${language}`]: true, reader_is_bot: false, language_name: languageName(language) };
  return Mustache.render(md, view, {}, { escape: (s: string) => s });
}
