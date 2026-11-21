import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function bareRepoDir(dataDir: string, repoName: string): string {
  return join(dataDir, "repos", `${repoName}.git`);
}

/** `base` is where the app is reached, e.g. from appUrl(). */
export function remoteUrl(base: string, repoName: string): string {
  return `${base}/git/${repoName}.git`;
}

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
}

/** Creates (or refreshes) the bare repo whose post-receive hook streams a run back to the pusher. */
export function ensureBareRepo(dataDir: string, repoName: string, appPort: number, hookToken: string): string {
  const dir = bareRepoDir(dataDir, repoName);
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    git(dirname(dir), "init", "--bare", "-q", "-b", "main", dir);
  }
  git(dir, "config", "http.receivepack", "true");
  git(dir, "config", "receive.advertisePushOptions", "true"); // git push -o stage=N
  const hook = join(dir, "hooks/post-receive");
  writeFileSync(
    hook,
    `#!/bin/sh
# Push options (git push -o stage=N) go to the app as numbered headers; git forbids newlines in them.
set --
i=0
while [ "$i" -lt "\${GIT_PUSH_OPTION_COUNT:-0}" ]; do
  eval "opt=\\\${GIT_PUSH_OPTION_$i}"
  opt=$(printf '%s' "$opt" | tr -d '\\r') # git allows a CR (from CRLF scripts); in a header it would drop the push
  set -- "$@" -H "x-anvil-push-option-$i: $opt"
  i=$((i + 1))
done
curl --no-buffer -sS -X POST -H "x-anvil-token: ${hookToken}" "$@" --data-binary @- "http://127.0.0.1:${appPort}/internal/post-receive/${repoName}" \\
  || echo "anvil: could not reach the app" >&2
exit 0
`,
  );
  chmodSync(hook, 0o700); // the hook holds the app token
  return dir;
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** Bridges a request under /git/ to `git http-backend` (CGI) and streams the response back. */
export async function serveGit(req: Request, reposRoot: string): Promise<Response> {
  const url = new URL(req.url);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_PROJECT_ROOT: reposRoot,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: req.method,
    PATH_INFO: url.pathname.replace(/^\/git/, ""),
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers.get("content-type") ?? "",
    REMOTE_USER: "local",
    REMOTE_ADDR: "127.0.0.1",
  };
  const length = req.headers.get("content-length");
  if (length) env.CONTENT_LENGTH = length;
  const encoding = req.headers.get("content-encoding");
  if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
  const protocol = req.headers.get("git-protocol");
  if (protocol) env.GIT_PROTOCOL = protocol;

  const proc = Bun.spawn(["git", "http-backend"], {
    env, stdin: req.body ?? "ignore", stdout: "pipe", stderr: "inherit",
  });
  const reader = proc.stdout.getReader();

  // Read until the CGI header block ends.
  let buf: Uint8Array = new Uint8Array(0);
  let headEnd = -1;
  let sepLength = 4;
  const decoder = new TextDecoder();
  while (headEnd < 0) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = concat(buf, value);
    const text = decoder.decode(buf);
    const crlf = text.indexOf("\r\n\r\n");
    const lf = text.indexOf("\n\n");
    if (crlf >= 0 && (lf < 0 || crlf < lf)) [headEnd, sepLength] = [crlf, 4];
    else if (lf >= 0) [headEnd, sepLength] = [lf, 2];
  }
  if (headEnd < 0) return new Response("bad gateway: no CGI response", { status: 502 });

  const headText = decoder.decode(buf).slice(0, headEnd);
  const headers = new Headers();
  let status = 200;
  for (const line of headText.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers.append(key, value);
  }
  const bodyStart = new TextEncoder().encode(decoder.decode(buf).slice(0, headEnd + sepLength)).length;
  const first = buf.slice(bodyStart);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.length) controller.enqueue(first);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      proc.kill();
    },
  });
  return new Response(body, { status, headers });
}

/** The commit `main` points to in the repo's remote, or null before the first push to main. */
export function mainHead(dataDir: string, repoName: string): string | null {
  const dir = bareRepoDir(dataDir, repoName);
  if (!existsSync(dir)) return null;
  const p = Bun.spawnSync(["git", "--git-dir", dir, "rev-parse", "--verify", "-q", "refs/heads/main"]);
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}

/** Whether the repo's remote has any commit (a course started from the web app is seeded with the starter). */
export function hasCommits(dataDir: string, repoName: string): boolean {
  const dir = bareRepoDir(dataDir, repoName);
  if (!existsSync(dir)) return false;
  return Bun.spawnSync(["git", "--git-dir", dir, "rev-parse", "--verify", "-q", "HEAD"]).exitCode === 0;
}
