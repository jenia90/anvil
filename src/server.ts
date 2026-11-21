import index from "../web/index.html";
import { type ApiDeps, apiRoutes } from "./api";
import { mainHead, serveGit } from "./git-remote";
import { TEST_UPLOAD_CAP } from "./limits";
import { type PushDeps, RunRequestError, UnknownRepoError, WORKING_TREE, handlePush, parseRefUpdates, startRun } from "./pushes";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ServerDeps = PushDeps & {
  port: number;
  hookToken: string;
  catalog: ApiDeps["catalog"];
  startCourse: ApiDeps["startCourse"];
  /** Replaces the re-run starter (tests); by default it runs the head of main. */
  startRun?: ApiDeps["startRun"];
};

export function startServer(deps: ServerDeps): { port: number; hostname: string; stop(): void } {
  const reposRoot = join(deps.dataDir, "repos");

  const postReceive = async (req: Request & { params: { repo: string } }): Promise<Response> => {
    if (req.headers.get("x-anvil-token") !== deps.hookToken) return new Response("forbidden\n", { status: 403 });
    const repo = req.params.repo;
    if (!deps.config.repos.some((r) => r.name === repo)) return new Response("unknown repo\n", { status: 404 });
    const updates = parseRefUpdates(await req.text());
    const options = [...req.headers.entries()]
      .map(([k, v]) => [/^x-anvil-push-option-(\d+)$/.exec(k)?.[1], v] as const)
      .filter((e): e is readonly [string, string] => e[0] !== undefined)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, v]) => v);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            await handlePush(deps, repo, updates, (line) => controller.enqueue(encoder.encode(`${line}\n`)), options);
          } catch (e) {
            const message = e instanceof UnknownRepoError ? e.message : `run failed: ${e}`;
            controller.enqueue(encoder.encode(`anvil: ${message}\n`));
          }
          controller.close();
        })();
      },
    });
    return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
  };

  /** `anvil test`: runs an uploaded tar of the learner's working tree and streams the output back, like a push. */
  const testWorkingTree = async (req: Request & { params: { repo: string } }): Promise<Response> => {
    const error = (status: number, message: string) => Response.json({ error: message }, { status });
    const repo = req.params.repo;
    if (!deps.config.repos.some((r) => r.name === repo)) return error(404, `unknown repo: ${repo}`);
    // A cross-site page cannot send this content type without a preflight, which this server never approves.
    if (!req.headers.get("content-type")?.startsWith("application/x-tar")) {
      return error(415, "expected content-type application/x-tar");
    }
    const tooBig = () => error(413, `the working tree is larger than ${TEST_UPLOAD_CAP / 1024 / 1024} MiB`);
    if (Number(req.headers.get("content-length") ?? 0) > TEST_UPLOAD_CAP) return tooBig();
    const stageParam = new URL(req.url).searchParams.get("stage");
    if (stageParam !== null && !/^\d+$/.test(stageParam)) return error(400, "stage must be a whole number");
    const stage = stageParam === null ? undefined : Number(stageParam);
    const commit = req.headers.get("x-anvil-commit") ?? "";
    const sha = /^[0-9a-f]{40,64}$/.test(commit) ? commit : "0".repeat(40);

    const body = await req.arrayBuffer();
    if (body.byteLength > TEST_UPLOAD_CAP) return tooBig();
    const dir = mkdtempSync(join(tmpdir(), "anvil-upload-"));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    const archive = join(dir, "tree.tar");
    await Bun.write(archive, body);

    const encoder = new TextEncoder();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
    let started: { runId: number; done: Promise<void> };
    try {
      started = startRun(deps, repo, { branch: WORKING_TREE, sha, stage, archive }, (line) => out.enqueue(encoder.encode(`${line}\n`)));
    } catch (e) {
      cleanup();
      if (e instanceof RunRequestError) return error(e.status, e.message);
      throw e;
    }
    void started.done.finally(() => {
      cleanup();
      try {
        out.close();
      } catch {} // the CLI hung up (Ctrl-C); the run has finished regardless
    });
    return new Response(stream, {
      headers: { "content-type": "text/plain; charset=utf-8", "x-anvil-run": String(started.runId) },
    });
  };

  let actualPort = deps.port;
  // Refuse requests addressed to any other host name: a web page that rebinds its domain to 127.0.0.1
  // must not be able to reach the git remote or the API. Also refuse a non-GET request carrying another site's
  // Origin: the Host check alone does not stop a page elsewhere from posting here through the user's browser.
  // The configured url (e.g. a Tailscale name in front of this server) is trusted as well.
  const extra = deps.config.url ? new URL(deps.config.url) : null;
  const ours = () => [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, ...(extra ? [extra.host] : [])];
  const origins = () => [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, ...(extra ? [extra.origin] : [])];
  const guard =
    <R extends Request>(handler: (req: R) => Response | Promise<Response>) =>
    (req: R) => {
      const origin = req.headers.get("origin");
      const crossSite = origin !== null && req.method !== "GET" && req.method !== "HEAD" && !origins().includes(origin);
      return ours().includes(req.headers.get("host") ?? "") && !crossSite
        ? handler(req)
        : new Response("forbidden\n", { status: 403 });
    };
  type Handler = (req: Request) => Response | Promise<Response>;
  const routes = apiRoutes({
    config: deps.config, store: deps.store, events: deps.events, port: () => actualPort,
    catalog: deps.catalog, startCourse: deps.startCourse,
    startRun:
      deps.startRun ??
      ((repo, stage) => {
        if (!deps.config.repos.some((r) => r.name === repo)) throw new UnknownRepoError(repo);
        const sha = mainHead(deps.dataDir, repo);
        if (!sha) throw new RunRequestError("push your code first", 409);
        const { runId, done } = startRun(deps, repo, { branch: "main", sha, stage }, () => {});
        done.catch(() => {}); // the run records its own failure
        return { runId };
      }),
  });
  const api = Object.fromEntries(
    Object.entries(routes).map(([path, handler]) => [
      path,
      typeof handler === "function"
        ? guard(handler as Handler)
        : Object.fromEntries(Object.entries(handler).map(([method, h]) => [method, guard(h as Handler)])),
    ]),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: deps.port,
    idleTimeout: 0,
    maxRequestBodySize: TEST_UPLOAD_CAP + 1024 * 1024, // room for anvil test uploads (Bun's default is 128 MiB)
    // Bundle the page once at startup. Bun's development bundler watches web/ and rebuilds on change, and a file
    // deleted and recreated under it (git switch, git merge) leaves a bundle that fails to load in the browser.
    development: false,
    routes: {
      "/": index,
      "/r/*": index,
      "/courses": index,
      "/courses/*": index,
      "/git/*": guard((req) => serveGit(req, reposRoot)),
      "/internal/post-receive/:repo": { POST: guard(postReceive) },
      "/api/repos/:repo/test": { POST: guard(testWorkingTree) },
      ...api,
    },
    fetch: () => new Response("not found\n", { status: 404 }),
  });
  actualPort = server.port!;
  return { port: server.port!, hostname: server.hostname!, stop: () => void server.stop(true) };
}
