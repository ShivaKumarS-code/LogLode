import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionRecord, ToolCallRecord, WasteFindingRecord } from '../adapters/types.js';
import { openMemoryDb, type LoglodeDb } from '../store/db.js';
import { insertSession, insertToolCall } from '../store/queries.js';
import {
  detectSessionWaste,
  mineWindow,
  type EditOscillationEvidence,
  type FailLoopEvidence,
  type LogFloodEvidence,
  type RepeatReadEvidence,
  type SessionFindings,
  type SearchThrashEvidence,
} from './detectors.js';

const REPO = 'miner-repo';
const OTHER_REPO = 'other-repo';

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

/** Build a fully-populated tool-call record with deterministic defaults. */
function makeCall(
  sessionId: string,
  turnIndex: number,
  overrides: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  return {
    sessionId,
    turnIndex,
    toolName: 'read_file',
    targetPath: null,
    commandSignature: null,
    exitCode: 0,
    outputTokens: 10,
    errorFingerprint: null,
    createdAt: null,
    ...overrides,
  };
}

/**
 * A sequence builder: every call gets the next turn index, so a hand-built
 * trajectory reads in the order the story happened.
 */
function sequence(sessionId = 'session-1'): (overrides?: Partial<ToolCallRecord>) => ToolCallRecord {
  let turn = 0;
  return (overrides: Partial<ToolCallRecord> = {}): ToolCallRecord => {
    const call = makeCall(sessionId, turn, overrides);
    turn += 1;
    return call;
  };
}

function parseEvidence<T>(finding: WasteFindingRecord): T {
  return JSON.parse(finding.evidenceJson) as T;
}

function singleFinding(findings: WasteFindingRecord[]): WasteFindingRecord {
  assert.equal(findings.length, 1, `expected exactly one finding, got ${findings.length}`);
  return findings[0];
}

function patternsOf(findings: WasteFindingRecord[]): string[] {
  return findings.map((finding) => finding.patternType);
}

/** Build a session row for the in-memory store. */
function sessionRecord(id: string, startedAt: string, repoHash = REPO): SessionRecord {
  return {
    id,
    repoHash,
    cliTool: 'claude_code',
    taskPromptHash: null,
    gitHeadStart: null,
    skillVersionId: null,
    status: 'completed',
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    startedAt,
    endedAt: null,
  };
}

function withDb(fn: (db: LoglodeDb) => void): void {
  const db = openMemoryDb();
  try {
    fn(db);
  } finally {
    db.close();
  }
}

