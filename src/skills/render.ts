/**
 * Renderer for `.loglode/micro-skills.md`.
 *
 * Architecture: `docs/architecture.md` §6 "Micro-Skill Artifact Format &
 * Anti-Bloat Controls". The file is the thing actually injected into the next
 * session (Stage 1 step 4), so its shape is part of the contract:
 *
 * ```
 * ---
 * repo_hash: 8f3a1c9d
 * version: 4
 * token_count: 142
 * budget_cap: 800
 * last_commit: a91c4e2
 * ---
 *
 * # LogLode Repo Micro-Skills (Auto-mined from 6 sessions)
 *
 * ## Commands & Tooling
 * - ...
 * ```
 *
 * Rules that matter for prompt-cache friendliness (a static prefix is only
 * cacheable while it is byte-identical) and for the anti-bloat cap:
 *
 * - the section order is fixed and empty sections are omitted;
 * - every skill is exactly one bullet line (embedded newlines collapse to a
 *   single space) so the byte count stays predictable;
 * - `token_count` is the sum of the rendered skills' token counts, i.e. what
 *   the ceiling in §6 safeguard 1 actually measures;
 * - the file always ends with a newline, and never carries trailing
 *   whitespace (`last_commit:` with a null commit is an empty YAML value).
 *
 * `parseExistingVersion` / `nextFileVersion` implement the version bump the
 * writer needs: version lives in the frontmatter and is the only mutable part
 * of the header that the eval harness compares.
 */

import type { MicroSkillRecord } from '../adapters/types.js';

/** Fixed section order and titles from §6, matched by skill-key prefix. */
export const SECTION_TITLES = ['Commands & Tooling', 'Codebase Navigation', 'Context Hygiene'] as const;
export type SectionTitle = (typeof SECTION_TITLES)[number];

/** Prefix -> section index; everything else falls into "Context Hygiene". */
const SECTION_PREFIXES: ReadonlyArray<{ prefix: string; section: number }> = [
  { prefix: 'cmd-', section: 0 },
  { prefix: 'nav-', section: 1 },
];

export interface RenderInput {
  repoHash: string;
  version: number;
  /** ACTIVE skills; ordered by a caller-defined priority (you render in the given order). */
  skills: MicroSkillRecord[];
  budgetCap: number;
  lastCommit: string | null;
  sessionCount: number;
}

/** Which §6 section a skill key belongs to (index into {@link SECTION_TITLES}). */
function sectionIndexFor(skillKey: string): number {
  for (const mapping of SECTION_PREFIXES) {
    if (skillKey.startsWith(mapping.prefix)) {
      return mapping.section;
    }
  }
  return 2;
}

/** Which §6 section a skill key belongs to. */
export function sectionTitleFor(skillKey: string): SectionTitle {
  return SECTION_TITLES[sectionIndexFor(skillKey)];
}

/** Collapse embedded newlines so a multi-line rule still renders as one bullet. */
function toSingleLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

function lastCommitLine(lastCommit: string | null): string {
  const value = lastCommit === null ? '' : lastCommit.trim();
  return value === '' ? 'last_commit:' : `last_commit: ${value}`;
}

/**
 * Render the complete micro-skills artifact.
 *
 * Skills with an empty rule are skipped as bullets (they would produce a bare
 * `- ` line) but still contribute to `token_count`, which mirrors what the
 * store believes the file costs.
 */
export function renderMicroSkillsMarkdown(input: RenderInput): string {
  const buckets: string[][] = SECTION_TITLES.map(() => []);
  for (const skill of input.skills) {
    const rule = toSingleLine(skill.ruleText);
    if (rule === '') {
      continue;
    }
    buckets[sectionIndexFor(skill.skillKey)].push(`- ${rule}`);
  }

  const tokenCount = input.skills.reduce(
    (sum, skill) => sum + (Number.isFinite(skill.tokenCount) ? skill.tokenCount : 0),
    0,
  );

  const lines: string[] = [
    '---',
    `repo_hash: ${input.repoHash}`,
    `version: ${input.version}`,
    `token_count: ${tokenCount}`,
    `budget_cap: ${input.budgetCap}`,
    lastCommitLine(input.lastCommit),
    '---',
    '',
    `# LogLode Repo Micro-Skills (Auto-mined from ${input.sessionCount} sessions)`,
  ];

  for (let index = 0; index < SECTION_TITLES.length; index += 1) {
    const bullets = buckets[index];
    if (bullets.length === 0) {
      continue;
    }
    lines.push('', `## ${SECTION_TITLES[index]}`, ...bullets);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Read `version:` from the frontmatter block; `0` when the block is missing or
 * unclosed, or when the field is absent or unparseable (a brand-new file, or a
 * hand-edited one).
 *
 * Only the leading `---` … `---` block is consulted: a `version:` line that
 * appears in the body is not the file version.
 */
export function parseExistingVersion(markdown: string | null): number {
  if (markdown === null) {
    return 0;
  }

  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') {
    index += 1;
  }
  if (index >= lines.length || lines[index].trim() !== '---') {
    return 0;
  }

  // The frontmatter must be closed; a stray `---` thematic break is not one.
  let closing = -1;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (lines[cursor].trim() === '---') {
      closing = cursor;
      break;
    }
  }
  if (closing === -1) {
    return 0;
  }

  for (index += 1; index < closing; index += 1) {
    const match = /^version:\s*(\d+)\s*$/.exec(lines[index].trim());
    if (match !== null) {
      const parsed = Number.parseInt(match[1] ?? '', 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
  }

  return 0;
}

/** Next file version to write: `parseExistingVersion + 1`, never below 1. */
export function nextFileVersion(markdown: string | null): number {
  return Math.max(1, parseExistingVersion(markdown) + 1);
}
