import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";

const fixtures = join(import.meta.dir, "fixtures");
const children: { kill(): void }[] = [];
afterEach(() => {
  while (children.length) children.pop()!.kill();
});

function writeConfig(dir: string): string {
  copyFileSync(join(fixtures, "course.yml"), join(dir, "course.yml"));
  const path = join(dir, "anvil.yml");
  writeFileSync(
    path,
    `port: 0\ndataDir: ./data\ncourses:\n  - definition: ./course.yml\n    tester: ${join(fixtures, "fake-tester.ts")}\nrepos:\n  - name: demo\n    course: http-server\n    language: rust\n`,
  );
  return path;
}

async function start(configPath: string): Promise<{ port: number; stdout: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), configPath], { stdout: "pipe", stderr: "inherit" });
  children.push(proc);
  const decoder = new TextDecoder();
  let stdout = "";
  const deadline = Date.now() + 10000;
  for await (const chunk of proc.stdout) {
    stdout += decoder.decode(chunk);
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/git\/demo\.git/.exec(stdout);
    if (m) return { port: Number(m[1]), stdout };
    if (Date.now() > deadline) break;
  }
  throw new Error(`app did not start: ${stdout}`);
}

describe("main", () => {
  test("starts, lists the repo, prints the remote command, and marks interrupted runs as error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "main-"));
    const configPath = writeConfig(dir);
    mkdirSync(join(dir, "data"));
    const seeded = new Store(join(dir, "data", "anvil.sqlite"));
    const stuck = seeded.createRun("demo", "main", "abc1234", []);
    seeded.setStatus(stuck.id, "building");

    const { port, stdout } = await start(configPath);
    expect(stdout).toContain(`git remote add local http://127.0.0.1:${port}/git/demo.git`);
    const repos = await (await fetch(`http://127.0.0.1:${port}/api/repos`)).json();
    expect(repos.map((r: { name: string }) => r.name)).toEqual(["demo"]);
    const detail = await (await fetch(`http://127.0.0.1:${port}/api/repos/demo`)).json();
    expect(detail.latestRun.status).toBe("error");
  });

  test("serves the web page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "main-"));
    const { port } = await start(writeConfig(dir));
    for (const path of ["/", "/r/demo/1", "/courses", "/courses/redis"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  test("serves a prebuilt page bundle, not Bun's development bundler (it breaks when files change under it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "main-"));
    const { port } = await start(writeConfig(dir));
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const src = /<script[^>]+src="([^"]+)"/.exec(html)![1];
    const bundle = await (await fetch(new URL(src, `http://127.0.0.1:${port}/`))).text();
    expect(bundle.length).toBeGreaterThan(1000);
    expect(bundle).not.toContain("Failed to load bundled module");
  });

  test("the page has an SVG favicon and a PNG touch icon, both served", async () => {
    const dir = mkdtempSync(join(tmpdir(), "main-"));
    const { port } = await start(writeConfig(dir));
    const base = `http://127.0.0.1:${port}/`;
    const html = await (await fetch(base)).text();
    for (const [rel, type] of [["icon", "image/svg+xml"], ["apple-touch-icon", "image/png"]]) {
      const href = new RegExp(`<link[^>]+rel="${rel}"[^>]+href="([^"]+)"`).exec(html)?.[1];
      expect(href).toBeDefined();
      const res = await fetch(new URL(href!, base));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
    }
  });
});