/** Insert `tokens.length` reads of `path`, one per turn. */
function seedRepeatedReads(
  db: LoglodeDb,
  sessionId: string,
  path: string,
  tokens: number[],
): void {
  tokens.forEach((outputTokens, index) => {
    insertToolCall(
      db,
      makeCall(sessionId, index, { toolName: 'read_file', targetPath: path, outputTokens }),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* repeat_read                                                                 */
/* -------------------------------------------------------------------------- */

describe('repeat_read', () => {
  it('fires on 3 reads of the same path with exact occurrences and waste', () => {
    const add = sequence();
    const calls = [
      add({ targetPath: 'src/auth/guard.ts', outputTokens: 100 }),
      add({ targetPath: 'src/auth/guard.ts', outputTokens: 150 }),
      add({ targetPath: 'src/auth/guard.ts', outputTokens: 250 }),
      add({ targetPath: 'src/index.ts', outputTokens: 999 }),
      add({ targetPath: null, outputTokens: 999 }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));

    assert.equal(finding.patternType, 'repeat_read');
    assert.equal(finding.repoHash, REPO);
    assert.equal(finding.sessionId, 'session-1');
    assert.equal(finding.signature, 'repeat_read:src/auth/guard.ts');
    assert.equal(finding.occurrences, 3);
    // Every read after the first is waste: 150 + 250.
    assert.equal(finding.wastedTokens, 400);
    assert.deepEqual(parseEvidence<RepeatReadEvidence>(finding), {
      targetPath: 'src/auth/guard.ts',
      reads: 3,
      wastedReadTokens: 400,
    });
  });

  it('counts only reads after the first (4 reads waste reads 2..4)', () => {
    const add = sequence();
    const calls = [
      add({ targetPath: 'src/a.ts', outputTokens: 10 }),
      add({ targetPath: 'src/a.ts', outputTokens: 20 }),
      add({ targetPath: 'src/a.ts', outputTokens: 30 }),
      add({ targetPath: 'src/a.ts', outputTokens: 40 }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));
    assert.equal(finding.occurrences, 4);
    assert.equal(finding.wastedTokens, 90);
    assert.equal(parseEvidence<RepeatReadEvidence>(finding).wastedReadTokens, 90);
  });

  it('does not fire on 2 reads only', () => {
    const add = sequence();
    const calls = [
      add({ targetPath: 'src/a.ts' }),
      add({ targetPath: 'src/a.ts' }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });

  it('an intervening edit resets the counter (read, edit, read, edit, read)', () => {
    const add = sequence();
    const calls = [
      add({ targetPath: 'src/a.ts' }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ targetPath: 'src/a.ts' }),
      add({ toolName: 'write_file', targetPath: 'src/a.ts' }),
      add({ targetPath: 'src/a.ts' }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });

  it('re-clusters after an edit and keeps the first cluster finding', () => {
    const add = sequence();
    const calls = [
      add({ targetPath: 'src/a.ts', outputTokens: 10 }),
      add({ targetPath: 'src/a.ts', outputTokens: 20 }),
      add({ targetPath: 'src/a.ts', outputTokens: 30 }),
      add({ targetPath: 'src/a.ts', outputTokens: 40 }),
      add({ toolName: 'apply_patch', targetPath: 'src/a.ts', outputTokens: 5 }),
      add({ targetPath: 'src/a.ts', outputTokens: 100 }),
      add({ targetPath: 'src/a.ts', outputTokens: 200 }),
      add({ targetPath: 'src/a.ts', outputTokens: 300 }),
    ];

    const findings = detectSessionWaste(REPO, 'session-1', calls);

    assert.equal(findings.length, 2);
    // Ranked by waste: first cluster 20 + 30 + 40 = 90, second 200 + 300 = 500.
    assert.deepEqual(
      findings.map((finding) => [finding.occurrences, finding.wastedTokens]),
      [
        [3, 500],
        [4, 90],
      ],
    );
    // The same path re-clustered under the same stable cross-session signature.
    assert.deepEqual(
      findings.map((finding) => finding.signature),
      ['repeat_read:src/a.ts', 'repeat_read:src/a.ts'],
    );
    assert.deepEqual(
      findings.map((finding) => parseEvidence<RepeatReadEvidence>(finding).reads),
      [3, 4],
    );
  });

  it('interleaved reads of other paths do not interrupt a cluster', () => {
    const add = sequence();
    const calls = [
      add({ targetPath: 'src/a.ts', outputTokens: 10 }),
      add({ targetPath: 'src/b.ts', outputTokens: 10 }),
      add({ targetPath: 'src/a.ts', outputTokens: 20 }),
      add({ targetPath: 'src/b.ts', outputTokens: 10 }),
      add({ targetPath: 'src/a.ts', outputTokens: 30 }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));
    assert.equal(finding.signature, 'repeat_read:src/a.ts');
    assert.equal(finding.occurrences, 3);
    assert.equal(finding.wastedTokens, 50);
  });

  it('ignores null target paths', () => {
    const add = sequence();
    const calls = [
      add({ targetPath: null }),
      add({ targetPath: null }),
      add({ targetPath: null }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });
});

/* -------------------------------------------------------------------------- */
/* fail_loop                                                                   */
/* -------------------------------------------------------------------------- */

describe('fail_loop', () => {
  it('records the failing command and the later succeeding invocation', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'bash', commandSignature: 'npm test', exitCode: 1, outputTokens: 100, errorFingerprint: 'fp-1' }),
      add({ toolName: 'bash', commandSignature: 'npm test', exitCode: 2, outputTokens: 50, errorFingerprint: 'fp-1' }),
      add({ toolName: 'bash', commandSignature: 'npm test', exitCode: 0, outputTokens: 5 }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));

    assert.equal(finding.patternType, 'fail_loop');
    assert.equal(finding.signature, 'fail_loop:npm test');
    assert.equal(finding.occurrences, 2);
    assert.equal(finding.wastedTokens, 150);
    assert.deepEqual(parseEvidence<FailLoopEvidence>(finding), {
      signature: 'fail_loop:npm test',
      failures: 2,
      failingCommand: 'npm test',
      succeedingCommand: 'npm test',
    });
  });

  it('still records repeated failures that have no succeeding variant yet', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'bash', commandSignature: 'pytest', exitCode: 1, outputTokens: 30 }),
      add({ toolName: 'bash', commandSignature: 'pytest', exitCode: 1, outputTokens: 40 }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));
    assert.equal(finding.occurrences, 2);
    assert.equal(finding.wastedTokens, 70);
    assert.deepEqual(parseEvidence<FailLoopEvidence>(finding), {
      signature: 'fail_loop:pytest',
      failures: 2,
      failingCommand: 'pytest',
      succeedingCommand: null,
    });
  });

  it('does not fire on a single failure', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'bash', commandSignature: 'pytest', exitCode: 1, outputTokens: 30 }),
      add({ toolName: 'bash', commandSignature: 'npm test', exitCode: 1, outputTokens: 30 }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });

  it('groups by error fingerprint when no command signature exists', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'bash', commandSignature: null, exitCode: 1, outputTokens: 10, errorFingerprint: 'fp-abc' }),
      add({ toolName: 'bash', commandSignature: null, exitCode: 1, outputTokens: 20, errorFingerprint: 'fp-abc' }),
      // A later call clears the failure: same stderr fingerprint, exit 0, and
      // now a known working invocation.
      add({
        toolName: 'bash',
        commandSignature: 'npm test -- --run',
        exitCode: 0,
        outputTokens: 5,
        errorFingerprint: 'fp-abc',
      }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));
    assert.equal(finding.signature, 'fail_loop:fp-abc');
    assert.equal(finding.occurrences, 2);
    assert.equal(finding.wastedTokens, 30);
    assert.deepEqual(parseEvidence<FailLoopEvidence>(finding), {
      signature: 'fail_loop:fp-abc',
      failures: 2,
      failingCommand: null,
      succeedingCommand: 'npm test -- --run',
    });
  });

  it('only counts a success that comes after the last failure', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'bash', commandSignature: 'npm test', exitCode: 1, outputTokens: 10 }),
      add({ toolName: 'bash', commandSignature: 'npm test', exitCode: 0, outputTokens: 5 }),
      add({ toolName: 'bash', commandSignature: 'npm test', exitCode: 1, outputTokens: 10 }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));
    assert.equal(finding.occurrences, 2);
    assert.equal(parseEvidence<FailLoopEvidence>(finding).succeedingCommand, null);
  });

  it('does not group unrelated failures into one loop', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'bash', commandSignature: 'pnpm lint', exitCode: 1, outputTokens: 10 }),
      add({ toolName: 'bash', commandSignature: 'pnpm test', exitCode: 1, outputTokens: 10 }),
      add({ toolName: 'bash', commandSignature: 'pnpm lint', exitCode: 1, outputTokens: 10 }),
    ];

    // `pnpm lint` failed twice without a success, `pnpm test` once: exactly one
    // finding, not a merged three-failure loop.
    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));
    assert.equal(finding.signature, 'fail_loop:pnpm lint');
    assert.equal(finding.occurrences, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* search_thrash                                                               */
/* -------------------------------------------------------------------------- */

describe('search_thrash', () => {
  it('fires on 4 consecutive low-output searches', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'grep', commandSignature: 'rg TODO src', outputTokens: 10 }),
      add({ toolName: 'grep', commandSignature: 'rg TODO src', outputTokens: 10 }),
      add({ toolName: 'grep', commandSignature: 'rg TODO src', outputTokens: 10 }),
      add({ toolName: 'grep', commandSignature: 'rg TODO src', outputTokens: 10 }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));

    assert.equal(finding.patternType, 'search_thrash');
    assert.equal(finding.signature, 'search_thrash:rg TODO src');
    assert.equal(finding.occurrences, 4);
    assert.equal(finding.wastedTokens, 40);
    assert.deepEqual(parseEvidence<SearchThrashEvidence>(finding), {
      toolNames: ['grep'],
      runCount: 4,
      wastedTokens: 40,
    });
  });

  it('treats outputTokens === 40 as low and > 40 as fat', () => {
    const add = sequence();
    const boundary = [
      add({ toolName: 'grep', outputTokens: 40 }),
      add({ toolName: 'grep', outputTokens: 40 }),
      add({ toolName: 'grep', outputTokens: 40 }),
      add({ toolName: 'grep', outputTokens: 40 }),
    ];
    assert.equal(singleFinding(detectSessionWaste(REPO, 'session-1', boundary)).occurrences, 4);

    const withFatResult = [
      add({ toolName: 'grep', outputTokens: 10 }),
      add({ toolName: 'grep', outputTokens: 10 }),
      add({ toolName: 'grep', outputTokens: 41 }),
      add({ toolName: 'grep', outputTokens: 10 }),
      add({ toolName: 'grep', outputTokens: 10 }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-2', withFatResult), []);
  });

  it('does not fire on 3 consecutive searches', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'grep', outputTokens: 5 }),
      add({ toolName: 'grep', outputTokens: 5 }),
      add({ toolName: 'grep', outputTokens: 5 }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });

  it('an intervening edit breaks the run', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'grep', outputTokens: 5 }),
      add({ toolName: 'grep', outputTokens: 5 }),
      add({ toolName: 'edit', targetPath: 'src/a.ts', outputTokens: 5 }),
      add({ toolName: 'grep', outputTokens: 5 }),
      add({ toolName: 'grep', outputTokens: 5 }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });

  it('lists distinct search tool names in first-seen order', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'grep', outputTokens: 5 }),
      add({ toolName: 'glob', outputTokens: 5 }),
      add({ toolName: 'grep', outputTokens: 5 }),
      add({ toolName: 'search', outputTokens: 5 }),
    ];
    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));
    assert.equal(finding.signature, 'search_thrash:grep');
    assert.deepEqual(parseEvidence<SearchThrashEvidence>(finding), {
      toolNames: ['grep', 'glob', 'search'],
      runCount: 4,
      wastedTokens: 20,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* log_flood                                                                   */
/* -------------------------------------------------------------------------- */

describe('log_flood', () => {
  it('fires on a single result above 4000 tokens using the first non-null label', () => {
    const add = sequence();
    const calls = [
      add({
        toolName: 'read_file',
        targetPath: 'pnpm-lock.yaml',
        commandSignature: 'cat pnpm-lock.yaml',
        outputTokens: 4001,
      }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));

    assert.equal(finding.patternType, 'log_flood');
    assert.equal(finding.signature, 'log_flood:pnpm-lock.yaml');
    assert.equal(finding.occurrences, 1);
    assert.equal(finding.wastedTokens, 4001);
    assert.deepEqual(parseEvidence<LogFloodEvidence>(finding), {
      toolName: 'read_file',
      targetPath: 'pnpm-lock.yaml',
      outputTokens: 4001,
    });
  });

  it('does not treat exactly 4000 tokens as a flood', () => {
    const add = sequence();
    const calls = [add({ toolName: 'bash', targetPath: null, outputTokens: 4000 })];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });

  it('aggregates floods that share a signature', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'read_file', targetPath: 'pnpm-lock.yaml', outputTokens: 5000 }),
      add({ toolName: 'read_file', targetPath: 'dist/bundle.js', outputTokens: 4500 }),
      add({ toolName: 'read_file', targetPath: 'pnpm-lock.yaml', outputTokens: 6000 }),
    ];

    const findings = detectSessionWaste(REPO, 'session-1', calls);
    assert.equal(findings.length, 2);

    const lock = findings[0];
    assert.equal(lock?.signature, 'log_flood:pnpm-lock.yaml');
    assert.equal(lock?.occurrences, 2);
    assert.equal(lock?.wastedTokens, 11000);
    assert.deepEqual(parseEvidence<LogFloodEvidence>(lock as WasteFindingRecord), {
      toolName: 'read_file',
      targetPath: 'pnpm-lock.yaml',
      outputTokens: 11000,
    });

    const bundle = findings[1];
    assert.equal(bundle?.signature, 'log_flood:dist/bundle.js');
    assert.equal(bundle?.occurrences, 1);
    assert.equal(bundle?.wastedTokens, 4500);
  });

  it('falls back to commandSignature and then toolName', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'bash', targetPath: null, commandSignature: 'cat build.log', outputTokens: 6000 }),
      add({ toolName: 'bash', targetPath: null, commandSignature: null, outputTokens: 5000 }),
    ];

    const findings = detectSessionWaste(REPO, 'session-1', calls);
    assert.deepEqual(
      findings.map((finding) => finding.signature),
      ['log_flood:cat build.log', 'log_flood:bash'],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* edit_oscillation                                                            */
/* -------------------------------------------------------------------------- */

describe('edit_oscillation', () => {
  it('fires on 3 edits with 2 interleaved failures', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'bash', commandSignature: 'pnpm lint', exitCode: 1, outputTokens: 50, errorFingerprint: 'lint-1' }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'bash', commandSignature: 'pnpm test', exitCode: 2, outputTokens: 70 }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));

    assert.equal(finding.patternType, 'edit_oscillation');
    assert.equal(finding.signature, 'edit_oscillation:src/a.ts');
    assert.equal(finding.occurrences, 3);
    assert.equal(finding.wastedTokens, 120);
    assert.deepEqual(parseEvidence<EditOscillationEvidence>(finding), {
      targetPath: 'src/a.ts',
      edits: 3,
      failedResults: 2,
      wastedTokens: 120,
    });
  });

  it('requires 3 edits', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'bash', exitCode: 1, outputTokens: 50 }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'bash', exitCode: 1, outputTokens: 50 }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });

  it('requires 2 interleaved failures', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'bash', exitCode: 1, outputTokens: 50 }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });

  it('requires failures at all (3 edits, clean results)', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'bash', exitCode: 0, outputTokens: 50 }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'bash', exitCode: 0, outputTokens: 50 }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });

  it('ignores failures outside the first/last edit span', () => {
    const add = sequence();
    const calls = [
      add({ toolName: 'bash', exitCode: 1, outputTokens: 999, errorFingerprint: 'pre' }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'bash', exitCode: 1, outputTokens: 50 }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'bash', exitCode: 1, outputTokens: 60 }),
      add({ toolName: 'edit', targetPath: 'src/a.ts' }),
      add({ toolName: 'bash', exitCode: 1, outputTokens: 999, errorFingerprint: 'post' }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));
    assert.equal(finding.occurrences, 3);
    assert.equal(finding.wastedTokens, 110);
    assert.equal(parseEvidence<EditOscillationEvidence>(finding).failedResults, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* Ranking, signatures, robustness                                             */
/* -------------------------------------------------------------------------- */

describe('ranking and signatures', () => {
  it('orders findings by wastedTokens descending', () => {
    const add = sequence();
    const calls = [
      add({ targetPath: 'src/a.ts', outputTokens: 50 }),
      add({ targetPath: 'src/a.ts', outputTokens: 50 }),
      add({ targetPath: 'src/a.ts', outputTokens: 50 }),
      add({ toolName: 'grep', outputTokens: 10 }),
      add({ toolName: 'grep', outputTokens: 10 }),
      add({ toolName: 'grep', outputTokens: 10 }),
      add({ toolName: 'grep', outputTokens: 10 }),
      add({ toolName: 'bash', targetPath: null, commandSignature: 'cat big.log', outputTokens: 5000 }),
    ];

    const findings = detectSessionWaste(REPO, 'session-1', calls);
    assert.deepEqual(patternsOf(findings), ['log_flood', 'repeat_read', 'search_thrash']);
    assert.deepEqual(
      findings.map((finding) => finding.wastedTokens),
      [5000, 100, 40],
    );
  });

  it('produces identical signatures for the same behavior in different sessions', () => {
    const build = (sessionId: string): ToolCallRecord[] => {
      const add = sequence(sessionId);
      return [
        add({ targetPath: 'src/shared.ts', outputTokens: 10 }),
        add({ targetPath: 'src/shared.ts', outputTokens: 20 }),
        add({ targetPath: 'src/shared.ts', outputTokens: 30 }),
        add({ toolName: 'grep', outputTokens: 5 }),
        add({ toolName: 'grep', outputTokens: 5 }),
        add({ toolName: 'grep', outputTokens: 5 }),
        add({ toolName: 'grep', outputTokens: 5 }),
        add({ toolName: 'bash', commandSignature: 'npm test', exitCode: 1, outputTokens: 40 }),
        add({ toolName: 'bash', commandSignature: 'npm test', exitCode: 1, outputTokens: 40 }),
        add({ toolName: 'bash', targetPath: null, commandSignature: 'cat big.log', outputTokens: 5000 }),
      ];
    };

    const first = detectSessionWaste(REPO, 'session-1', build('session-1'));
    const second = detectSessionWaste(REPO, 'session-2', build('session-2'));

    assert.deepEqual(
      first.map((finding) => finding.signature),
      second.map((finding) => finding.signature),
    );
    assert.deepEqual(patternsOf(first), patternsOf(second));
  });
});

describe('robustness', () => {
  it('returns [] for an empty tool-call list and an empty window', () => {
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', []), []);
    withDb((db) => {
      assert.deepEqual(mineWindow(db, REPO), []);
      assert.deepEqual(mineWindow(db, REPO, { windowSize: 5 }), []);
    });
  });

  it('skips null target paths, null signatures, and malformed token counts', () => {
    const add = sequence();
    const calls = [
      add({ targetPath: null, commandSignature: null, errorFingerprint: null, outputTokens: Number.NaN }),
      add({ toolName: 'bash', targetPath: '', commandSignature: '', outputTokens: -50, exitCode: null }),
      add({ toolName: 'edit', targetPath: '  ', outputTokens: 0 }),
    ];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', calls), []);
  });

  it('does not throw on null rows in the array', () => {
    const garbage = [null, undefined, 42] as unknown as ToolCallRecord[];
    assert.deepEqual(detectSessionWaste(REPO, 'session-1', garbage), []);
  });

  it('processes the caller-supplied order; unsorted turn indices do not reorder', () => {
    // Insertion order is three reads then an edit; the turn labels happen to be
    // shuffled. The detector treats the array as the trajectory (the store's
    // query already orders by turn/row id), so this is a 3-read cluster.
    const calls = [
      makeCall('session-1', 3, { targetPath: 'src/a.ts', outputTokens: 10 }),
      makeCall('session-1', 0, { targetPath: 'src/a.ts', outputTokens: 10 }),
      makeCall('session-1', 1, { targetPath: 'src/a.ts', outputTokens: 10 }),
      makeCall('session-1', 2, { toolName: 'edit', targetPath: 'src/a.ts', outputTokens: 5 }),
    ];

    const finding = singleFinding(detectSessionWaste(REPO, 'session-1', calls));
    assert.equal(finding.occurrences, 3);
    assert.equal(finding.wastedTokens, 20);
  });
});

/* -------------------------------------------------------------------------- */
/* mineWindow                                                                  */
/* -------------------------------------------------------------------------- */

describe('mineWindow', () => {
  it('returns newest-first entries and omits sessions without findings', () => {
    withDb((db) => {
      insertSession(db, sessionRecord('session-1', '2026-01-01T10:00:00.000Z'));
      insertSession(db, sessionRecord('session-2', '2026-01-01T10:01:00.000Z'));
      insertSession(db, sessionRecord('session-3', '2026-01-01T10:02:00.000Z'));

      seedRepeatedReads(db, 'session-1', 'src/old.ts', [10, 10, 10]);
      // session-2 has no findings: one isolated read.
      insertToolCall(db, makeCall('session-2', 0, { targetPath: 'src/only.ts', outputTokens: 10 }));
      insertToolCall(
        db,
        makeCall('session-3', 0, {
          toolName: 'bash',
          targetPath: null,
          commandSignature: 'cat big.log',
          outputTokens: 5000,
        }),
      );

      const window: SessionFindings[] = mineWindow(db, REPO);

      assert.deepEqual(
        window.map((entry) => entry.sessionId),
        ['session-3', 'session-1'],
      );
      assert.equal(window[0]?.findings[0]?.patternType, 'log_flood');
      assert.equal(window[1]?.findings[0]?.signature, 'repeat_read:src/old.ts');
      assert.equal(window[1]?.findings[0]?.repoHash, REPO);
    });
  });

  it('honours windowSize and defaults to the last 10 sessions', () => {
    withDb((db) => {
      for (let index = 1; index <= 3; index += 1) {
        const id = `session-${index}`;
        insertSession(db, sessionRecord(id, `2026-01-01T10:0${index}:00.000Z`));
        seedRepeatedReads(db, id, `src/path-${index}.ts`, [10, 10, 10]);
      }

      assert.deepEqual(
        mineWindow(db, REPO).map((entry) => entry.sessionId),
        ['session-3', 'session-2', 'session-1'],
      );
      assert.deepEqual(
        mineWindow(db, REPO, { windowSize: 2 }).map((entry) => entry.sessionId),
        ['session-3', 'session-2'],
      );
      assert.deepEqual(mineWindow(db, REPO, { windowSize: 0 }), []);
    });
  });

  it('applies the cross-session repeat_read rule on the newest reading session', () => {
    withDb((db) => {
      insertSession(db, sessionRecord('session-1', '2026-01-01T10:00:00.000Z'));
      insertSession(db, sessionRecord('session-2', '2026-01-01T10:01:00.000Z'));
      insertSession(db, sessionRecord('session-3', '2026-01-01T10:02:00.000Z'));

      // 1 read in s1, 2 in s2, 2 in s3: no per-session cluster reaches 3 reads.
      seedRepeatedReads(db, 'session-1', 'src/shared.ts', [10]);
      seedRepeatedReads(db, 'session-2', 'src/shared.ts', [20, 20]);
      seedRepeatedReads(db, 'session-3', 'src/shared.ts', [30, 30]);

      const window = mineWindow(db, REPO);
      assert.equal(window.length, 1);
      assert.equal(window[0]?.sessionId, 'session-3');

      const finding = singleFinding(window[0]?.findings ?? []);
      assert.equal(finding.patternType, 'repeat_read');
      assert.equal(finding.signature, 'repeat_read:src/shared.ts');
      // Total reads across all three sessions.
      assert.equal(finding.occurrences, 5);
      // Only the two later sessions count as waste (40 + 60); s1 is baseline.
      assert.equal(finding.wastedTokens, 100);
      assert.deepEqual(parseEvidence<RepeatReadEvidence>(finding), {
        targetPath: 'src/shared.ts',
        reads: 5,
        wastedReadTokens: 100,
        sessions: ['session-1', 'session-2', 'session-3'],
      });
    });
  });

  it('does not double-emit a path already covered by the per-session rule', () => {
    withDb((db) => {
      insertSession(db, sessionRecord('session-1', '2026-01-01T10:00:00.000Z'));
      insertSession(db, sessionRecord('session-2', '2026-01-01T10:01:00.000Z'));
      insertSession(db, sessionRecord('session-3', '2026-01-01T10:02:00.000Z'));

      seedRepeatedReads(db, 'session-1', 'src/shared.ts', [10]);
      seedRepeatedReads(db, 'session-2', 'src/shared.ts', [20, 20]);
      // This time the newest session has its own 3-read cluster.
      seedRepeatedReads(db, 'session-3', 'src/shared.ts', [10, 10, 10]);

      const window = mineWindow(db, REPO);
      assert.equal(window.length, 1);
      const findings = window[0]?.findings ?? [];
      assert.equal(findings.filter((finding) => finding.patternType === 'repeat_read').length, 1);

      const finding = findings[0];
      assert.equal(finding?.signature, 'repeat_read:src/shared.ts');
      // The per-session finding keeps its own counts (3 reads, 2 re-reads).
      assert.equal(finding?.occurrences, 3);
      assert.equal(finding?.wastedTokens, 20);
      // Per-session evidence carries no session list.
      assert.deepEqual(parseEvidence<RepeatReadEvidence>(finding as WasteFindingRecord), {
        targetPath: 'src/shared.ts',
        reads: 3,
        wastedReadTokens: 20,
      });
    });
  });

  it('attaches the cross-session finding to the newest session that read the path', () => {
    withDb((db) => {
      insertSession(db, sessionRecord('session-1', '2026-01-01T10:00:00.000Z'));
      insertSession(db, sessionRecord('session-2', '2026-01-01T10:01:00.000Z'));
      insertSession(db, sessionRecord('session-3', '2026-01-01T10:02:00.000Z'));
      insertSession(db, sessionRecord('session-4', '2026-01-01T10:03:00.000Z'));

      seedRepeatedReads(db, 'session-1', 'src/shared.ts', [10]);
      seedRepeatedReads(db, 'session-2', 'src/shared.ts', [20]);
      seedRepeatedReads(db, 'session-3', 'src/shared.ts', [30]);
      insertToolCall(
        db,
        makeCall('session-4', 0, {
          toolName: 'read_file',
          targetPath: 'pnpm-lock.yaml',
          outputTokens: 5000,
        }),
      );

      const window = mineWindow(db, REPO);
      assert.deepEqual(
        window.map((entry) => entry.sessionId),
        ['session-4', 'session-3'],
      );
      const crossSession = window[1]?.findings[0];
      assert.equal(crossSession?.signature, 'repeat_read:src/shared.ts');
      assert.equal(crossSession?.occurrences, 3);
      // s1's 10 tokens are baseline; s2 + s3 are the waste.
      assert.equal(crossSession?.wastedTokens, 50);
      assert.deepEqual(parseEvidence<RepeatReadEvidence>(crossSession as WasteFindingRecord), {
        targetPath: 'src/shared.ts',
        reads: 3,
        wastedReadTokens: 50,
        sessions: ['session-1', 'session-2', 'session-3'],
      });
    });
  });

  it('reads tool calls in the store order (turn index then insertion order)', () => {
    withDb((db) => {
      insertSession(db, sessionRecord('session-1', '2026-01-01T10:00:00.000Z'));

      // Inserted out of turn order: the store query re-sorts to
      // read(turn 0), edit(turn 1), read(turn 2), which is not a read cluster.
      insertToolCall(db, makeCall('session-1', 0, { targetPath: 'src/a.ts', outputTokens: 10 }));
      insertToolCall(db, makeCall('session-1', 2, { targetPath: 'src/a.ts', outputTokens: 10 }));
      insertToolCall(db, makeCall('session-1', 1, { toolName: 'edit', targetPath: 'src/a.ts', outputTokens: 5 }));

      assert.deepEqual(mineWindow(db, REPO), []);
    });
  });

  it('ignores other repositories', () => {
    withDb((db) => {
      insertSession(db, sessionRecord('other-session', '2026-01-01T10:00:00.000Z', OTHER_REPO));
      seedRepeatedReads(db, 'other-session', 'src/a.ts', [10, 10, 10]);

      assert.deepEqual(mineWindow(db, REPO), []);
      assert.equal(mineWindow(db, OTHER_REPO).length, 1);
    });
  });
});
