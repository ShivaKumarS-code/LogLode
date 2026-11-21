/**
 * Typed query layer over the LogLode trajectory store.
 *
 * Every function takes a {@link LoglodeDb} handle, speaks the camelCase records
 * from `src/adapters/types.ts`, and hides SQLite's snake_case rows behind small
 * mappers. Timestamps are ISO 8601 strings supplied by the caller and stored as
 * TEXT: the query layer always writes explicit values (NULL when the record field
 * is null) and never leans on the schema's `CURRENT_TIMESTAMP` defaults.
 */

import type {
  MicroSkillRecord,
  SessionRecord,
  ToolCallRecord,
  WasteFindingRecord,
  WastePatternType,
} from '../adapters/types.js';
import type { LoglodeDb } from './db.js';

type Row = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Row helpers                                                                 */
/* -------------------------------------------------------------------------- */

function asRow(value: unknown): Row {
  if (typeof value !== 'object' || value === null) {
    throw new Error('loglode store: expected a result row object from SQLite');
  }
  return value as Row;
}

function asRows(values: unknown[]): Row[] {
  return values.map(asRow);
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

function toText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function toNullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapSession(row: Row): SessionRecord {
  return {
    id: toText(row.id),
    repoHash: toText(row.repo_hash),
    cliTool: toText(row.cli_tool) as SessionRecord['cliTool'],
    taskPromptHash: toNullableText(row.task_prompt_hash),
    gitHeadStart: toNullableText(row.git_head_start),
    skillVersionId: toNullableNumber(row.skill_version_id),
    // The schema leaves `status` nullable; the shared contract requires a string.
    status: toText(row.status),
    inputTokens: toNumber(row.input_tokens),
    cacheReadTokens: toNumber(row.cache_read_tokens),
    cacheWriteTokens: toNumber(row.cache_write_tokens),
    outputTokens: toNumber(row.output_tokens),
    estimatedCostUsd: toNumber(row.estimated_cost_usd),
    startedAt: toNullableText(row.started_at),
    endedAt: toNullableText(row.ended_at),
  };
}

function mapToolCall(row: Row): ToolCallRecord {
  return {
    sessionId: toText(row.session_id),
    turnIndex: toNumber(row.turn_index),
    toolName: toText(row.tool_name),
    targetPath: toNullableText(row.target_path),
    commandSignature: toNullableText(row.command_signature),
    exitCode: toNullableNumber(row.exit_code),
    outputTokens: toNumber(row.output_tokens),
    errorFingerprint: toNullableText(row.error_fingerprint),
    createdAt: toNullableText(row.created_at),
  };
}

function mapWasteFinding(row: Row): WasteFindingRecord {
  return {
    repoHash: toText(row.repo_hash),
    sessionId: toText(row.session_id),
    patternType: toText(row.pattern_type) as WastePatternType,
    signature: toText(row.signature),
    occurrences: toNumber(row.occurrences),
    wastedTokens: toNumber(row.wasted_tokens),
    evidenceJson: toText(row.evidence_json),
  };
}

function mapMicroSkill(row: Row): MicroSkillRecord {
  return {
    id: toNumber(row.id),
    repoHash: toText(row.repo_hash),
    skillKey: toText(row.skill_key),
    ruleText: toText(row.rule_text),
    tokenCount: toNumber(row.token_count),
    linkedPathsJson: toNullableText(row.linked_paths_json),
    sourceSessions: toNumber(row.source_sessions),
    estimatedSavings: toNumber(row.estimated_savings),
    lastValidatedCommit: toNullableText(row.last_validated_commit),
    active: toNumber(row.active),
    updatedAt: toNullableText(row.updated_at),
  };
}

function lastInsertRowid(db: LoglodeDb): number {
  return toNumber(asRow(db.prepare('SELECT last_insert_rowid() AS id').get()).id);
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

const INSERT_SESSION_SQL = `
INSERT INTO sessions (
  id, repo_hash, cli_tool, task_prompt_hash, git_head_start, skill_version_id,
  status, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
  estimated_cost_usd, started_at, ended_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Insert a new session row, including explicit NULLs for unknown fields. */
export function insertSession(db: LoglodeDb, rec: SessionRecord): void {
  db.prepare(INSERT_SESSION_SQL).run(
    rec.id,
    rec.repoHash,
    rec.cliTool,
    rec.taskPromptHash,
    rec.gitHeadStart,
    rec.skillVersionId,
    rec.status,
    rec.inputTokens,
    rec.cacheReadTokens,
    rec.cacheWriteTokens,
    rec.outputTokens,
    rec.estimatedCostUsd,
    rec.startedAt,
    rec.endedAt,
  );
}

const FINALIZE_SESSION_SQL = `
UPDATE sessions
   SET input_tokens = ?,
       cache_read_tokens = ?,
       cache_write_tokens = ?,
       output_tokens = ?,
       estimated_cost_usd = ?,
       status = ?,
       ended_at = ?
 WHERE id = ?`;

/** Write the end-of-session totals and terminal status for an existing session. */
export function finalizeSession(
  db: LoglodeDb,
  sessionId: string,
  patch: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    status: string;
    endedAt: string;
  },
): void {
  db.prepare(FINALIZE_SESSION_SQL).run(
    patch.inputTokens,
    patch.cacheReadTokens,
    patch.cacheWriteTokens,
    patch.outputTokens,
    patch.estimatedCostUsd,
    patch.status,
    patch.endedAt,
    sessionId,
  );
}

/** Return one session, or `null` when the id is unknown. */
export function getSession(db: LoglodeDb, sessionId: string): SessionRecord | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  return row === undefined ? null : mapSession(asRow(row));
}

/** Most recent sessions for a repository, newest first, capped at `limit`. */
export function getRecentSessions(db: LoglodeDb, repoHash: string, limit: number): SessionRecord[] {
  const rows = db
    .prepare('SELECT * FROM sessions WHERE repo_hash = ? ORDER BY started_at DESC, id DESC LIMIT ?')
    .all(repoHash, limit);
  return asRows(rows).map(mapSession);
}

/** Number of recorded sessions for a repository. */
export function countSessions(db: LoglodeDb, repoHash: string): number {
  const row = asRow(db.prepare('SELECT COUNT(*) AS session_count FROM sessions WHERE repo_hash = ?').get(repoHash));
  return toNumber(row.session_count);
}

/* -------------------------------------------------------------------------- */
/* Tool calls                                                                  */
/* -------------------------------------------------------------------------- */

const INSERT_TOOL_CALL_SQL = `
INSERT INTO tool_calls (
  session_id, turn_index, tool_name, target_path, command_signature, exit_code,
  output_tokens, error_fingerprint, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Insert one tool call and return its autoincrement row id. */
export function insertToolCall(db: LoglodeDb, rec: ToolCallRecord): number {
  db.prepare(INSERT_TOOL_CALL_SQL).run(
    rec.sessionId,
    rec.turnIndex,
    rec.toolName,
    rec.targetPath,
    rec.commandSignature,
    rec.exitCode,
    rec.outputTokens,
    rec.errorFingerprint,
    rec.createdAt,
  );
  return lastInsertRowid(db);
}

/**
 * Fetch the tool calls of the given sessions, ordered by session id, then turn
 * index, then insertion order. Returns an empty list for an empty input list.
 */
export function getToolCallsForSessions(db: LoglodeDb, sessionIds: string[]): ToolCallRecord[] {
  if (sessionIds.length === 0) {
    return [];
  }
  const placeholders = sessionIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM tool_calls WHERE session_id IN (${placeholders}) ORDER BY session_id ASC, turn_index ASC, id ASC`,
    )
    .all(...sessionIds);
  return asRows(rows).map(mapToolCall);
}

/* -------------------------------------------------------------------------- */
/* Waste findings                                                              */
/* -------------------------------------------------------------------------- */

const INSERT_WASTE_FINDING_SQL = `
INSERT INTO waste_findings (
  repo_hash, session_id, pattern_type, signature, occurrences, wasted_tokens,
  evidence_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Insert a batch of waste findings atomically.
 *
 * `WasteFindingRecord` carries no timestamp field, so the store stamps one
 * explicitly at insert time rather than relying on the column default.
 */
export function insertWasteFindings(db: LoglodeDb, recs: WasteFindingRecord[]): void {
  if (recs.length === 0) {
    return;
  }
  const statement = db.prepare(INSERT_WASTE_FINDING_SQL);
  const createdAt = new Date().toISOString();

  db.exec('SAVEPOINT loglode_insert_waste_findings');
  try {
    for (const rec of recs) {
      statement.run(
        rec.repoHash,
        rec.sessionId,
        rec.patternType,
        rec.signature,
        rec.occurrences,
        rec.wastedTokens,
        rec.evidenceJson,
        createdAt,
      );
    }
  } catch (error) {
    db.exec('ROLLBACK TO loglode_insert_waste_findings');
    db.exec('RELEASE loglode_insert_waste_findings');
    throw error;
  }
  db.exec('RELEASE loglode_insert_waste_findings');
}

/** Waste findings for a repository, ordered by wasted tokens (largest first). */
export function getWasteFindingsForRepo(
  db: LoglodeDb,
  repoHash: string,
  opts: { patternType?: WastePatternType; limit?: number } = {},
): WasteFindingRecord[] {
  const params: unknown[] = [repoHash];
  let sql = 'SELECT * FROM waste_findings WHERE repo_hash = ?';
  if (opts.patternType !== undefined) {
    sql += ' AND pattern_type = ?';
    params.push(opts.patternType);
  }
  sql += ' ORDER BY wasted_tokens DESC, id ASC';
  if (opts.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }
  return asRows(db.prepare(sql).all(...params)).map(mapWasteFinding);
}

/** All findings sharing a cross-session deduplication signature. */
export function getWasteFindingsBySignature(
  db: LoglodeDb,
  repoHash: string,
  signature: string,
): WasteFindingRecord[] {
  const rows = db
    .prepare('SELECT * FROM waste_findings WHERE repo_hash = ? AND signature = ? ORDER BY id ASC')
    .all(repoHash, signature);
  return asRows(rows).map(mapWasteFinding);
}

/* -------------------------------------------------------------------------- */
/* Micro-skills                                                                */
/* -------------------------------------------------------------------------- */

const INSERT_MICRO_SKILL_SQL = `
INSERT INTO micro_skills (
  repo_hash, skill_key, rule_text, token_count, linked_paths_json,
  source_sessions, estimated_savings, last_validated_commit, active, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Insert a new micro-skill (with `rec.id` null) and return its assigned id. */
export function insertMicroSkill(db: LoglodeDb, rec: MicroSkillRecord): number {
  db.prepare(INSERT_MICRO_SKILL_SQL).run(
    rec.repoHash,
    rec.skillKey,
    rec.ruleText,
    rec.tokenCount,
    rec.linkedPathsJson,
    rec.sourceSessions,
    rec.estimatedSavings,
    rec.lastValidatedCommit,
    rec.active,
    rec.updatedAt,
  );
  return lastInsertRowid(db);
}

const UPDATE_MICRO_SKILL_SQL = `
UPDATE micro_skills
   SET repo_hash = ?,
       skill_key = ?,
       rule_text = ?,
       token_count = ?,
       linked_paths_json = ?,
       source_sessions = ?,
       estimated_savings = ?,
       last_validated_commit = ?,
       active = ?,
       updated_at = ?
 WHERE id = ?`;

/**
 * Update an existing micro-skill by id.
 *
 * Throws when `rec.id` is null or no row with that id exists: silently updating
 * nothing would let the distiller believe a skill mutation was persisted.
 */
export function updateMicroSkill(db: LoglodeDb, rec: MicroSkillRecord): void {
  if (rec.id === null) {
    throw new Error('updateMicroSkill: MicroSkillRecord.id must not be null');
  }
  const existing = db.prepare('SELECT id FROM micro_skills WHERE id = ?').get(rec.id);
  if (existing === undefined) {
    throw new Error(`updateMicroSkill: no micro_skill with id ${rec.id}`);
  }
  db.prepare(UPDATE_MICRO_SKILL_SQL).run(
    rec.repoHash,
    rec.skillKey,
    rec.ruleText,
    rec.tokenCount,
    rec.linkedPathsJson,
    rec.sourceSessions,
    rec.estimatedSavings,
    rec.lastValidatedCommit,
    rec.active,
    rec.updatedAt,
    rec.id,
  );
}

/** Mark a micro-skill inactive (the pruning retire path); unknown keys are a no-op. */
export function deactivateMicroSkill(db: LoglodeDb, repoHash: string, skillKey: string): void {
  db.prepare('UPDATE micro_skills SET active = 0 WHERE repo_hash = ? AND skill_key = ?').run(repoHash, skillKey);
}

/** Active micro-skills for injection into the next session's context block. */
export function listActiveMicroSkills(db: LoglodeDb, repoHash: string): MicroSkillRecord[] {
  const rows = db
    .prepare('SELECT * FROM micro_skills WHERE repo_hash = ? AND active = 1 ORDER BY id ASC')
    .all(repoHash);
  return asRows(rows).map(mapMicroSkill);
}

/** Every micro-skill for a repository, active or retired (eval / audit paths). */
export function listAllMicroSkills(db: LoglodeDb, repoHash: string): MicroSkillRecord[] {
  const rows = db.prepare('SELECT * FROM micro_skills WHERE repo_hash = ? ORDER BY id ASC').all(repoHash);
  return asRows(rows).map(mapMicroSkill);
}
