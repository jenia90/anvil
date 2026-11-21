import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFromCli } from "../src/new";
import { git, makeFixtureRepo } from "./helpers";

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

/** A stand-in for the running app; answers POST /api/repos with `reply` and records the request bodies. */
function fakeApp(reply: (body: { course: string; language: string }) => Response) {
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const body = await req.json();
      requests.push({ method: req.method, path: new URL(req.url).pathname, body });
      return reply(body);
    },
  });
  stops.push(() => server.stop(true));
  return { port: server.port!, requests };
}

/** <root>/anvil/anvil.yml with the given port. */
function setup(port: number) {
  const root = mkdtempSync(join(tmpdir(), "new-"));
  mkdirSync(join(root, "anvil"));
  const configPath = join(root, "anvil", "anvil.yml");
  writeFileSync(configPath, `port: ${port}\nrepos:\n`);
  return { root, configPath };
}

describe("startFromCli", () => {
  test("asks the running app to start the course, then clones it beside the anvil folder", async () => {
    const { bareDir } = await makeFixtureRepo();
    const app = fakeApp(() => Response.json({ name: "redis-rust", cloneUrl: bareDir }, { status: 201 }));
    const { root, configPath } = setup(app.port);
    const made = await startFromCli({ configPath, course: "redis", language: "rust" });
    const dir = join(root, "codecrafters-redis-rust");
    expect(made).toEqual({ name: "redis-rust", dir });
    expect(app.requests).toEqual([{ method: "POST", path: "/api/repos", body: { course: "redis", language: "rust" } }]);
    expect(existsSync(join(dir, "your_program.sh"))).toBe(true);
    expect(git(dir, "remote", "get-url", "origin")).toBe(bareDir);
  });

  test("clones into the given folder", async () => {
    const { bareDir } = await makeFixtureRepo();
    const app = fakeApp(() => Response.json({ name: "redis-rust", cloneUrl: bareDir }, { status: 201 }));
    const { root, configPath } = setup(app.port);
    const dir = join(root, "elsewhere");
    expect((await startFromCli({ configPath, course: "redis", language: "rust", dir })).dir).toBe(dir);
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  test("refuses a folder that has files before asking the app", async () => {
    const app = fakeApp(() => Response.json({}, { status: 201 }));
    const { root, configPath } = setup(app.port);
    const dir = join(root, "codecrafters-redis-rust");
    mkdirSync(dir);
    writeFileSync(join(dir, "keep.txt"), "mine");
    await expect(startFromCli({ configPath, course: "redis", language: "rust" })).rejects.toThrow(/not empty/);
    expect(app.requests).toEqual([]);
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("mine");
  });

  test("passes on the app's error", async () => {
    const app = fakeApp(() => Response.json({ error: "redis-rust is already started" }, { status: 409 }));
    const { configPath } = setup(app.port);
    await expect(startFromCli({ configPath, course: "redis", language: "rust" })).rejects.toThrow(
      "redis-rust is already started",
    );
  });

  test("says to start anvil when nothing is listening", async () => {
    const app = fakeApp(() => new Response());
    const port = app.port;
    stops.pop()!();
    const { configPath } = setup(port);
    await expect(startFromCli({ configPath, course: "redis", language: "rust" })).rejects.toThrow(
      /anvil is not running.*bun run start/,
    );
  });
});
