import { Database } from "bun:sqlite";
import type { StageStatus } from "./progress";
import type { CaseResult } from "./tester-log";

export type RunStatus = "queued" | "building" | "testing" | "passed" | "failed" | "build_failed" | "error";
export type RunRecord = {
  id: number;
  repo: string;
  branch: string;
  commitSha: string;
  status: RunStatus;
  stagesRequested: string[];
  createdAt: number;
  finishedAt: number | null;
  buildLog: string;
  testerLog: string;
};
export type StageResultRecord = {
  runId: number;
  stageSlug: string;
  status: StageStatus;
  log: string;
  failureLine: string | null;
};

type RunRow = {
  id: number; repo: string; branch: string; commit_sha: string; status: RunStatus; stages_requested: string;
  created_at: number; finished_at: number | null; build_log: string; tester_log: string;
};

const toRun = (r: RunRow): RunRecord => ({
  id: r.id, repo: r.repo, branch: r.branch, commitSha: r.commit_sha, status: r.status,
  stagesRequested: JSON.parse(r.stages_requested), createdAt: r.created_at, finishedAt: r.finished_at,
  buildLog: r.build_log, testerLog: r.tester_log,
});

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT NOT NULL,
      status TEXT NOT NULL, stages_requested TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER,
      build_log TEXT NOT NULL DEFAULT '', tester_log TEXT NOT NULL DEFAULT '')`);
    this.db.run(`CREATE TABLE IF NOT EXISTS stage_results (
      run_id INTEGER NOT NULL REFERENCES runs(id), stage_slug TEXT NOT NULL, status TEXT NOT NULL,
      log TEXT NOT NULL, failure_line TEXT, PRIMARY KEY (run_id, stage_slug))`);
    this.db.run("CREATE INDEX IF NOT EXISTS runs_repo ON runs(repo, id)");
  }

  createRun(repo: string, branch: string, commitSha: string, stagesRequested: string[]): RunRecord {
    const row = this.db
      .query<RunRow, [string, string, string, string, number]>(
        `INSERT INTO runs (repo, branch, commit_sha, status, stages_requested, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?) RETURNING *`,
      )
      .get(repo, branch, commitSha, JSON.stringify(stagesRequested), Date.now())!;
    return toRun(row);
  }

  setStagesRequested(id: number, stagesRequested: string[]): void {
    this.db.query("UPDATE runs SET stages_requested = ? WHERE id = ?").run(JSON.stringify(stagesRequested), id);
  }

  setStatus(id: number, status: RunStatus): void {
    this.db.query("UPDATE runs SET status = ? WHERE id = ?").run(status, id);
  }

  finishRun(
    id: number,
    f: { status: RunStatus; buildLog: string; testerLog: string; results: CaseResult[] },
  ): void {
    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE runs SET status = ?, build_log = ?, tester_log = ?, finished_at = ? WHERE id = ?")
        .run(f.status, f.buildLog, f.testerLog, Date.now(), id);
      const insert = this.db.query(
        "INSERT INTO stage_results (run_id, stage_slug, status, log, failure_line) VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of f.results) if (r.status !== "not_run") insert.run(id, r.slug, r.status, r.log, r.failureLine);
    });
    tx();
  }

  getRun(id: number): (RunRecord & { stageResults: StageResultRecord[] }) | null {
    const row = this.db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(id);
    if (!row) return null;
    const stageResults = this.db
      .query<{ run_id: number; stage_slug: string; status: StageStatus; log: string; failure_line: string | null }, [number]>(
        "SELECT * FROM stage_results WHERE run_id = ? ORDER BY rowid",
      )
      .all(id)
      .map((r) => ({ runId: r.run_id, stageSlug: r.stage_slug, status: r.status, log: r.log, failureLine: r.failure_line }));
    return { ...toRun(row), stageResults };
  }

  latestRun(repo: string): RunRecord | null {
    const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE repo = ? ORDER BY id DESC LIMIT 1").get(repo);
    return row ? toRun(row) : null;
  }

  /** Newest result per stage on `main` only: pushes to scratch branches are tested but never move progress. */
  latestStageResults(repo: string): Map<string, StageStatus> {
    const rows = this.db
      .query<{ stage_slug: string; status: StageStatus }, [string]>(
        `SELECT sr.stage_slug, sr.status FROM stage_results sr JOIN runs r ON r.id = sr.run_id
         WHERE r.repo = ? AND r.branch = 'main' ORDER BY r.id ASC`,
      )
      .all(repo);
    return new Map(rows.map((r) => [r.stage_slug, r.status]));
  }

  failInterruptedRuns(): number {
    return this.db
      .query("UPDATE runs SET status = 'error', finished_at = ? WHERE status IN ('queued', 'building', 'testing')")
      .run(Date.now()).changes;
  }
}
