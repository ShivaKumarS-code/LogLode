/**
 * SQLite connection layer for the LogLode trajectory store.
 *
 * The store is built on Node's bundled `node:sqlite` module, so LogLode needs no
 * native module and no npm dependency for persistence. Every other module talks
 * to the `LoglodeDb` handle below instead of importing `node:sqlite` types, which
 * keeps the driver swappable and makes the store easy to fake in tests.
 *
 * Schema: `docs/architecture.md` §4 "Data Schema (SQLite — WAL Mode)". The DDL
 * keeps the spec's table names, column names, types, defaults and constraints
 * verbatim; the only addition is `IF NOT EXISTS` so opening an existing
 * database neither errors nor duplicates schema objects.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * Minimal synchronous SQLite handle exposed to the rest of LogLode.
 *
 * Wrapping `DatabaseSync` keeps `node:sqlite` types out of every other module
 * and gives tests a single narrow surface to satisfy.
 */
export interface LoglodeDb {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): void;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/**
 * §4 schema, verbatim except for idempotent `IF NOT EXISTS` guards.
 *
 * The `DEFAULT CURRENT_TIMESTAMP` clauses stay because they are part of the
 * specified DDL, but the query layer never relies on them: every caller-supplied
 * timestamp is written explicitly (and NULL is written as an explicit NULL).
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  repo_hash           TEXT NOT NULL,
  cli_tool            TEXT NOT NULL,          -- 'claude_code' | 'codex'
  task_prompt_hash    TEXT,
  git_head_start      TEXT,
  skill_version_id    INTEGER,                -- NULL for baseline / --no-inject runs
  status              TEXT,                   -- 'completed' | 'aborted_budget' | 'failed'
  input_tokens        INTEGER DEFAULT 0,
  cache_read_tokens   INTEGER DEFAULT 0,
  cache_write_tokens  INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  estimated_cost_usd  REAL DEFAULT 0.0,
  started_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at            DATETIME
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  turn_index          INTEGER NOT NULL,
  tool_name           TEXT NOT NULL,          -- 'read_file' | 'bash' | 'edit' | 'grep' | 'glob'
  target_path         TEXT,                   -- normalised repo-relative path
  command_signature   TEXT,                   -- normalised cmd (flags kept, ephemeral args stripped)
  exit_code           INTEGER,
  output_tokens       INTEGER DEFAULT 0,      -- tokens returned back into agent context
  error_fingerprint   TEXT,                   -- hash of first 2 normalised stderr lines
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS waste_findings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_hash           TEXT NOT NULL,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  pattern_type        TEXT NOT NULL,          -- 'repeat_read' | 'fail_loop' | 'search_thrash' | 'log_flood' | 'edit_oscillation'
  signature           TEXT NOT NULL,          -- cross-session deduplication key
  occurrences         INTEGER NOT NULL,
  wasted_tokens       INTEGER NOT NULL,
  evidence_json       TEXT NOT NULL,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS micro_skills (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_hash             TEXT NOT NULL,
  skill_key             TEXT NOT NULL,        -- stable slug, e.g. 'test-runner-flags'
  rule_text             TEXT NOT NULL,        -- 1-3 terse imperative lines
  token_count           INTEGER NOT NULL,
  linked_paths_json     TEXT,                 -- JSON array of repo-relative paths for staleness check
  source_sessions       INTEGER DEFAULT 1,
  estimated_savings     INTEGER DEFAULT 0,
  last_validated_commit TEXT,
  active                INTEGER DEFAULT 1,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_hash, skill_key)
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_tool_calls_path ON tool_calls(target_path);
CREATE INDEX IF NOT EXISTS idx_waste_repo_sig ON waste_findings(repo_hash, signature);
CREATE INDEX IF NOT EXISTS idx_skills_repo_active ON micro_skills(repo_hash, active);
`;

/** Concrete `LoglodeDb` backed by a bundled SQLite connection. */
class SqliteLoglodeDb implements LoglodeDb {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): ReturnType<LoglodeDb['prepare']> {
    const statement = this.db.prepare(sql);
    return {
      run: (...params: unknown[]): void => {
        statement.run(...(params as SQLInputValue[]));
      },
      get: (...params: unknown[]): unknown => statement.get(...(params as SQLInputValue[])),
      all: (...params: unknown[]): unknown[] => statement.all(...(params as SQLInputValue[])),
    };
  }
}

function applySchema(db: LoglodeDb): void {
  db.exec(SCHEMA_SQL);
}

/**
 * Open (creating if needed) the per-repository state database at
 * `<basePath|homedir()>/.loglode/repos/<repoHash>/state.db`.
 *
 * Parent directories are created recursively, WAL mode and foreign-key
 * enforcement are enabled, and the §4 schema is applied idempotently. Passing
 * `basePath` is mandatory in tests so the real `~/.loglode` is never touched.
 */
export function openStateDb(repoHash: string, opts: { basePath?: string } = {}): LoglodeDb {
  const root = opts.basePath ?? homedir();
  const repoDir = join(root, '.loglode', 'repos', repoHash);
  mkdirSync(repoDir, { recursive: true });

  const handle = new SqliteLoglodeDb(new DatabaseSync(join(repoDir, 'state.db')));
  try {
    handle.exec('PRAGMA journal_mode = WAL;');
    handle.exec('PRAGMA foreign_keys = ON;');
    applySchema(handle);
  } catch (error) {
    handle.close();
    throw error;
  }
  return handle;
}

/**
 * Open a throwaway in-memory database with the same schema.
 *
 * WAL is a file-backed journal mode, so it is deliberately not requested here;
 * foreign-key enforcement and the schema still match the on-disk state DB.
 */
export function openMemoryDb(): LoglodeDb {
  const handle = new SqliteLoglodeDb(new DatabaseSync(':memory:'));
  try {
    handle.exec('PRAGMA foreign_keys = ON;');
    applySchema(handle);
  } catch (error) {
    handle.close();
    throw error;
  }
  return handle;
}
