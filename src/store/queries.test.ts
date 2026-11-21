import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MicroSkillRecord, SessionRecord, ToolCallRecord, WasteFindingRecord } from '../adapters/types.js';
import type { LoglodeDb } from './db.js';
import { openMemoryDb, openStateDb } from './db.js';
import {
  countSessions,
  deactivateMicroSkill,
  finalizeSession,
  getRecentSessions,
  getSession,
  getToolCallsForSessions,
  getWasteFindingsBySignature,
  getWasteFindingsForRepo,
  insertMicroSkill,
  insertSession,
  insertToolCall,
  insertWasteFindings,
  listActiveMicroSkills,
  listAllMicroSkills,
  updateMicroSkill,
} from './queries.js';
import { withTempDir } from '../testing/tmp.js';

const REPO = 'aaaabbbb';
const OTHER_REPO = 'ccccdddd';

function makeSession(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  const base: SessionRecord = {
    id: overrides.id,
    repoHash: REPO,
    cliTool: 'claude_code',
    taskPromptHash: 'prompt-hash-1',
    gitHeadStart: 'deadbeef',
    skillVersionId: 42,
    status: 'completed',
    inputTokens: 1000,
    cacheReadTokens: 200,
    cacheWriteTokens: 50,
    outputTokens: 300,
    estimatedCostUsd: 0.0125,
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: '2026-01-01T10:05:00.000Z',
  };
  return { ...base, ...overrides };
}

function makeToolCall(overrides: Partial<ToolCallRecord> & { sessionId: string }): ToolCallRecord {
  const base: ToolCallRecord = {
    sessionId: overrides.sessionId,
    turnIndex: 0,
    toolName: 'read_file',
    targetPath: 'src/index.ts',
    commandSignature: null,
    exitCode: 0,
    outputTokens: 120,
    errorFingerprint: null,
    createdAt: '2026-01-01T10:00:10.000Z',
  };
  return { ...base, ...overrides };
}

function makeWasteFinding(overrides: Partial<WasteFindingRecord> & { sessionId: string; signature: string }): WasteFindingRecord {
  const base: WasteFindingRecord = {
    repoHash: REPO,
    sessionId: overrides.sessionId,
    patternType: 'repeat_read',
    signature: overrides.signature,
    occurrences: 3,
    wastedTokens: 100,
    evidenceJson: '{"reads":3}',
  };
  return { ...base, ...overrides };
}

