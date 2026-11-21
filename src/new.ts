// Usage: bun run new <course> <language> [dir] [--config path/to/anvil.yml]
// Starts the course in the running anvil (as the web app's Start button does), then clones the repo.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { load } from "js-yaml";

export type CliStart = { configPath: string; course: string; language: string; dir?: string };

export async function startFromCli(opts: CliStart): Promise<{ name: string; dir: string }> {
  const configPath = resolve(opts.configPath);
  const port = ((load(readFileSync(configPath, "utf8")) ?? {}) as { port?: number }).port ?? 4300;
  const dir = resolve(opts.dir ?? join(dirname(dirname(configPath)), `codecrafters-${opts.course}-${opts.language}`));
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} already exists and is not empty`);

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ course: opts.course, language: opts.language }),
    });
  } catch {
    throw new Error(`anvil is not running on port ${port}: start it with bun run start, then try again`);
  }
  const body = (await res.json().catch(() => ({}))) as { name?: string; cloneUrl?: string; error?: string };
  if (res.status !== 201 || !body.name || !body.cloneUrl) throw new Error(body.error ?? `anvil answered ${res.status}`);

  const clone = Bun.spawnSync(["git", "clone", "-q", body.cloneUrl, dir], { stderr: "pipe" });
  if (clone.exitCode !== 0) {
    throw new Error(`${body.name} was started, but git clone failed: ${clone.stderr.toString().trim()}\nRun: git clone ${body.cloneUrl} ${dir}`);
  }
  return { name: body.name, dir };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--config");
  const configPath = at >= 0 ? args.splice(at, 2)[1] : "./anvil.yml";
  const [course, language, dir] = args;
  if (!course || !language || !configPath) {
    console.error("usage: bun run new <course> <language> [dir] [--config path/to/anvil.yml]");
    console.error("example: bun run new sqlite rust");
    process.exit(2);
  }
  try {
    const made = await startFromCli({ configPath, course, language, dir });
    console.log(`Started ${made.name} and cloned it to ${made.dir}.`);
    console.log(`Commit your changes, then push to run the tests:\n  cd ${made.dir}\n  git push origin main`);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
