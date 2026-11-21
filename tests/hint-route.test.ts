import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { RunEvents } from "../src/events";
import { SerialQueues } from "../src/queue";
import { startServer } from "../src/server";
import { Store } from "../src/store";

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

async function boot(command: string | null, hintTimeoutMs?: number) {
  const config = await loadConfig(join(import.meta.dir, "fixtures/config.yml"), undefined, () => null);
  config.hint = command === null ? null : { command, maxPromptBytes: 150 * 1024 };
  const store = new Store(":memory:");
  const server = startServer({
    config, store, events: new RunEvents(), queues: new SerialQueues(), dataDir: config.dataDir, port: 0, hookToken: "t",
    viewUrl: () => "", catalog: { get: async () => ({ fetchedAt: 0, stale: false, courses: [] }) },
    startCourse: async () => {
      throw new Error("unused");
    },
    hintTimeoutMs,
  });
  stops.push(server.stop);
  // A working-tree run (no commit to read) whose stage 2 failed.
  const run = store.createRun("demo", "working tree", "0".repeat(40), ["at4", "ia4"]);
  store.finishRun(run.id, {
    status: "failed", buildLog: "", testerLog: "",
    results: [
      { slug: "at4", status: "passed", log: "ok", failureLine: null },
      { slug: "ia4", status: "failed", log: "[stage-2] Expected status code 200, got 404", failureLine: "got 404" },
    ],
  });
  const base = `http://127.0.0.1:${server.port}/api/repos/demo`;
  const hint = (body: unknown, runId = run.id) =>
    fetch(`${base}/runs/${runId}/hint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { base, hint };
}

describe("POST hint", () => {
  test("streams the command's output", async () => {
    const { hint } = await boot("cat >/dev/null; echo 'Think about the status line.'");
    const res = await hint({ stage: "ia4", level: 1, previous: [] });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Think about the status line.");
  });

  test("the command gets the prompt on stdin", async () => {
    const { hint } = await boot("grep -c 'Expected status code 200, got 404'");
    expect((await (await hint({ stage: "ia4", level: 2, previous: ["earlier"] })).text()).trim()).toBe("1");
  });

  test("a failing command ends with its error", async () => {
    const { hint } = await boot("cat >/dev/null; echo oops >&2; exit 3");
    expect(await (await hint({ stage: "ia4", level: 1, previous: [] })).text()).toContain("\0hint command failed: oops");
  });

  test("a slow command times out", async () => {
    const { hint } = await boot("sleep 5", 300);
    expect(await (await hint({ stage: "ia4", level: 1, previous: [] })).text()).toContain("\0hint timed out");
  });

  test("one hint at a time", async () => {
    const { hint } = await boot("cat >/dev/null; sleep 0.5; echo done");
    const first = hint({ stage: "ia4", level: 1, previous: [] });
    await Bun.sleep(100);
    const second = await hint({ stage: "ia4", level: 1, previous: [] });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("a hint is already being written; try again when it is done");
    expect(await (await first).text()).toContain("done");
  });

  test("409 when hints are off", async () => {
    const { hint } = await boot(null);
    const res = await hint({ stage: "ia4", level: 1, previous: [] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("hints are not set up: add hint.command to anvil.yml");
  });

  test("400 for a bad level or a stage that did not fail, 404 for an unknown run", async () => {
    const { hint } = await boot("cat");
    expect((await hint({ stage: "ia4", level: 4, previous: [] })).status).toBe(400);
    expect((await hint({ stage: "at4", level: 1, previous: [] })).status).toBe(400);
    expect((await hint({ stage: "ia4", level: 1, previous: [] }, 999)).status).toBe(404);
  });

  test("repo detail says whether hints are on", async () => {
    expect((await (await fetch((await boot("cat")).base)).json()).hints).toBe(true);
    expect((await (await fetch((await boot(null)).base)).json()).hints).toBe(false);
  });
});