function makeSkill(overrides: Partial<MicroSkillRecord> & { skillKey: string }): MicroSkillRecord {
  const base: MicroSkillRecord = {
    id: null,
    repoHash: REPO,
    skillKey: overrides.skillKey,
    ruleText: 'Run the test suite with --run.',
    tokenCount: 12,
    linkedPathsJson: '["src/index.ts"]',
    sourceSessions: 3,
    estimatedSavings: 480,
    lastValidatedCommit: 'abc1234',
    active: 1,
    updatedAt: '2026-02-01T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function withDb(fn: (db: LoglodeDb) => void): void {
  const db = openMemoryDb();
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe('sessions', () => {
  it('round-trips a fully populated session', () => {
    withDb((db) => {
      const session = makeSession({ id: 'session-full' });
      insertSession(db, session);
      assert.deepEqual(getSession(db, session.id), session);
    });
  });

  it('round-trips a session whose optional fields are NULL', () => {
    withDb((db) => {
      const session = makeSession({
        id: 'session-nulls',
        cliTool: 'codex',
        taskPromptHash: null,
        gitHeadStart: null,
        skillVersionId: null,
        startedAt: null,
        endedAt: null,
      });
      insertSession(db, session);
      assert.deepEqual(getSession(db, session.id), session);
    });
  });

  it('returns null for an unknown session id', () => {
    withDb((db) => {
      assert.equal(getSession(db, 'does-not-exist'), null);
    });
  });

  it('finalizeSession writes totals, status and endedAt', () => {
    withDb((db) => {
      const session = makeSession({
        id: 'session-finalize',
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        status: 'failed',
        endedAt: null,
      });
      insertSession(db, session);

      finalizeSession(db, session.id, {
        inputTokens: 11,
        cacheReadTokens: 22,
        cacheWriteTokens: 33,
        outputTokens: 44,
        estimatedCostUsd: 0.5,
        status: 'aborted_budget',
        endedAt: '2026-01-01T11:00:00.000Z',
      });

      assert.deepEqual(getSession(db, session.id), {
        ...session,
        inputTokens: 11,
        cacheReadTokens: 22,
        cacheWriteTokens: 33,
        outputTokens: 44,
        estimatedCostUsd: 0.5,
        status: 'aborted_budget',
        endedAt: '2026-01-01T11:00:00.000Z',
      });
    });
  });

  it('getRecentSessions returns newest first, honours limit and repo scoping', () => {
    withDb((db) => {
      insertSession(db, makeSession({ id: 's-old', startedAt: '2026-01-01T00:00:00.000Z' }));
      insertSession(db, makeSession({ id: 's-new', startedAt: '2026-01-03T00:00:00.000Z' }));
      insertSession(db, makeSession({ id: 's-mid', startedAt: '2026-01-02T00:00:00.000Z' }));
      insertSession(db, makeSession({ id: 's-other', repoHash: OTHER_REPO, startedAt: '2026-01-04T00:00:00.000Z' }));

      assert.deepEqual(getRecentSessions(db, REPO, 10).map((s) => s.id), ['s-new', 's-mid', 's-old']);
      assert.deepEqual(getRecentSessions(db, REPO, 2).map((s) => s.id), ['s-new', 's-mid']);
      assert.deepEqual(getRecentSessions(db, REPO, 0), []);
      assert.deepEqual(getRecentSessions(db, OTHER_REPO, 10).map((s) => s.id), ['s-other']);
    });
  });

  it('countSessions counts only the requested repository', () => {
    withDb((db) => {
      assert.equal(countSessions(db, REPO), 0);
      assert.equal(countSessions(db, OTHER_REPO), 0);

      insertSession(db, makeSession({ id: 's1' }));
      insertSession(db, makeSession({ id: 's2' }));
      insertSession(db, makeSession({ id: 's3', repoHash: OTHER_REPO }));

      assert.equal(countSessions(db, REPO), 2);
      assert.equal(countSessions(db, OTHER_REPO), 1);
    });
  });
});

describe('tool calls', () => {
  it('insertToolCall returns increasing autoincrement ids and round-trips NULL fields', () => {
    withDb((db) => {
      insertSession(db, makeSession({ id: 'a-session' }));
      insertSession(db, makeSession({ id: 'b-session' }));

      const nullCall = makeToolCall({
        sessionId: 'a-session',
        turnIndex: 0,
        toolName: 'bash',
        targetPath: null,
        commandSignature: null,
        exitCode: null,
        outputTokens: 0,
        errorFingerprint: null,
        createdAt: null,
      });
      assert.equal(insertToolCall(db, nullCall), 1);
      assert.equal(insertToolCall(db, makeToolCall({ sessionId: 'b-session' })), 2);

      assert.deepEqual(getToolCallsForSessions(db, ['a-session']), [nullCall]);
    });
  });

  it('getToolCallsForSessions orders by session id, turn index, then row id', () => {
    withDb((db) => {
      insertSession(db, makeSession({ id: 'a-session' }));
      insertSession(db, makeSession({ id: 'b-session' }));

      // Deliberately scrambled insertion order.
      insertToolCall(db, makeToolCall({ sessionId: 'b-session', turnIndex: 0, targetPath: 'b0' }));
      insertToolCall(db, makeToolCall({ sessionId: 'a-session', turnIndex: 1, targetPath: 'a1' }));
      insertToolCall(db, makeToolCall({ sessionId: 'a-session', turnIndex: 0, targetPath: 'a0-first' }));
      insertToolCall(db, makeToolCall({ sessionId: 'a-session', turnIndex: 0, targetPath: 'a0-second' }));
      insertToolCall(db, makeToolCall({ sessionId: 'b-session', turnIndex: 1, targetPath: 'b1' }));

      assert.deepEqual(
        getToolCallsForSessions(db, ['b-session', 'a-session']).map((call) => call.targetPath),
        ['a0-first', 'a0-second', 'a1', 'b0', 'b1'],
      );
    });
  });

  it('getToolCallsForSessions returns nothing for an empty session list', () => {
    withDb((db) => {
      insertSession(db, makeSession({ id: 'a-session' }));
      insertToolCall(db, makeToolCall({ sessionId: 'a-session' }));
      assert.deepEqual(getToolCallsForSessions(db, []), []);
    });
  });
});

describe('waste findings', () => {
  function seedFindings(db: LoglodeDb): void {
    insertSession(db, makeSession({ id: 'session-1' }));
    insertSession(db, makeSession({ id: 'session-other', repoHash: OTHER_REPO }));
    insertWasteFindings(db, [
      makeWasteFinding({ sessionId: 'session-1', signature: 'sig-100', patternType: 'log_flood', wastedTokens: 100 }),
      makeWasteFinding({ sessionId: 'session-1', signature: 'sig-300', patternType: 'repeat_read', wastedTokens: 300 }),
      makeWasteFinding({ sessionId: 'session-1', signature: 'sig-200', patternType: 'search_thrash', wastedTokens: 200 }),
      makeWasteFinding({ sessionId: 'session-1', signature: 'sig-250', patternType: 'fail_loop', wastedTokens: 250 }),
      makeWasteFinding({
        repoHash: OTHER_REPO,
        sessionId: 'session-other',
        signature: 'sig-999',
        patternType: 'repeat_read',
        wastedTokens: 999,
      }),
    ]);
  }

  it('round-trips findings and orders by wasted tokens descending', () => {
    withDb((db) => {
      insertSession(db, makeSession({ id: 'session-1' }));
      insertSession(db, makeSession({ id: 'session-other', repoHash: OTHER_REPO }));
      const finding = makeWasteFinding({ sessionId: 'session-1', signature: 'unique-sig' });
      insertWasteFindings(db, [finding]);

      assert.deepEqual(getWasteFindingsForRepo(db, REPO), [finding]);
    });
  });

  it('applies ordering, limit and pattern type filters', () => {
    withDb((db) => {
      seedFindings(db);

      assert.deepEqual(
        getWasteFindingsForRepo(db, REPO).map((finding) => finding.wastedTokens),
        [300, 250, 200, 100],
      );
      assert.deepEqual(
        getWasteFindingsForRepo(db, REPO, { limit: 2 }).map((finding) => finding.wastedTokens),
        [300, 250],
      );
      assert.deepEqual(
        getWasteFindingsForRepo(db, REPO, { patternType: 'repeat_read' }).map((finding) => finding.signature),
        ['sig-300'],
      );
      assert.deepEqual(
        getWasteFindingsForRepo(db, REPO, { patternType: 'fail_loop', limit: 1 }).map((finding) => finding.signature),
        ['sig-250'],
      );
      assert.deepEqual(getWasteFindingsForRepo(db, 'unknown-repo'), []);
    });
  });

  it('treats an empty batch as a no-op', () => {
    withDb((db) => {
      insertSession(db, makeSession({ id: 'session-1' }));
      insertWasteFindings(db, []);
      assert.deepEqual(getWasteFindingsForRepo(db, REPO), []);
    });
  });

  it('getWasteFindingsBySignature returns matching findings ordered by id', () => {
    withDb((db) => {
      insertSession(db, makeSession({ id: 'session-1' }));
      insertWasteFindings(db, [
        makeWasteFinding({ sessionId: 'session-1', signature: 'dupe', wastedTokens: 10 }),
        makeWasteFinding({ sessionId: 'session-1', signature: 'other', wastedTokens: 500 }),
        makeWasteFinding({ sessionId: 'session-1', signature: 'dupe', wastedTokens: 20 }),
      ]);

      assert.deepEqual(
        getWasteFindingsBySignature(db, REPO, 'dupe').map((finding) => finding.wastedTokens),
        [10, 20],
      );
      assert.deepEqual(getWasteFindingsBySignature(db, REPO, 'missing'), []);
    });
  });
});

describe('micro-skills', () => {
  it('inserts and lists every field, preserving NULLs', () => {
    withDb((db) => {
      const skill = makeSkill({ skillKey: 'test-runner-flags' });
      const nulls = makeSkill({
        skillKey: 'nulls',
        linkedPathsJson: null,
        lastValidatedCommit: null,
        updatedAt: null,
      });

      const firstId = insertMicroSkill(db, skill);
      const secondId = insertMicroSkill(db, nulls);
      assert.equal(firstId, 1);
      assert.equal(secondId, 2);

      assert.deepEqual(listAllMicroSkills(db, REPO), [
        { ...skill, id: firstId },
        { ...nulls, id: secondId },
      ]);
    });
  });

  it('scopes lists to the requested repository', () => {
    withDb((db) => {
      insertMicroSkill(db, makeSkill({ skillKey: 'shared-key' }));
      insertMicroSkill(db, makeSkill({ skillKey: 'shared-key', repoHash: OTHER_REPO }));

      assert.deepEqual(listAllMicroSkills(db, REPO).map((skill) => skill.skillKey), ['shared-key']);
      assert.deepEqual(listAllMicroSkills(db, OTHER_REPO).map((skill) => skill.skillKey), ['shared-key']);
      assert.equal(listAllMicroSkills(db, REPO).length, 1);
    });
  });

  it('updateMicroSkill rewrites an existing row by id', () => {
    withDb((db) => {
      const id = insertMicroSkill(db, makeSkill({ skillKey: 'update-me' }));
      const [stored] = listAllMicroSkills(db, REPO);
      assert.equal(stored.id, id);

      const updated: MicroSkillRecord = {
        ...stored,
        ruleText: 'Use `npm test -- --reporter=dot`.',
        tokenCount: 9,
        linkedPathsJson: null,
        sourceSessions: 7,
        estimatedSavings: 900,
        lastValidatedCommit: null,
        active: 0,
        updatedAt: '2026-03-01T00:00:00.000Z',
      };
      updateMicroSkill(db, updated);

      assert.deepEqual(listAllMicroSkills(db, REPO), [updated]);
    });
  });

  it('updateMicroSkill throws for a null or unknown id', () => {
    withDb((db) => {
      assert.throws(() => updateMicroSkill(db, makeSkill({ skillKey: 'never-inserted' })), /id must not be null/);

      const id = insertMicroSkill(db, makeSkill({ skillKey: 'known' }));
      assert.throws(() => updateMicroSkill(db, makeSkill({ id: id + 100, skillKey: 'known' })), /no micro_skill with id/);
    });
  });

  it('deactivateMicroSkill hides a skill from the active list only', () => {
    withDb((db) => {
      insertMicroSkill(db, makeSkill({ skillKey: 'keep' }));
      insertMicroSkill(db, makeSkill({ skillKey: 'retire' }));

      deactivateMicroSkill(db, REPO, 'retire');
      deactivateMicroSkill(db, REPO, 'never-existed');

      assert.deepEqual(listActiveMicroSkills(db, REPO).map((skill) => skill.skillKey), ['keep']);
      assert.deepEqual(listAllMicroSkills(db, REPO).map((skill) => [skill.skillKey, skill.active]), [
        ['keep', 1],
        ['retire', 0],
      ]);
    });
  });
});

describe('state DB persistence', () => {
  it('keeps every record type across close and reopen', async () => {
    await withTempDir(async (basePath) => {
      const session = makeSession({ id: 'persisted-session' });
      const toolCall = makeToolCall({
        sessionId: session.id,
        turnIndex: 2,
        toolName: 'bash',
        commandSignature: 'npm test',
        exitCode: 1,
        errorFingerprint: 'fp-1',
      });
      const finding = makeWasteFinding({ sessionId: session.id, signature: 'persisted-sig' });
      const skill = makeSkill({ skillKey: 'persisted-skill' });

      const first = openStateDb(REPO, { basePath });
      let skillId = 0;
      try {
        insertSession(first, session);
        const toolCallId = insertToolCall(first, toolCall);
        assert.ok(toolCallId > 0);
        insertWasteFindings(first, [finding]);
        skillId = insertMicroSkill(first, skill);
      } finally {
        first.close();
      }

      const reopened = openStateDb(REPO, { basePath });
      try {
        assert.deepEqual(getSession(reopened, session.id), session);
        assert.deepEqual(getToolCallsForSessions(reopened, [session.id]), [toolCall]);
        assert.deepEqual(getWasteFindingsForRepo(reopened, REPO), [finding]);
        assert.deepEqual(getWasteFindingsBySignature(reopened, REPO, finding.signature), [finding]);
        assert.deepEqual(listAllMicroSkills(reopened, REPO), [{ ...skill, id: skillId }]);
        assert.equal(countSessions(reopened, REPO), 1);
      } finally {
        reopened.close();
      }
    });
  });
});
