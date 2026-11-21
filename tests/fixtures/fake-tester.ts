#!/usr/bin/env bun
// Stand-in for a course tester: prints each case in the real log shape.
// FAKE_FAIL_AT=<n> fails the nth case; FAKE_CRASH=1 exits 2 silently; FAKE_HANG=1 never exits;
// FAKE_ENV_DUMP=<file> records the submission dir, whether compile.sh exists, TESTER_DIR and your_program.sh; FAKE_DELAY_MS sleeps per case.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (process.env.FAKE_CRASH === "1") process.exit(2);
if (process.env.FAKE_HANG === "1") await new Promise(() => {});

const cases: { slug: string; tester_log_prefix: string; title: string }[] = JSON.parse(
  process.env.CODECRAFTERS_TEST_CASES_JSON ?? "[]",
);
const failAt = Number(process.env.FAKE_FAIL_AT ?? 0);
const dir = process.env.CODECRAFTERS_SUBMISSION_DIR ?? "";
// FAKE_SHIM_DUMP=<file> records where grep, pwd and sudo resolve on PATH, and what `sudo id -u` prints.
if (process.env.FAKE_SHIM_DUMP) {
  const which = (cmd: string) => Bun.which(cmd) ?? "";
  const viaSudo = Bun.spawnSync(["sudo", "id", "-u"], { stdin: "ignore" });
  writeFileSync(
    process.env.FAKE_SHIM_DUMP,
    [which("grep"), which("pwd"), which("sudo"), viaSudo.exitCode, viaSudo.stdout.toString().trim()].join("\n"),
  );
}
if (process.env.FAKE_ENV_DUMP) {
  const program = JSON.stringify(readFileSync(`${dir}/your_program.sh`, "utf8"));
  writeFileSync(
    process.env.FAKE_ENV_DUMP,
    `${dir}\n${existsSync(`${dir}/.codecrafters/compile.sh`)}\n${process.env.TESTER_DIR}\n${program}\n`,
  );
}

const E = "\x1b";
const st = (p: string, msg: string, color = "94") => console.log(`${E}[33m[${p}] ${E}[0m${E}[${color}m${msg}${E}[0m`);
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);

for (const [i, c] of cases.entries()) {
  const p = c.tester_log_prefix;
  if (delay) await Bun.sleep(delay);
  st(p, `Running tests for ${c.title}`);
  st(p, "$ ./your_program.sh");
  console.log(`${E}[33m[your_program] ${E}[0m${E}[0mserver started${E}[0m`);
  if (i + 1 === failAt) {
    st(p, "Expected status code 200, got 404", "91");
    st(p, "Test failed", "91");
    process.exit(1);
  }
  st(p, "Test passed.", "92");
}
