import { stripAnsi } from "./ansi";

export type TestCase = { slug: string; prefix: string; title: string };
export type CaseResult = {
  slug: string;
  status: "passed" | "failed" | "not_run";
  log: string;
  failureLine: string | null;
};

const LINE = /^\[([^\]]+)\] (.*)$/;
const PROGRAM = "your_program";
const NOISE = /^(Terminating program|Program terminated successfully)/;

export function parseTesterLog(raw: string, cases: TestCase[]): CaseResult[] {
  const results = new Map<string, CaseResult & { lastMessage: string | null }>();
  for (const c of cases) {
    results.set(c.prefix, { slug: c.slug, status: "not_run", log: "", failureLine: null, lastMessage: null });
  }

  let current: (CaseResult & { lastMessage: string | null }) | null = null;
  for (const line of raw.split("\n")) {
    const m = LINE.exec(stripAnsi(line));
    if (!m) continue;
    const [, prefix, message] = m;
    if (prefix === PROGRAM) {
      if (current) current.log += `${line}\n`;
      continue;
    }
    const result = results.get(prefix);
    if (!result) continue;
    current = result;
    result.log += `${line}\n`;
    if (result.status === "not_run") result.status = "failed"; // started; verdict may follow
    if (message === "Test passed.") result.status = "passed";
    else if (message.startsWith("Test failed")) {
      result.status = "failed";
      result.failureLine = result.lastMessage;
    } else if (!NOISE.test(message)) result.lastMessage = message;
  }

  return cases.map((c) => {
    const { lastMessage: _ignored, ...result } = results.get(c.prefix)!;
    return result;
  });
}
