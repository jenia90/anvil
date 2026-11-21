import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FixtureOpts = {
  compileExit?: number;
  omitCompile?: boolean;
  compileScript?: string;
  commitDate?: string;
  /** Contents of .codecrafters/run.sh; omitted when unset. */
  runScript?: string;
};

export function git(cwd: string, ...args: string[]): string {
  return gitEnv(cwd, {}, ...args);
}

export function gitEnv(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd, env: { ...process.env, ...env },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** A bare repo with one commit holding .codecrafters/compile.sh and your_program.sh. */
export async function makeFixtureRepo(opts: FixtureOpts = {}): Promise<{ bareDir: string; sha: string; workDir: string }> {
  const root = mkdtempSync(join(tmpdir(), "fixture-"));
  const work = join(root, "work");
  mkdirSync(join(work, ".codecrafters"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  if (!opts.omitCompile) {
    const path = join(work, ".codecrafters/compile.sh");
    writeFileSync(path, opts.compileScript ?? `#!/bin/sh\necho "compiling fixture"\nexit ${opts.compileExit ?? 0}\n`);
    chmodSync(path, 0o755);
  }
  if (opts.runScript !== undefined) writeFileSync(join(work, ".codecrafters/run.sh"), opts.runScript);
  writeFileSync(join(work, "your_program.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(work, "your_program.sh"), 0o755);
  git(work, "add", "-A");
  const when: Record<string, string> = opts.commitDate ? { GIT_AUTHOR_DATE: opts.commitDate, GIT_COMMITTER_DATE: opts.commitDate } : {};
  gitEnv(work, when, "commit", "-q", "-m", "fixture");
  const sha = git(work, "rev-parse", "HEAD");
  const bareDir = join(root, "fixture.git");
  git(root, "clone", "-q", "--bare", work, bareDir);
  return { bareDir, sha, workDir: work };
}
