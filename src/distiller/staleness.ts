/**
 * Git-diff staleness check for injected micro-skills.
 *
 * Architecture: `docs/architecture.md` §6 safeguard 3 ("Git-Diff Staleness
 * Check") and §3 Stage 1 step 3. Before every session, every path listed in a
 * skill's `linked_paths_json` is verified against
 * `git diff --name-status <last_validated_commit>..HEAD`:
 *
 * - a linked path that was deleted (`D`) makes the skill an auto-retire
 *   candidate (`reason: 'deleted'`);
 * - a linked path that is the *old* side of a rename (`R`) is `'renamed'` —
 *   the rule now points at a path that no longer exists;
 * - a plain modification or addition (`M`, `A`, …) is `'changed'`, which only
 *   flags the skill for re-validation: the rule's claim may now be wrong.
 *
 * Deleted/renamed outranks changed when a skill links several affected paths.
 *
 * The checker is deliberately conservative about uncertainty: a missing base
 * commit or any git failure puts the skill in `unchecked`, never in `stale`, so
 * an injection bug or a broken checkout can never silently retire every skill.
 * Retiring is the caller's decision (`deactivateMicroSkill`).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MicroSkillRecord } from '../adapters/types.js';

const execFileAsync = promisify(execFile);

/** Injectable git runner: must resolve to trimmed stdout and reject on failure. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export interface StalenessOptions {
  repoRoot: string;
  skills: MicroSkillRecord[];
  /** The commit each skill was last validated against (skills' last_validated_commit, all the same base here). */
  baseCommit: string | null;
  /** HEAD to compare to; resolved by the caller. */
  headCommit?: string | null;
  /** Injectable git runner for tests: returns trimmed stdout. */
  runGit?: GitRunner;
}

export type StalenessReason = 'deleted' | 'renamed' | 'changed';

export interface StaleSkill {
  skill: MicroSkillRecord;
  reason: StalenessReason;
  changedPaths: string[];
}

export interface StalenessResult {
  stale: StaleSkill[];
  unchecked: MicroSkillRecord[];
}

/**
 * How strongly a diff status invalidates a skill. `deleted` and `renamed` mean
 * the linked path is gone (auto-retire); `changed` only means "re-validate".
 */
const STATUS_RANK: Record<StalenessReason, number> = { deleted: 3, renamed: 2, changed: 1 };

/**
 * Normalize a repo-relative path the way the rest of LogLode stores them:
 * forward slashes, no `./` prefix, no leading/trailing slash.
 *
 * Kept local (rather than importing `normalizeRepoPath` from `src/repo.ts`) so
 * the staleness checker stays a leaf module with no repository-identity
 * dependency; the rules implemented are a superset that also tolerates the
 * `./` spellings an LLM-authored `linkedPaths` entry can produce.
 */
export function normalizeLinkedPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/^\/+/, '');
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Decode a `linked_paths_json` column into normalized, de-duplicated paths.
 *
 * `null`, an empty array, invalid JSON, or a non-array JSON value all yield
 * `[]`: a skill whose links cannot be read keeps its place in the skill file
 * (it is simply not staleness-checked) instead of being treated as broken.
 * Non-string array members are dropped for the same reason.
 */
export function parseLinkedPaths(json: string | null): string[] {
  if (json === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const paths: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = normalizeLinkedPath(entry);
    if (normalized !== '' && !paths.includes(normalized)) {
      paths.push(normalized);
    }
  }
  return paths;
}

function statusFromLetter(letter: string): StalenessReason {
  switch (letter) {
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      // 'M' (modified), 'A' (added), 'C' (copied), 'T' (type change),
      // 'U' (unmerged) and anything newer git may invent are all "verify the
      // rule again" events rather than "the path is gone".
      return 'changed';
  }
}

/**
 * Parse `git diff --name-status` output into a map of normalized path ->
 * strongest status, e.g.
 *
 * ```
 * D       src/a.ts
 * R100    src/b.ts  src/c.ts
 * M       src/d.ts
 * ```
 *
 * For a rename the *old* side is `renamed` and the destination is `changed`
 * (content moved there). Copies keep their source untouched, so only the copy
 * destination is marked `changed`. Rows are tab-separated; a whitespace-split
 * fallback keeps hand-written fixtures usable.
 */
