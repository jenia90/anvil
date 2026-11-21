import index from "../web/index.html";
import { type ApiDeps, apiRoutes } from "./api";
import { serveGit } from "./git-remote";
import { type PushDeps, UnknownRepoError, handlePush, parseRefUpdates } from "./pushes";
import { join } from "node:path";

export type ServerDeps = PushDeps & {
  port: number;
  hookToken: string;
  catalog: ApiDeps["catalog"];
  startCourse: ApiDeps["startCourse"];
};

export function startServer(deps: ServerDeps): { port: number; hostname: string; stop(): void } {
  const reposRoot = join(deps.dataDir, "repos");

  const postReceive = async (req: Request & { params: { repo: string } }): Promise<Response> => {
    if (req.headers.get("x-anvil-token") !== deps.hookToken) return new Response("forbidden\n", { status: 403 });
    const repo = req.params.repo;
    if (!deps.config.repos.some((r) => r.name === repo)) return new Response("unknown repo\n", { status: 404 });
    const updates = parseRefUpdates(await req.text());
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            await handlePush(deps, repo, updates, (line) => controller.enqueue(encoder.encode(`${line}\n`)));
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
      ...api,
    },
    fetch: () => new Response("not found\n", { status: 404 }),
  });
  actualPort = server.port!;
  return { port: server.port!, hostname: server.hostname!, stop: () => void server.stop(true) };
}
