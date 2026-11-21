import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MicroSkillRecord } from '../adapters/types.js';
import type { RenderInput } from './render.js';
import {
  nextFileVersion,
  parseExistingVersion,
  renderMicroSkillsMarkdown,
  sectionTitleFor,
} from './render.js';

const REPO = '8f3a1c9d';

function makeSkill(overrides: Partial<MicroSkillRecord> & { skillKey: string; ruleText: string }): MicroSkillRecord {
  return {
    id: null,
    repoHash: REPO,
    tokenCount: 8,
    linkedPathsJson: null,
    sourceSessions: 1,
    estimatedSavings: 0,
    lastValidatedCommit: null,
    active: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    repoHash: REPO,
    version: 4,
    skills: [],
    budgetCap: 800,
    lastCommit: 'a91c4e2',
    sessionCount: 6,
    ...overrides,
  };
}

/** The three-skill artifact used by the full-file snapshot, §6 verbatim shape. */
const THREE_SKILL_INPUT: RenderInput = makeInput({
  skills: [
    makeSkill({
      id: 1,
      skillKey: 'cmd-pytest-flags',
      ruleText: 'Run unit tests with `pnpm test`; bare `vitest` hangs in watch mode.',
      tokenCount: 16,
    }),
    makeSkill({
      id: 2,
      skillKey: 'nav-api-schemas',
      ruleText: 'API route schemas live in `src/schemas`; ignore `src/models/legacy`.',
      tokenCount: 11,
    }),
    makeSkill({
      id: 3,
      skillKey: 'hygiene-lockfiles',
      ruleText: 'Never read `pnpm-lock.yaml`; check `src/db/schema.sql` instead.',
      tokenCount: 5,
    }),
  ],
});

