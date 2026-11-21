import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { MicroSkillRecord } from '../adapters/types.js';
import { initTempGitRepo } from '../testing/tmp.js';
import {
  checkSkillStaleness,
  normalizeLinkedPath,
  parseDiffNameStatus,
  parseLinkedPaths,
} from './staleness.js';

const execFileAsync = promisify(execFile);

/** Minimal git runner for the fixtures: same env hygiene as `src/testing/tmp.ts`. */
async function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;

  const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  return String(stdout).trim();
}

const COMMIT_FLAGS = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath='];

async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ['add', '-A']);
  await git(repo, [...COMMIT_FLAGS, 'commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function makeSkill(overrides: Partial<MicroSkillRecord> & { skillKey: string }): MicroSkillRecord {
  return {
    id: null,
    repoHash: 'testrepo',
    ruleText: 'Do the thing.',
    tokenCount: 5,
    linkedPathsJson: null,
    sourceSessions: 1,
    estimatedSavings: 0,
    lastValidatedCommit: null,
    active: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function byKey<T extends { skill: MicroSkillRecord }>(entries: T[]): Map<string, T> {
  return new Map(entries.map((entry) => [entry.skill.skillKey, entry]));
}

/**
 * Build the fixture used by the real-git tests:
 *
 * - base commit: `src/a.ts`, `src/b.ts`, `src/d.ts`;
 * - second commit: `src/a.ts` deleted, `src/b.ts` -> `src/c.ts` renamed,
 *   `src/d.ts` modified.
 */
async function buildDiffFixture(): Promise<{ repo: string; baseCommit: string; headCommit: string }> {
  const repo = await initTempGitRepo();
  await fs.mkdir(join(repo, 'src'), { recursive: true });
  await fs.writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await fs.writeFile(join(repo, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');
  await fs.writeFile(join(repo, 'src', 'd.ts'), 'export const d = 4;\n', 'utf8');
  const baseCommit = await commitAll(repo, 'base');

  await git(repo, ['rm', '--quiet', 'src/a.ts']);
  await git(repo, ['mv', 'src/b.ts', 'src/c.ts']);
  await fs.appendFile(join(repo, 'src', 'd.ts'), 'export const d2 = 42;\n', 'utf8');
  const headCommit = await commitAll(repo, 'second');

  return { repo, baseCommit, headCommit };
}

describe('checkSkillStaleness against a real git repo', () => {
  it('classifies deleted, renamed, and modified linked paths', async () => {
    const { repo, baseCommit } = await buildDiffFixture();
    try {
      const skills = [
        makeSkill({ skillKey: 'cmd-deleted', linkedPathsJson: '["src/a.ts"]' }),
        makeSkill({ skillKey: 'nav-renamed', linkedPathsJson: '["src/b.ts"]' }),
        makeSkill({ skillKey: 'hygienic-changed', linkedPathsJson: '["src/d.ts"]' }),
        makeSkill({ skillKey: 'untouched-path', linkedPathsJson: '["src/zzz.ts"]' }),
        makeSkill({ skillKey: 'unparseable', linkedPathsJson: '{not json' }),
        makeSkill({ skillKey: 'null-paths', linkedPathsJson: null }),
        makeSkill({ skillKey: 'empty-paths', linkedPathsJson: '[]' }),
        makeSkill({ skillKey: 'inactive-deleted', linkedPathsJson: '["src/a.ts"]', active: 0 }),
      ];

      const result = await checkSkillStaleness({ repoRoot: repo, skills, baseCommit });
      const stale = byKey(result.stale);

      assert.deepEqual([...stale.keys()].sort(), ['cmd-deleted', 'hygienic-changed', 'nav-renamed']);
      assert.equal(stale.get('cmd-deleted')?.reason, 'deleted');
      assert.deepEqual(stale.get('cmd-deleted')?.changedPaths, ['src/a.ts']);
      assert.equal(stale.get('nav-renamed')?.reason, 'renamed');
      assert.deepEqual(stale.get('nav-renamed')?.changedPaths, ['src/b.ts']);
      assert.equal(stale.get('hygienic-changed')?.reason, 'changed');
      assert.deepEqual(stale.get('hygienic-changed')?.changedPaths, ['src/d.ts']);

      // Unreadable / empty / untouched link lists and inactive skills are not stale.
      for (const key of ['untouched-path', 'unparseable', 'null-paths', 'empty-paths', 'inactive-deleted']) {
        assert.equal(stale.has(key), false, `${key} must not be stale`);
      }
      assert.deepEqual(result.unchecked, []);
    } finally {
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
  });

  it('reports the strongest reason and every affected path when a skill links several paths', async () => {
    const { repo, baseCommit } = await buildDiffFixture();
    try {
      // Links both a deleted and a modified path: deleted outranks changed.
      const result = await checkSkillStaleness({
        repoRoot: repo,
        baseCommit,
        skills: [makeSkill({ skillKey: 'mixed', linkedPathsJson: '["src/d.ts","./src/a.ts"]' })],
      });

      assert.equal(result.stale.length, 1);
      assert.equal(result.stale[0]?.reason, 'deleted');
      assert.deepEqual(result.stale[0]?.changedPaths, ['src/d.ts', 'src/a.ts']);
    } finally {
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
  });

  it('reports an empty diff when headCommit equals baseCommit', async () => {
    const { repo, baseCommit } = await buildDiffFixture();
    try {
      const result = await checkSkillStaleness({
        repoRoot: repo,
        baseCommit,
        headCommit: baseCommit,
        skills: [makeSkill({ skillKey: 'cmd-deleted', linkedPathsJson: '["src/a.ts"]' })],
      });
      assert.deepEqual(result.stale, []);
      assert.deepEqual(result.unchecked, []);
    } finally {
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
  });

  it('puts every active skill in unchecked when baseCommit is null', async () => {
    const skills = [
      makeSkill({ skillKey: 'one', linkedPathsJson: '["src/a.ts"]' }),
      makeSkill({ skillKey: 'two', linkedPathsJson: '{broken' }),
      makeSkill({ skillKey: 'inactive', linkedPathsJson: '["src/a.ts"]', active: 0 }),
    ];

    const result = await checkSkillStaleness({ repoRoot: '.', skills, baseCommit: null });

    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.unchecked.map((skill) => skill.skillKey), ['one', 'two']);
  });

  it('puts every active skill in unchecked when git fails (unknown base commit)', async () => {
    const { repo } = await buildDiffFixture();
    try {
      const result = await checkSkillStaleness({
        repoRoot: repo,
        baseCommit: '0000000000000000000000000000000000000000',
        skills: [
          makeSkill({ skillKey: 'one', linkedPathsJson: '["src/a.ts"]' }),
          makeSkill({ skillKey: 'two', linkedPathsJson: '["src/b.ts"]' }),
        ],
      });
      assert.deepEqual(result.stale, []);
      assert.deepEqual(result.unchecked.map((skill) => skill.skillKey), ['one', 'two']);
    } finally {
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
  });

  it('never throws when the injected git runner rejects', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const result = await checkSkillStaleness({
      repoRoot: 'C:/does/not/matter',
      baseCommit: 'abc123',
      skills: [makeSkill({ skillKey: 'cmd-x', linkedPathsJson: '["src/a.ts"]' })],
      runGit: async (args, cwd) => {
        calls.push({ args, cwd });
        throw new Error('git exploded');
      },
    });

    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.unchecked.map((skill) => skill.skillKey), ['cmd-x']);
    assert.deepEqual(calls, [{ args: ['diff', '--name-status', 'abc123..HEAD'], cwd: 'C:/does/not/matter' }]);
  });

  it('parses an injected --name-status payload and routes added paths to changed', async () => {
    const calls: string[][] = [];
    const result = await checkSkillStaleness({
      repoRoot: '/repo',
      baseCommit: 'base123',
      headCommit: 'main',
      skills: [
        makeSkill({ skillKey: 'deleted', linkedPathsJson: '["src/a.ts"]' }),
        makeSkill({ skillKey: 'renamed', linkedPathsJson: '["src/b.ts"]' }),
        makeSkill({ skillKey: 'modified', linkedPathsJson: '["src/d.ts"]' }),
        makeSkill({ skillKey: 'added', linkedPathsJson: '["src/new.ts"]' }),
        makeSkill({ skillKey: 'moved-to', linkedPathsJson: '["src/c.ts"]' }),
      ],
      runGit: async (args) => {
        calls.push(args);
        return ['D\tsrc/a.ts', 'R087\tsrc/b.ts\tsrc/c.ts', 'M\tsrc/d.ts', 'A\tsrc/new.ts'].join('\r\n');
      },
    });

    assert.deepEqual(calls, [['diff', '--name-status', 'base123..main']]);
    const stale = byKey(result.stale);
    assert.equal(stale.get('deleted')?.reason, 'deleted');
    assert.equal(stale.get('renamed')?.reason, 'renamed');
    assert.equal(stale.get('modified')?.reason, 'changed');
    assert.equal(stale.get('added')?.reason, 'changed');
    // Destination side of a rename is "changed" (content moved there), not renamed.
    assert.equal(stale.get('moved-to')?.reason, 'changed');
    assert.deepEqual(result.unchecked, []);
  });
});

describe('parseDiffNameStatus', () => {
  it('maps status letters to staleness reasons', () => {
    const statuses = parseDiffNameStatus(
      ['D\tsrc/gone.ts', 'R100\tsrc/old.ts\tsrc/new.ts', 'M\tsrc/edited.ts', 'A\tsrc/added.ts', 'T\tsrc/type.ts'].join('\n'),
    );

    assert.equal(statuses.get('src/gone.ts'), 'deleted');
    assert.equal(statuses.get('src/old.ts'), 'renamed');
    assert.equal(statuses.get('src/new.ts'), 'changed');
    assert.equal(statuses.get('src/edited.ts'), 'changed');
    assert.equal(statuses.get('src/added.ts'), 'changed');
    assert.equal(statuses.get('src/type.ts'), 'changed');
  });

  it('normalizes paths, tolerates CRLF and blank lines, and keeps the strongest status', () => {
    const statuses = parseDiffNameStatus(['', 'M\t./src/a.ts\r', 'D\tsrc/a.ts\r', ''].join('\n'));

    assert.equal(statuses.size, 1);
    assert.equal(statuses.get('src/a.ts'), 'deleted');
  });

  it('falls back to whitespace separation and ignores unparseable rows', () => {
    const statuses = parseDiffNameStatus(['D src/a.ts', 'garbage'].join('\n'));

    assert.equal(statuses.get('src/a.ts'), 'deleted');
    assert.equal(statuses.size, 1);
  });

  it('marks a copy destination as changed and leaves the source alone', () => {
    const statuses = parseDiffNameStatus('C100\tsrc/b.ts\tsrc/b-copy.ts');

    assert.equal(statuses.has('src/b.ts'), false);
    assert.equal(statuses.get('src/b-copy.ts'), 'changed');
  });
});

describe('link path helpers', () => {
  it('normalizes backslashes, ./, and trailing slashes', () => {
    assert.equal(normalizeLinkedPath('src\\auth\\guard.ts'), 'src/auth/guard.ts');
    assert.equal(normalizeLinkedPath('./src/a.ts'), 'src/a.ts');
    assert.equal(normalizeLinkedPath('/src/a/'), 'src/a');
    assert.equal(normalizeLinkedPath('   '), '');
  });

  it('returns no paths for null, invalid JSON, or non-array payloads', () => {
    assert.deepEqual(parseLinkedPaths(null), []);
    assert.deepEqual(parseLinkedPaths(''), []);
    assert.deepEqual(parseLinkedPaths('{oops'), []);
    assert.deepEqual(parseLinkedPaths('{"a":1}'), []);
    assert.deepEqual(parseLinkedPaths('"src/a.ts"'), []);
  });

  it('normalizes, de-duplicates, and keeps only string entries', () => {
    assert.deepEqual(
      parseLinkedPaths(JSON.stringify(['src\\a.ts', './src/a.ts', '/src/b.ts', 42, null, ''])),
      ['src/a.ts', 'src/b.ts'],
    );
  });
});
