import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DistillerResponse, MicroSkillRecord, SkillMutation, WasteFindingRecord } from '../adapters/types.js';
import type { DistillerConfig } from '../config.js';
import type { LoglodeDb } from '../store/db.js';
import { openMemoryDb } from '../store/db.js';
import { insertMicroSkill, listActiveMicroSkills, listAllMicroSkills } from '../store/queries.js';
import { applyMutations, distillSkills, promotionGate, roiScore } from './synthesize.js';

const REPO = 'a1b2c3d4';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T00:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const byLength = (text: string): number => text.length;
/** Exactly 100 characters, so token math in the eviction tests is hand-checkable. */
const HUNDRED_CHAR_RULE = 'Rule '.repeat(20);

function fixedNow(): Date {
  return NOW;
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function makeConfig(overrides: Partial<DistillerConfig> = {}): DistillerConfig {
  return {
    model: 'test-distiller',
    maxSkillFileTokens: 800,
    minSessionsToPromote: 2,
    minSingleSessionWaste: 8000,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<WasteFindingRecord> = {}): WasteFindingRecord {
  return {
    repoHash: REPO,
    sessionId: 'sess-1',
    patternType: 'repeat_read',
    signature: 'sig-alpha',
    occurrences: 2,
    wastedTokens: 1200,
    evidenceJson: '{"path":"src/a.ts","reads":3}',
    ...overrides,
  };
}

function makeSkill(overrides: Partial<MicroSkillRecord> & { skillKey: string }): MicroSkillRecord {
  return {
    id: null,
    repoHash: REPO,
    ruleText: 'Existing rule.',
    tokenCount: 14,
    linkedPathsJson: null,
    sourceSessions: 1,
    estimatedSavings: 0,
    lastValidatedCommit: null,
    active: 1,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function withDb<T>(fn: (db: LoglodeDb) => T): T {
  const db = openMemoryDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Insert a skill row and return it with its assigned id. */
function seedSkill(db: LoglodeDb, overrides: Partial<MicroSkillRecord> & { skillKey: string }): MicroSkillRecord {
  const record = makeSkill(overrides);
  const id = insertMicroSkill(db, record);
  return { ...record, id };
}

function activeKeys(db: LoglodeDb): string[] {
  return listActiveMicroSkills(db, REPO).map((skill) => skill.skillKey);
}

function evictionNotes(notes: string[]): string[] {
  return notes.filter((note) => note.startsWith('evicted '));
}

/* -------------------------------------------------------------------------- */
/* promotionGate (§6 safeguard 2)                                              */
/* -------------------------------------------------------------------------- */

describe('promotionGate', () => {
  it('promotes a cluster seen in two sessions and blocks a one-session 8,000-token cluster', () => {
    const result = promotionGate({
      config: makeConfig(),
      findings: [
        makeFinding({ signature: 'sig-alpha', sessionId: 's1', wastedTokens: 100 }),
        makeFinding({ signature: 'sig-alpha', sessionId: 's2', wastedTokens: 100 }),
        makeFinding({ signature: 'sig-beta', sessionId: 's3', wastedTokens: 8000 }),
      ],
    });

    assert.deepEqual(
      result.passed.map((finding) => finding.signature),
      ['sig-alpha', 'sig-alpha'],
    );
    assert.deepEqual(
      result.blocked.map((finding) => finding.signature),
      ['sig-beta'],
    );
  });

  it('promotes a single-session cluster only above the waste threshold (strictly greater)', () => {
    const blocked = promotionGate({
      config: makeConfig(),
      findings: [makeFinding({ signature: 'sig-edge', sessionId: 's1', wastedTokens: 8000 })],
    });
    assert.deepEqual(blocked.passed, []);
    assert.equal(blocked.blocked.length, 1);

    const passed = promotionGate({
      config: makeConfig(),
      findings: [makeFinding({ signature: 'sig-edge', sessionId: 's1', wastedTokens: 8001 })],
    });
    assert.equal(passed.passed.length, 1);
    assert.deepEqual(passed.blocked, []);
  });

  it('does not promote a one-session cluster merely because its findings sum above the threshold', () => {
    const result = promotionGate({
      config: makeConfig(),
      findings: [
        makeFinding({ signature: 'sig-split', sessionId: 's1', wastedTokens: 4000 }),
        makeFinding({ signature: 'sig-split', sessionId: 's1', wastedTokens: 4000 }),
      ],
    });

    assert.deepEqual(result.passed, []);
    assert.equal(result.blocked.length, 2);
  });

  it('orders passed findings by summed cluster waste, descending', () => {
    const result = promotionGate({
      config: makeConfig(),
      findings: [
        makeFinding({ signature: 'sig-small', sessionId: 's1', wastedTokens: 1000 }),
        makeFinding({ signature: 'sig-small', sessionId: 's2', wastedTokens: 1000 }),
        makeFinding({ signature: 'sig-big', sessionId: 's1', wastedTokens: 5000 }),
        makeFinding({ signature: 'sig-big', sessionId: 's2', wastedTokens: 6000 }),
        makeFinding({ signature: 'sig-mid', sessionId: 's1', wastedTokens: 3000 }),
        makeFinding({ signature: 'sig-mid', sessionId: 's2', wastedTokens: 3000 }),
      ],
    });

    assert.deepEqual(
      result.passed.map((finding) => finding.signature),
      ['sig-big', 'sig-big', 'sig-mid', 'sig-mid', 'sig-small', 'sig-small'],
    );
    // Within a cluster, input order is preserved.
    assert.deepEqual(
      result.passed.slice(0, 2).map((finding) => finding.wastedTokens),
      [5000, 6000],
    );
  });

  it('returns blocked findings in input order across interleaved clusters', () => {
    const result = promotionGate({
      config: makeConfig(),
      findings: [
        makeFinding({ signature: 'sig-blocked-a', sessionId: 's1', wastedTokens: 10 }),
        makeFinding({ signature: 'sig-blocked-b', sessionId: 's2', wastedTokens: 20 }),
        makeFinding({ signature: 'sig-blocked-a', sessionId: 's1', wastedTokens: 30 }),
      ],
    });

    assert.deepEqual(
      result.blocked.map((finding) => finding.wastedTokens),
      [10, 20, 30],
    );
  });

  it('returns nothing to promote for an empty finding list', () => {
    const result = promotionGate({ config: makeConfig(), findings: [] });
    assert.deepEqual(result, { passed: [], blocked: [] });
  });

  it('honours a custom session threshold of 1', () => {
    const result = promotionGate({
      config: makeConfig({ minSessionsToPromote: 1 }),
      findings: [makeFinding({ signature: 'sig-any', sessionId: 'only', wastedTokens: 1 })],
    });
    assert.equal(result.passed.length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* distillSkills                                                               */
/* -------------------------------------------------------------------------- */

const ACTIVE_SKILLS: MicroSkillRecord[] = [
  makeSkill({ skillKey: 'cmd-pnpm', ruleText: 'Use pnpm test.', tokenCount: 14 }),
];

function gatePassingFindings(): WasteFindingRecord[] {
  return [
    makeFinding({ signature: 'sig-alpha', sessionId: 's1', wastedTokens: 1200 }),
    makeFinding({ signature: 'sig-alpha', sessionId: 's2', wastedTokens: 800 }),
  ];
}

describe('distillSkills', () => {
  it('sends a terse prompt and returns the validated mutations', async () => {
    const prompts: string[] = [];
    const response: DistillerResponse = {
      mutations: [
        { op: 'add', skillKey: 'cmd-new', ruleText: 'Run pnpm test -w.', linkedPaths: ['src/a.ts'] },
        { op: 'retire', skillKey: 'cmd-pnpm', rationale: 'superseded' },
      ],
    };

    const result = await distillSkills(
      {
        repoHash: REPO,
        findings: gatePassingFindings(),
        activeSkills: ACTIVE_SKILLS,
        config: makeConfig(),
      },
      {
        callLlm: async (prompt) => {
          prompts.push(prompt);
          return response;
        },
        estimateTokens: byLength,
        now: fixedNow,
      },
    );

    assert.equal(result.llmUsed, true);
    assert.deepEqual(result.mutations, response.mutations);
    assert.match(result.notes[0] ?? '', /promotion gate passed 2 finding/);

    assert.equal(prompts.length, 1);
    const prompt = prompts[0] ?? '';
    assert.match(prompt, /signature=sig-alpha/);
    assert.match(prompt, /wastedTokens=1200/);
    assert.match(prompt, /evidence=\{"path":"src\/a\.ts","reads":3\}/);
    assert.match(prompt, /- cmd-pnpm \(14 tokens, savings=0, sessions=1\): Use pnpm test\./);
    assert.match(prompt, /STRICT JSON/);
    assert.match(prompt, /maxSkillFileTokens|under 800 tokens/);
  });

  it('skips gracefully when the LLM returns null', async () => {
    let calls = 0;
    const result = await distillSkills(
      { repoHash: REPO, findings: gatePassingFindings(), activeSkills: ACTIVE_SKILLS, config: makeConfig() },
      {
        callLlm: async () => {
          calls += 1;
          return null;
        },
      },
    );

    assert.equal(calls, 1);
    assert.deepEqual(result, {
      mutations: [],
      llmUsed: false,
      notes: ['distiller LLM returned no response; distillation skipped'],
    });
  });

  it('skips gracefully when the LLM throws', async () => {
    const result = await distillSkills(
      { repoHash: REPO, findings: gatePassingFindings(), activeSkills: ACTIVE_SKILLS, config: makeConfig() },
      {
        callLlm: async () => {
          throw new Error('provider 529 overloaded');
        },
      },
    );

    assert.equal(result.llmUsed, false);
    assert.deepEqual(result.mutations, []);
    assert.match(result.notes[0] ?? '', /provider 529 overloaded/);
  });

  it('reports zero mutations and a note when the response is not a DistillerResponse', async () => {
    const result = await distillSkills(
      { repoHash: REPO, findings: gatePassingFindings(), activeSkills: ACTIVE_SKILLS, config: makeConfig() },
      { callLlm: async () => ({ replies: [] }) as unknown as DistillerResponse },
    );

    assert.equal(result.llmUsed, true);
    assert.deepEqual(result.mutations, []);
    assert.match(result.notes[0] ?? '', /not a DistillerResponse/);
  });

  it('drops invalid mutation entries one by one with notes', async () => {
    const result = await distillSkills(
      { repoHash: REPO, findings: gatePassingFindings(), activeSkills: ACTIVE_SKILLS, config: makeConfig() },
      {
        callLlm: async () =>
          ({
            mutations: [
              { op: 'add', skillKey: 'Bad Key', ruleText: 'Nope.' },
              { op: 'add', skillKey: 'ok-key' },
              { op: 'explode', skillKey: 'ok-key', ruleText: 'Nope.' },
              { op: 'merge', skillKey: 'a-key', mergeIntoKey: '' },
              { op: 'merge', skillKey: 'a-key', mergeIntoKey: 'a-key' },
              { op: 'retire', skillKey: 'cmd-pnpm' },
            ],
          }) as DistillerResponse,
      },
    );

    assert.equal(result.llmUsed, true);
    assert.deepEqual(result.mutations, [{ op: 'retire', skillKey: 'cmd-pnpm' }]);
    const dropped = result.notes.filter((note) => note.startsWith('dropped invalid mutation'));
    assert.equal(dropped.length, 5);
    assert.match(dropped[0] ?? '', /not a lowercase slug/);
    assert.match(dropped[1] ?? '', /requires a non-empty ruleText/);
    assert.match(dropped[2] ?? '', /unknown op/);
    assert.match(dropped[3] ?? '', /requires mergeIntoKey/);
    assert.match(dropped[4] ?? '', /cannot merge a skill into itself/);
  });

  it('never calls the LLM when nothing passes the promotion gate', async () => {
    let calls = 0;
    const result = await distillSkills(
      {
        repoHash: REPO,
        findings: [makeFinding({ signature: 'sig-weak', sessionId: 's1', wastedTokens: 8000 })],
        activeSkills: ACTIVE_SKILLS,
        config: makeConfig(),
      },
      {
        callLlm: async () => {
          calls += 1;
          return { mutations: [] };
        },
      },
    );

    assert.equal(calls, 0);
    assert.equal(result.llmUsed, false);
    assert.deepEqual(result.mutations, []);
    assert.match(result.notes[0] ?? '', /promotion threshold/);
  });

  it('normalizes linked paths and trims fields on accepted mutations', async () => {
    const prompts: string[] = [];
    const result = await distillSkills(
      { repoHash: REPO, findings: gatePassingFindings(), activeSkills: [], config: makeConfig() },
      {
        callLlm: async (prompt) => {
          prompts.push(prompt);
          return {
            mutations: [
              {
                op: 'add',
                skillKey: '  cmd-trim  ',
                ruleText: '  Trimmed rule.  ',
                linkedPaths: ['src\\a.ts', './src/b.ts'],
                rationale: '  because  ',
              },
              { op: 'add', skillKey: 'cmd-strict', ruleText: 'Keep me.' },
            ],
          };
        },
      },
    );

    assert.deepEqual(result.mutations[0], {
      op: 'add',
      skillKey: 'cmd-trim',
      ruleText: 'Trimmed rule.',
      linkedPaths: ['src/a.ts', 'src/b.ts'],
      rationale: 'because',
    });
    assert.match(prompts[0] ?? '', /## Active skills \(current file contents\)\n- \(none\)/);
  });
});

/* -------------------------------------------------------------------------- */
/* applyMutations                                                              */
/* -------------------------------------------------------------------------- */

describe('applyMutations: add', () => {
  it('inserts a normalized record with the injected token estimate', () => {
    withDb((db) => {
      const result = applyMutations(
        db,
        REPO,
        [
          {
            op: 'add',
            skillKey: 'cmd-test',
            ruleText: '  Run tests with pnpm test.  ',
            linkedPaths: ['src\\a.ts', 'src/b.ts', './src/a.ts'],
          },
        ],
        {
          config: makeConfig(),
          headCommit: 'abc123',
          now: fixedNow,
          estimateTokens: () => 7,
        },
      );

      assert.deepEqual(result.applied, [
        {
          op: 'add',
          skillKey: 'cmd-test',
          ruleText: 'Run tests with pnpm test.',
          linkedPaths: ['src/a.ts', 'src/b.ts'],
        },
      ]);
      assert.deepEqual(result.skipped, []);
      assert.match(result.notes.join('\n'), /estimatedSavings defaults to 0/);

      const rows = listAllMicroSkills(db, REPO);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.skillKey, 'cmd-test');
      assert.equal(row.ruleText, 'Run tests with pnpm test.');
      assert.equal(row.tokenCount, 7);
      assert.equal(row.linkedPathsJson, '["src/a.ts","src/b.ts"]');
      assert.equal(row.sourceSessions, 1);
      assert.equal(row.estimatedSavings, 0);
      assert.equal(row.lastValidatedCommit, 'abc123');
      assert.equal(row.active, 1);
      assert.equal(row.updatedAt, NOW_ISO);
      assert.equal(typeof row.id, 'number');

      assert.deepEqual(
        result.skills.map((skill) => skill.skillKey),
        ['cmd-test'],
      );
      assert.deepEqual(activeKeys(db), ['cmd-test']);
    });
  });

  it('leaves last_validated_commit null when no head commit is supplied', () => {
    withDb((db) => {
      applyMutations(db, REPO, [{ op: 'add', skillKey: 'cmd-a', ruleText: 'A rule.' }], {
        config: makeConfig(),
        now: fixedNow,
      });
      assert.equal(listAllMicroSkills(db, REPO)[0]?.lastValidatedCommit, null);
      assert.equal(listAllMicroSkills(db, REPO)[0]?.linkedPathsJson, null);
    });
  });

  it('treats an add on an existing key as a tighten and never duplicates the row', () => {
    withDb((db) => {
      seedSkill(db, {
        skillKey: 'cmd-test',
        ruleText: 'Old rule.',
        tokenCount: 9,
        estimatedSavings: 500,
        sourceSessions: 4,
      });

      const result = applyMutations(db, REPO, [{ op: 'add', skillKey: 'cmd-test', ruleText: 'New rule.' }], {
        config: makeConfig(),
        now: fixedNow,
        estimateTokens: byLength,
      });

      assert.equal(result.applied.length, 1);
      assert.deepEqual(result.skipped, []);
      assert.match(result.notes.join('\n'), /applied as tighten/);

      const rows = listAllMicroSkills(db, REPO);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.ruleText, 'New rule.');
      assert.equal(rows[0]?.tokenCount, 9);
      // tighten keeps the learned value signals
      assert.equal(rows[0]?.estimatedSavings, 500);
      assert.equal(rows[0]?.sourceSessions, 4);
      assert.equal(rows[0]?.updatedAt, NOW_ISO);
    });
  });
});

describe('applyMutations: tighten', () => {
  it('rewrites the rule and token count while keeping the other fields', () => {
    withDb((db) => {
      seedSkill(db, {
        skillKey: 'nav-x',
        ruleText: 'Old.',
        tokenCount: 4,
        estimatedSavings: 77,
        sourceSessions: 3,
        linkedPathsJson: '["src/a.ts"]',
        lastValidatedCommit: 'base1',
        updatedAt: daysAgo(45),
      });

      const result = applyMutations(db, REPO, [{ op: 'tighten', skillKey: 'nav-x', ruleText: 'New rule text.' }], {
        config: makeConfig(),
        now: fixedNow,
        estimateTokens: byLength,
      });

      assert.equal(result.applied.length, 1);
      const rows = listAllMicroSkills(db, REPO);
      assert.equal(rows[0]?.ruleText, 'New rule text.');
      assert.equal(rows[0]?.tokenCount, 'New rule text.'.length);
      assert.equal(rows[0]?.estimatedSavings, 77);
      assert.equal(rows[0]?.sourceSessions, 3);
      assert.equal(rows[0]?.linkedPathsJson, '["src/a.ts"]');
      assert.equal(rows[0]?.lastValidatedCommit, 'base1');
      assert.equal(rows[0]?.updatedAt, NOW_ISO);
    });
  });

  it('skips an unknown key with a note', () => {
    withDb((db) => {
      const result = applyMutations(db, REPO, [{ op: 'tighten', skillKey: 'nope', ruleText: 'X.' }], {
        config: makeConfig(),
        now: fixedNow,
      });

      assert.deepEqual(result.applied, []);
      assert.equal(result.skipped.length, 1);
      assert.match(result.notes[0] ?? '', /tighten nope: unknown skill key; skipped/);
      assert.deepEqual(result.skills, []);
    });
  });

  it('reactivates a retired skill when tightened', () => {
    withDb((db) => {
      seedSkill(db, { skillKey: 'cmd-retired', ruleText: 'Old.', active: 0 });
      const result = applyMutations(db, REPO, [{ op: 'tighten', skillKey: 'cmd-retired', ruleText: 'Live.' }], {
        config: makeConfig(),
        now: fixedNow,
        estimateTokens: byLength,
      });

      assert.equal(result.applied.length, 1);
      assert.match(result.notes.join('\n'), /reactivated/);
      assert.deepEqual(activeKeys(db), ['cmd-retired']);
    });
  });
});

describe('applyMutations: merge', () => {
  it('unions fields and deactivates the source', () => {
    withDb((db) => {
      seedSkill(db, {
        skillKey: 'nav-target',
        ruleText: 'Target rule.',
        tokenCount: 12,
        estimatedSavings: 100,
        sourceSessions: 2,
        linkedPathsJson: '["src/a.ts"]',
      });
      seedSkill(db, {
        skillKey: 'nav-source',
        ruleText: 'Source rule.',
        tokenCount: 12,
        estimatedSavings: 50,
        sourceSessions: 1,
        linkedPathsJson: '["src/b.ts","src/a.ts"]',
      });

      const result = applyMutations(
        db,
        REPO,
        [{ op: 'merge', skillKey: 'nav-source', mergeIntoKey: 'nav-target' }],
        { config: makeConfig(), now: fixedNow, estimateTokens: byLength },
      );

      assert.equal(result.applied.length, 1);
      assert.match(result.notes.join('\n'), /merge nav-source -> nav-target/);

      const all = new Map(listAllMicroSkills(db, REPO).map((skill) => [skill.skillKey, skill]));
      const target = all.get('nav-target')!;
      assert.equal(target.ruleText, 'Target rule.\nSource rule.');
      assert.equal(target.tokenCount, 'Target rule.\nSource rule.'.length);
      assert.equal(target.linkedPathsJson, '["src/a.ts","src/b.ts"]');
      assert.equal(target.estimatedSavings, 150);
      assert.equal(target.sourceSessions, 3);
      assert.equal(target.active, 1);
      assert.equal(target.updatedAt, NOW_ISO);
      assert.equal(all.get('nav-source')?.active, 0);
      assert.deepEqual(activeKeys(db), ['nav-target']);
    });
  });

  it('deduplicates identical rule lines', () => {
    withDb((db) => {
      seedSkill(db, { skillKey: 'cmd-target', ruleText: 'Same rule.' });
      seedSkill(db, { skillKey: 'cmd-source', ruleText: '  Same rule.  ' });

      applyMutations(db, REPO, [{ op: 'merge', skillKey: 'cmd-source', mergeIntoKey: 'cmd-target' }], {
        config: makeConfig(),
        now: fixedNow,
        estimateTokens: byLength,
      });

      const target = listAllMicroSkills(db, REPO).find((skill) => skill.skillKey === 'cmd-target');
      assert.equal(target?.ruleText, 'Same rule.');
      assert.equal(target?.tokenCount, 'Same rule.'.length);
    });
  });

  it('skips unknown sources and targets', () => {
    withDb((db) => {
      seedSkill(db, { skillKey: 'cmd-known', ruleText: 'Known.' });

      const result = applyMutations(
        db,
        REPO,
        [
          { op: 'merge', skillKey: 'missing-source', mergeIntoKey: 'cmd-known' },
          { op: 'merge', skillKey: 'cmd-known', mergeIntoKey: 'missing-target' },
          { op: 'merge', skillKey: 'cmd-known', mergeIntoKey: 'cmd-known' },
        ],
        { config: makeConfig(), now: fixedNow },
      );

      assert.deepEqual(result.applied, []);
      assert.equal(result.skipped.length, 3);
      assert.match(result.notes[0] ?? '', /unknown source skill key/);
      assert.match(result.notes[1] ?? '', /unknown merge target/);
      assert.match(result.notes[2] ?? '', /cannot merge a skill into itself/);
      assert.deepEqual(activeKeys(db), ['cmd-known']);
    });
  });
});

describe('applyMutations: retire and invalid input', () => {
  it('deactivates an active skill', () => {
    withDb((db) => {
      seedSkill(db, { skillKey: 'cmd-old', ruleText: 'Old.' });

      const result = applyMutations(db, REPO, [{ op: 'retire', skillKey: 'cmd-old' }], {
        config: makeConfig(),
        now: fixedNow,
      });

      assert.equal(result.applied.length, 1);
      assert.match(result.notes[0] ?? '', /retire cmd-old: deactivated/);
      assert.deepEqual(activeKeys(db), []);
    });
  });

  it('skips unknown and already-retired skills', () => {
    withDb((db) => {
      seedSkill(db, { skillKey: 'cmd-done', ruleText: 'Done.', active: 0 });

      const result = applyMutations(
        db,
        REPO,
        [
          { op: 'retire', skillKey: 'missing' },
          { op: 'retire', skillKey: 'cmd-done' },
        ],
        { config: makeConfig(), now: fixedNow },
      );

      assert.deepEqual(result.applied, []);
      assert.equal(result.skipped.length, 2);
      assert.match(result.notes[0] ?? '', /unknown skill key/);
      assert.match(result.notes[1] ?? '', /already inactive/);
    });
  });

  it('skips malformed mutations with reasons instead of throwing', () => {
    withDb((db) => {
      const result = applyMutations(
        db,
        REPO,
        [
          null as unknown as SkillMutation,
          { op: 'bogus', skillKey: 'ok-key', ruleText: 'X.' } as unknown as SkillMutation,
          { op: 'add', skillKey: 'Bad Key', ruleText: 'X.' },
          { op: 'add', skillKey: 'ok-key' },
        ],
        { config: makeConfig(), now: fixedNow },
      );

      assert.deepEqual(result.applied, []);
      assert.equal(result.skipped.length, 4);
      assert.match(result.notes[0] ?? '', /entry is not an object/);
      assert.match(result.notes[1] ?? '', /unknown op/);
      assert.match(result.notes[2] ?? '', /not a lowercase slug/);
      assert.match(result.notes[3] ?? '', /requires a non-empty ruleText/);
      assert.deepEqual(result.skills, []);
    });
  });
});

describe('applyMutations: token ceiling and ROI eviction (§6 safeguard 1)', () => {
  it('computes ROI as savings * decay / tokens with a 0.5 decay for unknown dates', () => {
    const aged = makeSkill({ skillKey: 'aged', estimatedSavings: 400, tokenCount: 100, updatedAt: daysAgo(120) });
    const undated = makeSkill({ skillKey: 'undated', estimatedSavings: 200, tokenCount: 100, updatedAt: null });
    const fresh = makeSkill({ skillKey: 'fresh', estimatedSavings: 150, tokenCount: 100, updatedAt: NOW_ISO });

    assert.ok(Math.abs(roiScore(aged, NOW) - 0.8) < 1e-9, `aged ROI ${roiScore(aged, NOW)}`);
    assert.equal(roiScore(undated, NOW), 1);
    assert.equal(roiScore(fresh, NOW), 1.5);
    // A future timestamp is clamped to age 0 rather than inflating ROI.
    assert.equal(roiScore({ ...fresh, updatedAt: daysAgo(-90) }, NOW), 1.5);
  });

  it('evicts an aged low-ROI skill (not a valuable one) when an add crosses the ceiling', () => {
    withDb((db) => {
      seedSkill(db, {
        skillKey: 'ancient-weak',
        ruleText: HUNDRED_CHAR_RULE,
        tokenCount: 100,
        estimatedSavings: 5,
        updatedAt: daysAgo(400),
      });
      seedSkill(db, {
        skillKey: 'ancient-strong',
        ruleText: HUNDRED_CHAR_RULE,
        tokenCount: 100,
        estimatedSavings: 2000,
        updatedAt: daysAgo(400),
      });

      const result = applyMutations(db, REPO, [{ op: 'add', skillKey: 'cmd-new', ruleText: HUNDRED_CHAR_RULE }], {
        config: makeConfig({ maxSkillFileTokens: 250 }),
        now: fixedNow,
        estimateTokens: byLength,
      });

      const evicted = evictionNotes(result.notes);
      assert.equal(evicted.length, 1);
      assert.match(evicted[0] ?? '', /^evicted ancient-weak /);
      assert.deepEqual(activeKeys(db), ['ancient-strong', 'cmd-new']);
    });
  });

  it('evicts the lowest-ROI candidate, not the oldest one', () => {
    withDb((db) => {
      seedSkill(db, {
        skillKey: 'old-valuable',
        ruleText: HUNDRED_CHAR_RULE,
        tokenCount: 100,
        estimatedSavings: 500,
        updatedAt: daysAgo(120),
      });
      seedSkill(db, {
        skillKey: 'young-cheap',
        ruleText: HUNDRED_CHAR_RULE,
        tokenCount: 100,
        estimatedSavings: 10,
        updatedAt: NOW_ISO,
      });

      const result = applyMutations(db, REPO, [{ op: 'add', skillKey: 'cmd-new', ruleText: HUNDRED_CHAR_RULE }], {
        config: makeConfig({ maxSkillFileTokens: 250 }),
        now: fixedNow,
        estimateTokens: byLength,
      });

      const evicted = evictionNotes(result.notes);
      assert.equal(evicted.length, 1);
      assert.match(evicted[0] ?? '', /^evicted young-cheap /);
      assert.deepEqual(activeKeys(db), ['old-valuable', 'cmd-new']);
      assert.equal(
        listAllMicroSkills(db, REPO).find((skill) => skill.skillKey === 'young-cheap')?.active,
        0,
      );
    });
  });

  it('evicts in ascending ROI order and uses the 0.5 decay for an unknown updatedAt', () => {
    withDb((db) => {
      seedSkill(db, {
        skillKey: 'aged',
        ruleText: HUNDRED_CHAR_RULE,
        tokenCount: 100,
        estimatedSavings: 400,
        updatedAt: daysAgo(120),
      });
      seedSkill(db, {
        skillKey: 'undated',
        ruleText: HUNDRED_CHAR_RULE,
        tokenCount: 100,
        estimatedSavings: 200,
        updatedAt: null,
      });
      seedSkill(db, {
        skillKey: 'fresh',
        ruleText: HUNDRED_CHAR_RULE,
        tokenCount: 100,
        estimatedSavings: 150,
        updatedAt: NOW_ISO,
      });

      // Tightening (not adding) is enough to re-run the ceiling check.
      const result = applyMutations(
        db,
        REPO,
        [{ op: 'tighten', skillKey: 'fresh', ruleText: HUNDRED_CHAR_RULE }],
        { config: makeConfig({ maxSkillFileTokens: 100 }), now: fixedNow, estimateTokens: byLength },
      );

      const evicted = evictionNotes(result.notes);
      assert.equal(evicted.length, 2);
      assert.match(evicted[0] ?? '', /^evicted aged /);
      assert.match(evicted[1] ?? '', /^evicted undated /);
      assert.deepEqual(activeKeys(db), ['fresh']);
      assert.deepEqual(
        result.skills.map((skill) => skill.skillKey),
        ['fresh'],
      );
    });
  });

  it('may evict the skill it just added when it is the only one left', () => {
    withDb((db) => {
      const result = applyMutations(db, REPO, [{ op: 'add', skillKey: 'cmd-huge', ruleText: HUNDRED_CHAR_RULE }], {
        config: makeConfig({ maxSkillFileTokens: 50 }),
        now: fixedNow,
        estimateTokens: byLength,
      });

      assert.equal(result.applied.length, 1);
      assert.match(evictionNotes(result.notes)[0] ?? '', /^evicted cmd-huge /);
      assert.deepEqual(result.skills, []);
      assert.deepEqual(activeKeys(db), []);
    });
  });

  it('keeps the active set under the ceiling across several adds and orders skills by id', () => {
    withDb((db) => {
      const result = applyMutations(
        db,
        REPO,
        [
          { op: 'add', skillKey: 'cmd-a', ruleText: HUNDRED_CHAR_RULE },
          { op: 'add', skillKey: 'nav-b', ruleText: HUNDRED_CHAR_RULE },
          { op: 'add', skillKey: 'cmd-c', ruleText: HUNDRED_CHAR_RULE },
        ],
        { config: makeConfig({ maxSkillFileTokens: 200 }), now: fixedNow, estimateTokens: byLength },
      );

      const ids = result.skills.map((skill) => skill.id ?? -1);
      assert.deepEqual(
        ids,
        [...ids].sort((left, right) => left - right),
      );
      const total = result.skills.reduce((sum, skill) => sum + skill.tokenCount, 0);
      assert.ok(total <= 200, `active tokens ${total}`);
      assert.equal(result.applied.length, 3);
    });
  });
});