describe('renderMicroSkillsMarkdown', () => {
  it('renders the complete §6 artifact byte for byte', () => {
    const expected =
      [
        '---',
        'repo_hash: 8f3a1c9d',
        'version: 4',
        'token_count: 32',
        'budget_cap: 800',
        'last_commit: a91c4e2',
        '---',
        '',
        '# LogLode Repo Micro-Skills (Auto-mined from 6 sessions)',
        '',
        '## Commands & Tooling',
        '- Run unit tests with `pnpm test`; bare `vitest` hangs in watch mode.',
        '',
        '## Codebase Navigation',
        '- API route schemas live in `src/schemas`; ignore `src/models/legacy`.',
        '',
        '## Context Hygiene',
        '- Never read `pnpm-lock.yaml`; check `src/db/schema.sql` instead.',
      ].join('\n') + '\n';

    assert.equal(renderMicroSkillsMarkdown(THREE_SKILL_INPUT), expected);
  });

  it('still emits frontmatter, heading, and a trailing newline with no skills', () => {
    const expected =
      [
        '---',
        'repo_hash: empty000',
        'version: 1',
        'token_count: 0',
        'budget_cap: 800',
        'last_commit:',
        '---',
        '',
        '# LogLode Repo Micro-Skills (Auto-mined from 0 sessions)',
      ].join('\n') + '\n';

    const markdown = renderMicroSkillsMarkdown(
      makeInput({ repoHash: 'empty000', version: 1, skills: [], lastCommit: null, sessionCount: 0 }),
    );

    assert.equal(markdown, expected);
    assert.ok(markdown.endsWith('\n'));
    assert.equal(markdown.endsWith('\n\n'), false);
  });

  it('sums token_count over the skills it is given', () => {
    const markdown = renderMicroSkillsMarkdown(
      makeInput({
        skills: [
          makeSkill({ skillKey: 'cmd-a', ruleText: 'One.', tokenCount: 10 }),
          makeSkill({ skillKey: 'nav-b', ruleText: 'Two.', tokenCount: 20 }),
          makeSkill({ skillKey: 'misc-c', ruleText: 'Three.', tokenCount: 30 }),
        ],
      }),
    );

    assert.match(markdown, /^token_count: 60$/m);
  });

  it('keeps the fixed section order regardless of input order', () => {
    const markdown = renderMicroSkillsMarkdown(
      makeInput({
        skills: [
          makeSkill({ skillKey: 'hygiene-first', ruleText: 'Hygiene rule.' }),
          makeSkill({ skillKey: 'nav-second', ruleText: 'Navigation rule.' }),
          makeSkill({ skillKey: 'cmd-third', ruleText: 'Command rule.' }),
        ],
      }),
    );

    const commands = markdown.indexOf('## Commands & Tooling');
    const navigation = markdown.indexOf('## Codebase Navigation');
    const hygiene = markdown.indexOf('## Context Hygiene');
    assert.ok(commands > 0 && navigation > commands && hygiene > navigation, markdown);
    assert.ok(markdown.indexOf('- Command rule.') < markdown.indexOf('- Navigation rule.'));
    assert.ok(markdown.indexOf('- Navigation rule.') < markdown.indexOf('- Hygiene rule.'));
  });

  it('omits empty sections and routes unknown prefixes to Context Hygiene', () => {
    const markdown = renderMicroSkillsMarkdown(
      makeInput({ skills: [makeSkill({ skillKey: 'misc-odd-note', ruleText: 'Odd rule.' })] }),
    );

    assert.equal(markdown.includes('## Commands & Tooling'), false);
    assert.equal(markdown.includes('## Codebase Navigation'), false);
    assert.ok(markdown.includes('## Context Hygiene'));
    assert.match(markdown, /^## Context Hygiene\n- Odd rule\.$/m);
  });

  it('renders a multi-line rule as exactly one bullet line', () => {
    const markdown = renderMicroSkillsMarkdown(
      makeInput({ skills: [makeSkill({ skillKey: 'cmd-multi', ruleText: 'First line.\n\nSecond line.  \nThird.' })] }),
    );

    assert.match(markdown, /^- First line\. Second line\. Third\.$/m);
    const bulletLines = markdown.split('\n').filter((line) => line.includes('First line'));
    assert.deepEqual(bulletLines, ['- First line. Second line. Third.']);
  });

  it('skips a blank rule but still counts its tokens', () => {
    const markdown = renderMicroSkillsMarkdown(
      makeInput({
        skills: [
          makeSkill({ skillKey: 'cmd-empty', ruleText: '   ', tokenCount: 4 }),
          makeSkill({ skillKey: 'cmd-real', ruleText: 'Real rule.', tokenCount: 6 }),
        ],
      }),
    );

    assert.equal(markdown.includes('-   '), false);
    assert.match(markdown, /^- Real rule\.$/m);
    assert.match(markdown, /^token_count: 10$/m);
  });

  it('renders a null last_commit as an empty value and never emits trailing whitespace', () => {
    const markdown = renderMicroSkillsMarkdown(
      makeInput({
        lastCommit: null,
        skills: [makeSkill({ skillKey: 'cmd-a', ruleText: 'Rule.' })],
      }),
    );

    assert.match(markdown, /^last_commit:$/m);
    assert.equal(markdown.includes('null'), false);
    for (const line of markdown.split('\n')) {
      assert.equal(line, line.trimEnd(), `trailing whitespace in ${JSON.stringify(line)}`);
    }
  });
});

describe('sectionTitleFor', () => {
  it('routes cmd-/nav- prefixes and defaults everything else to Context Hygiene', () => {
    assert.equal(sectionTitleFor('cmd-pytest-flags'), 'Commands & Tooling');
    assert.equal(sectionTitleFor('nav-api-schemas'), 'Codebase Navigation');
    assert.equal(sectionTitleFor('hygiene-lockfiles'), 'Context Hygiene');
    assert.equal(sectionTitleFor('test-runner-flags'), 'Context Hygiene');
  });
});

describe('file versions', () => {
  const rendered = renderMicroSkillsMarkdown(THREE_SKILL_INPUT);

  it('reads the version from rendered content and bumps it', () => {
    assert.equal(parseExistingVersion(rendered), 4);
    assert.equal(nextFileVersion(rendered), 5);
  });

  it('reads the version across CRLF line endings and a BOM', () => {
    const crlf = `\uFEFF${rendered.replace(/\n/g, '\r\n')}`;
    assert.equal(parseExistingVersion(crlf), 4);
    assert.equal(nextFileVersion(crlf), 5);
  });

  it('returns 0/1 for null, empty, and frontmatter-free content', () => {
    assert.equal(parseExistingVersion(null), 0);
    assert.equal(nextFileVersion(null), 1);
    assert.equal(parseExistingVersion(''), 0);
    assert.equal(nextFileVersion(''), 1);
    assert.equal(parseExistingVersion('# Heading\n\nversion: 9\n'), 0);
    assert.equal(nextFileVersion('# Heading\n\nversion: 9\n'), 1);
  });

  it('ignores an unparseable or absent version inside frontmatter', () => {
    assert.equal(parseExistingVersion('---\nrepo_hash: abc\n---\n'), 0);
    assert.equal(parseExistingVersion('---\nversion: latest\n---\n'), 0);
    assert.equal(parseExistingVersion('---\nversion: 3\nrepo_hash: abc\n---\n'), 3);
    assert.equal(nextFileVersion('---\nversion: 0\n---\n'), 1);
  });

  it('returns 0 when the frontmatter block is never closed', () => {
    assert.equal(parseExistingVersion('---\nversion: 7\n'), 0);
  });
});
