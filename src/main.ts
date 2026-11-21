import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CourseCatalog } from "./catalog";
import { appUrl, loadConfig } from "./config";
import { RunEvents } from "./events";
import { ensureBareRepo, remoteUrl } from "./git-remote";
import { ensureCourse } from "./github-courses";
import { SerialQueues } from "./queue";
import { startServer } from "./server";
import { startCourse } from "./start-course";
import { Store } from "./store";

const args = process.argv.slice(2);
const update = args.includes("--update");
const configPath = args.find((a) => !a.startsWith("--")) ?? "./anvil.yml";
const config = await loadConfig(resolve(configPath), (slug, dataDir) => ensureCourse(slug, dataDir, { update }));
const fetchCourse = (slug: string, dataDir: string) => ensureCourse(slug, dataDir);
mkdirSync(config.dataDir, { recursive: true });

const store = new Store(join(config.dataDir, "anvil.sqlite"));
const interrupted = store.failInterruptedRuns();

const hookToken = crypto.randomUUID();
let port = config.port;
const queues = new SerialQueues();
const server = startServer({
  config, store, events: new RunEvents(), queues, dataDir: config.dataDir, port: config.port, hookToken,
  viewUrl: (repo, stageIndex) => `${appUrl(config, port)}/r/${repo}/${stageIndex}`,
  catalog: new CourseCatalog(config.dataDir, { forceRefresh: update }),
  startCourse: (course, language) => startCourse({ config, fetchCourse, queues, port: () => port, hookToken }, course, language),
});
port = server.port;

console.log(`anvil is running at http://127.0.0.1:${port}/${config.url ? ` and ${config.url}/` : ""}`);
console.log(`Start a course at ${appUrl(config, port)}/courses`);
if (interrupted > 0) console.log(`Marked ${interrupted} interrupted run(s) from the last session as error.`);
for (const [slug, { testerPath }] of config.courses) {
  if (!existsSync(testerPath)) console.warn(`warning: tester for course ${slug} not found at ${testerPath}`);
}
for (const repo of config.repos) {
  ensureBareRepo(config.dataDir, repo.name, port, hookToken);
  console.log(`\n${repo.name}: in your solution repo run\n  git remote add local ${remoteUrl(appUrl(config, port), repo.name)}\n  git push local HEAD:main`);
}
