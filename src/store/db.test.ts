import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LoglodeDb } from './db.js';
import { openMemoryDb, openStateDb } from './db.js';
import { withTempDir } from '../testing/tmp.js';

const REPO_HASH = 'abcdef12';

function queryAll(db: LoglodeDb, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => row as Record<string, unknown>);
}

function queryOne(db: LoglodeDb, sql: string, ...params: unknown[]): Record<string, unknown> {
  const row = db.prepare(sql).get(...params);
  assert.notEqual(row, undefined, `expected a row from: ${sql}`);
  return row as Record<string, unknown>;
}

function tableNames(db: LoglodeDb): string[] {
  return queryAll(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => String(row.name))
    .filter((name) => !name.startsWith('sqlite_'));
}

function indexNames(db: LoglodeDb): string[] {
  return queryAll(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").map((row) =>
    String(row.name),
  );
}

function insertRawSession(db: LoglodeDb, id: string): void {
  db.prepare(
    'INSERT INTO sessions (id, repo_hash, cli_tool, status, started_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, REPO_HASH, 'claude_code', 'completed', '2026-01-01T00:00:00.000Z');
}

describe('openMemoryDb', () => {
  it('creates the four tables and four indexes from the §4 schema', () => {
    const db = openMemoryDb();
    try {
      assert.deepEqual(tableNames(db), ['micro_skills', 'sessions', 'tool_calls', 'waste_findings']);
      assert.deepEqual(indexNames(db), [
        'idx_skills_repo_active',
        'idx_tool_calls_path',
        'idx_tool_calls_session',
        'idx_waste_repo_sig',
      ]);
    } finally {
      db.close();
    }
  });

  it('enables foreign key enforcement', () => {
    const db = openMemoryDb();
    try {
      assert.equal(Number(queryOne(db, 'PRAGMA foreign_keys').foreign_keys), 1);
    } finally {
      db.close();
    }
  });
});

describe('openStateDb', () => {
  it('creates <basePath>/.loglode/repos/<repoHash>/state.db in WAL mode', async () => {
    await withTempDir(async (basePath) => {
      const expectedPath = join(basePath, '.loglode', 'repos', REPO_HASH, 'state.db');
      assert.equal(existsSync(expectedPath), false);

      const db = openStateDb(REPO_HASH, { basePath });
      try {
        assert.equal(existsSync(expectedPath), true);
        assert.equal(String(queryOne(db, 'PRAGMA journal_mode').journal_mode), 'wal');
        assert.equal(Number(queryOne(db, 'PRAGMA foreign_keys').foreign_keys), 1);
      } finally {
        db.close();
      }
    });
  });

  it('re-opens without error or duplicate schema and keeps its data', async () => {
    await withTempDir(async (basePath) => {
      const first = openStateDb(REPO_HASH, { basePath });
      try {
        insertRawSession(first, 'session-1');
      } finally {
        first.close();
      }

      const second = openStateDb(REPO_HASH, { basePath });
      try {
        assert.equal(String(queryOne(second, 'PRAGMA journal_mode').journal_mode), 'wal');
        assert.deepEqual(tableNames(second), ['micro_skills', 'sessions', 'tool_calls', 'waste_findings']);
        assert.equal(indexNames(second).length, 4);
        assert.equal(Number(queryOne(second, 'SELECT COUNT(*) AS session_count FROM sessions').session_count), 1);
      } finally {
        second.close();
      }
    });
  });
});

describe('foreign key enforcement', () => {
  it('rejects a tool_call whose session does not exist', () => {
    const db = openMemoryDb();
    try {
      assert.throws(
        () =>
          db
            .prepare(
              'INSERT INTO tool_calls (session_id, turn_index, tool_name, output_tokens, created_at) VALUES (?, ?, ?, ?, ?)',
            )
            .run('missing-session', 0, 'bash', 10, '2026-01-01T00:00:00.000Z'),
        /FOREIGN KEY/i,
      );

      insertRawSession(db, 'known-session');
      db.prepare(
        'INSERT INTO tool_calls (session_id, turn_index, tool_name, output_tokens, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('known-session', 0, 'bash', 10, '2026-01-01T00:00:00.000Z');
      assert.equal(Number(queryOne(db, 'SELECT COUNT(*) AS tool_call_count FROM tool_calls').tool_call_count), 1);
    } finally {
      db.close();
    }
  });

  it('rejects a waste_finding whose session does not exist', () => {
    const db = openMemoryDb();
    try {
      assert.throws(
        () =>
          db
            .prepare(
              'INSERT INTO waste_findings (repo_hash, session_id, pattern_type, signature, occurrences, wasted_tokens, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(REPO_HASH, 'missing-session', 'repeat_read', 'sig', 3, 100, '{}'),
        /FOREIGN KEY/i,
      );

      insertRawSession(db, 'known-session');
      db.prepare(
        'INSERT INTO waste_findings (repo_hash, session_id, pattern_type, signature, occurrences, wasted_tokens, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(REPO_HASH, 'known-session', 'repeat_read', 'sig', 3, 100, '{}');
      assert.equal(Number(queryOne(db, 'SELECT COUNT(*) AS finding_count FROM waste_findings').finding_count), 1);
    } finally {
      db.close();
    }
  });
});

describe('micro_skills constraints', () => {
  const insertSkillSql =
    'INSERT INTO micro_skills (repo_hash, skill_key, rule_text, token_count, source_sessions, estimated_savings, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

  it('enforces UNIQUE(repo_hash, skill_key)', () => {
    const db = openMemoryDb();
    try {
      db.prepare(insertSkillSql).run(REPO_HASH, 'test-runner-flags', 'rule one', 10, 1, 0, 1, '2026-01-01T00:00:00.000Z');
      assert.throws(
        () =>
          db
            .prepare(insertSkillSql)
            .run(REPO_HASH, 'test-runner-flags', 'rule two', 12, 1, 0, 1, '2026-01-02T00:00:00.000Z'),
        /UNIQUE constraint failed/i,
      );

      // A different key in the same repo and the same key in another repo are fine.
      db.prepare(insertSkillSql).run(REPO_HASH, 'other-key', 'rule', 10, 1, 0, 1, null);
      db.prepare(insertSkillSql).run('other-repo', 'test-runner-flags', 'rule', 10, 1, 0, 1, null);
      assert.equal(Number(queryOne(db, 'SELECT COUNT(*) AS skill_count FROM micro_skills').skill_count), 3);
    } finally {
      db.close();
    }
  });
});