export function parseDiffNameStatus(output: string): Map<string, StalenessReason> {
  const statuses = new Map<string, StalenessReason>();

  const record = (path: string, status: StalenessReason): void => {
    const normalized = normalizeLinkedPath(path);
    if (normalized === '') {
      return;
    }
    const existing = statuses.get(normalized);
    if (existing === undefined || STATUS_RANK[status] > STATUS_RANK[existing]) {
      statuses.set(normalized, status);
    }
  };

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') {
      continue;
    }

    let fields = line.split('\t');
    if (fields.length < 2) {
      fields = line.trim().split(/\s+/);
      if (fields.length < 2) {
        continue;
      }
    }

    const letter = (fields[0] ?? '').trim().charAt(0).toUpperCase();
    if (letter === '') {
      continue;
    }
    const status = statusFromLetter(letter);

    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[1];
      const newPath = fields[2];
      if (letter === 'R' && oldPath !== undefined) {
        // The old side of a rename no longer exists at that path.
        record(oldPath, 'renamed');
      }
      // A copy leaves its source untouched, so only the destination is new.
      if (newPath !== undefined) {
        record(newPath, 'changed');
      }
      continue;
    }

    for (const path of fields.slice(1)) {
      record(path, status);
    }
  }

  return statuses;
}

/**
 * Default git runner: `execFile('git', args)` in `repoRoot`, trimmed stdout.
 *
 * The environment is scrubbed of the `GIT_DIR`-family variables so a caller's
 * shell (or a nested worktree) cannot redirect the diff to another repository,
 * and prompts/locks are disabled so the pre-flight check can never block.
 */
async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;

  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return String(stdout).trim();
}

/**
 * Check every ACTIVE skill against the base..HEAD diff.
 *
 * Semantics (see the module header):
 * - `baseCommit === null`, an empty base commit, or any git failure returns
 *   every active skill in `unchecked` — never in `stale`.
 * - Skills whose `linked_paths_json` cannot be read are checked nowhere: they
 *   are neither stale nor unchecked, so they stay injected.
 * - `changedPaths` lists every linked path the diff touched (so callers can
 *   see the full picture) while `reason` is the strongest status among them.
 * - Order follows the input `skills` array.
 */
export async function checkSkillStaleness(opts: StalenessOptions): Promise<StalenessResult> {
  const activeSkills = opts.skills.filter((skill) => skill.active === 1);
  if (activeSkills.length === 0) {
    return { stale: [], unchecked: [] };
  }

  const baseCommit = opts.baseCommit === null ? '' : opts.baseCommit.trim();
  if (baseCommit === '') {
    return { stale: [], unchecked: [...activeSkills] };
  }

  const rawHead = opts.headCommit === null || opts.headCommit === undefined ? 'HEAD' : opts.headCommit;
  const headCommit = rawHead.trim() === '' ? 'HEAD' : rawHead.trim();
  const runGit: GitRunner = opts.runGit ?? defaultRunGit;

  let diffOutput: string;
  try {
    diffOutput = await runGit(['diff', '--name-status', `${baseCommit}..${headCommit}`], opts.repoRoot);
  } catch {
    // An unknown commit, a shallow clone, a broken worktree, or git missing
    // entirely: flag for manual checking rather than retiring anything.
    return { stale: [], unchecked: [...activeSkills] };
  }

  // `String()` guards against a JavaScript injector resolving to a non-string.
  const statuses = parseDiffNameStatus(String(diffOutput));

  const stale: StaleSkill[] = [];
  for (const skill of activeSkills) {
    const linkedPaths = parseLinkedPaths(skill.linkedPathsJson);
    if (linkedPaths.length === 0) {
      continue;
    }

    const changedPaths: string[] = [];
    let reason: StalenessReason | null = null;
    for (const path of linkedPaths) {
      const status = statuses.get(path);
      if (status === undefined) {
        continue;
      }
      changedPaths.push(path);
      if (reason === null || STATUS_RANK[status] > STATUS_RANK[reason]) {
        reason = status;
      }
    }

    if (reason !== null) {
      stale.push({ skill, reason, changedPaths });
    }
  }

  return { stale, unchecked: [] };
}
