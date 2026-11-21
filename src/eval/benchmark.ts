/**
 * Evaluation harness (architecture §9): git-worktree A/B benchmark.
 *
 * The benchmark compares a control arm (`loglode run --no-inject`, labelled
 * `baseline`) against a treatment arm (mining + injection enabled, labelled
 * `assisted`) over the same chronological task suite. Both arms run inside their
 * own git worktree pinned to the same base commit `C0`, because the treatment
 * arm's skills evolve from the baseline trajectories and because a task that
 * edits the repository must not contaminate the other arm.
 *
 * Metrics (§9):
 * - total tokens `T_total = input + cache_read + cache_write + output`.
 * - `ΔT% = (T_baseline - T_assisted) / T_baseline * 100`.
 * - `T_eff = effectiveTokens(usage)` (cost-weighted tokens, `src/cost.ts`).
 * - `ΔT_eff%` is the same formula over `T_eff`.
 * - `Pass@1` parity: both arms' test command succeeded, or both failed.
 * - `comparable`: a non-warm-up task whose Pass@1 parity holds and whose two arms
 *   both reported usage telemetry. Summary means aggregate only these tasks.
 *
 * Everything that would execute an agent is injected through `runTask`; this
 * module never spawns `loglode`, Claude, or Codex itself, so it is testable with
 * fakes and reusable by the CLI (`loglode eval --suite <tasks.yaml> --base-commit
 * <sha>`, architecture §8).
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { TokenUsage } from '../adapters/types.js';
import { effectiveTokens } from '../cost.js';

const execFileAsync = promisify(execFile);

type Arm = 'baseline' | 'assisted';

/** One benchmark task: a stable name plus the prompt handed to the agent. */
export interface EvalTask {
  name: string;
  prompt: string;
}

/**
 * What one arm did on one task. Every telemetry field is optional because the
 * wrapped CLI may fail to report it; `null` and `undefined` both mean "unknown".
 */
export interface TaskRunOutcome {
  /** null/undefined when telemetry unavailable. */
  usage?: TokenUsage | null;
  costUsd?: number | null;
  /** Pass@1 for the task's test command; null = unknown. */
  passed?: boolean | null;
  durationMs?: number | null;
  error?: string;
}

export type RunTaskFn = (arm: 'baseline' | 'assisted', task: EvalTask, worktreeDir: string) => Promise<TaskRunOutcome>;

export interface BenchmarkOptions {
  repoRoot: string;
  baseCommit: string;
  tasks: EvalTask[];
  runTask: RunTaskFn;
  /** How many leading tasks are warm-up and excluded from the comparison (§9: Task 1 runs cold). Default 1. */
  warmupTasks?: number;
  /** Injectable git runner for tests: (args, cwd) => trimmed stdout. Default: execFile git. */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  /** Injectable worktree base directory (tests pass a temp dir). Default: os.tmpdir(). */
  worktreeBase?: string;
}

export interface TaskComparison {
  task: EvalTask;
  index: number; // 1-based position in the suite
  warmup: boolean;
  baseline?: TaskRunOutcome;
  assisted?: TaskRunOutcome;
  baselineTotalTokens: number | null;
  assistedTotalTokens: number | null;
  baselineEffTokens: number | null;
  assistedEffTokens: number | null;
  deltaTokensPct: number | null; // (base - assisted)/base * 100; null when base telemetry missing
  deltaEffTokensPct: number | null;
  passAt1Parity: boolean | null; // null when either side's `passed` is unknown
  comparable: boolean; // warmup excluded AND parity holds AND both arms have usage telemetry
}

export interface BenchmarkReport {
  repoRoot: string;
  baseCommit: string;
  comparisons: TaskComparison[];
  summary: {
    comparableTasks: number;
    meanDeltaTokensPct: number | null; // mean over comparable tasks; null when none
    meanDeltaEffTokensPct: number | null;
    passAt1ParityRate: number | null; // parity true / tasks where parity known
    baselineUsd: number | null; // summed over ALL non-warmup tasks with telemetry
    assistedUsd: number | null;
  };
}

const ARMS: readonly Arm[] = ['baseline', 'assisted'];

/** Prefix of the temporary worktree directories, e.g. `loglode-eval-baseline-1a2b3c4d`. */
const WORKTREE_PREFIX = 'loglode-eval';

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

/**
 * Default git runner. Mirrors `src/testing/tmp.ts`: a caller's repository
 * environment (an outer `GIT_DIR`, for example) must never leak into the
 * benchmark's own worktree commands.
 */
async function execGit(args: string[], cwd: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;

  const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  return String(stdout).trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Run a cleanup step, swallowing any failure: cleanup must never mask the report. */
async function bestEffort(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // Intentionally ignored: worktree cleanup is best-effort (Windows may hold handles).
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the §9 A/B benchmark and return the per-task comparisons plus the summary.
 *
 * The control arm always runs to completion before the treatment arm starts, so
 * the treatment arm's evolving `.loglode/micro-skills.md` reflects the baseline
 * trajectories and so the run order is deterministic. A task that throws becomes
 * `{ error }` for that task and the suite continues; the worktrees are removed in
 * a `finally` block no matter what happens.
 *
 * An empty suite returns an empty report without touching git.
 */
export async function runBenchmark(opts: BenchmarkOptions): Promise<BenchmarkReport> {
  if (opts.tasks.length === 0) {
    return { repoRoot: opts.repoRoot, baseCommit: opts.baseCommit, comparisons: [], summary: emptySummary() };
  }

  const warmupTasks = normalizeWarmupTasks(opts.warmupTasks);
  const runGit = opts.runGit ?? execGit;
  const worktreeBase = opts.worktreeBase ?? tmpdir();
  const runId = randomBytes(4).toString('hex');

  const worktreeDirs: Record<Arm, string> = {
    baseline: join(worktreeBase, `${WORKTREE_PREFIX}-baseline-${runId}`),
    assisted: join(worktreeBase, `${WORKTREE_PREFIX}-assisted-${runId}`),
  };

  /** Keyed `${arm}:${0-based task index}`. */
  const outcomes = new Map<string, TaskRunOutcome>();
  const createdDirs: string[] = [];

  try {
    // Both arms start from the same pinned commit C0 (§9 protocol steps 2-3).
    for (const arm of ARMS) {
      createdDirs.push(worktreeDirs[arm]);
      try {
        await runGit(['worktree', 'add', worktreeDirs[arm], opts.baseCommit], opts.repoRoot);
      } catch (error) {
        throw new Error(
          `Failed to create the ${arm} git worktree at '${worktreeDirs[arm]}' from base commit '${opts.baseCommit}': ${errorMessage(error)}`,
        );
      }
    }

    // Control arm first, then treatment arm — never interleaved.
    for (const arm of ARMS) {
      for (const [taskIndex, task] of opts.tasks.entries()) {
        outcomes.set(outcomeKey(arm, taskIndex), await runTaskOnce(opts.runTask, arm, task, worktreeDirs[arm]));
      }
    }
  } finally {
    for (const dir of [...createdDirs].reverse()) {
      await bestEffort(() => runGit(['worktree', 'remove', '--force', dir], opts.repoRoot));
      await bestEffort(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
    }
  }

  const comparisons = opts.tasks.map((task, taskIndex) =>
    compareTask({
      task,
      index: taskIndex + 1,
      warmup: taskIndex + 1 <= warmupTasks,
      baseline: outcomes.get(outcomeKey('baseline', taskIndex)) ?? {},
      assisted: outcomes.get(outcomeKey('assisted', taskIndex)) ?? {},
    }),
  );

  return {
    repoRoot: opts.repoRoot,
    baseCommit: opts.baseCommit,
    comparisons,
    summary: summarize(comparisons),
  };
}

function outcomeKey(arm: Arm, taskIndex: number): string {
  return `${arm}:${taskIndex}`;
}

/**
 * Clamp the warm-up count: a missing value means one cold task (§9 task 1),
 * fractional values are floored, and nonsense values degrade to zero.
 */
function normalizeWarmupTasks(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Run one task, converting a thrown runner into an `error` outcome. The benchmark
 * always continues: one broken task must not discard the rest of the suite.
 */
async function runTaskOnce(runTask: RunTaskFn, arm: Arm, task: EvalTask, worktreeDir: string): Promise<TaskRunOutcome> {
  try {
    const outcome: TaskRunOutcome | null | undefined = await runTask(arm, task, worktreeDir);
    return outcome === null || outcome === undefined ? {} : outcome;
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** `T_total = input + cache_read + cache_write + output`; null without telemetry. */
function totalTokensOf(outcome: TaskRunOutcome): number | null {
  const usage = outcome.usage;
  if (usage === null || usage === undefined) {
    return null;
  }
  const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
  return Number.isFinite(total) ? total : null;
}

/** `T_eff` from `src/cost.ts`; null without telemetry. */
function effectiveTokensOf(outcome: TaskRunOutcome): number | null {
  const usage = outcome.usage;
  if (usage === null || usage === undefined) {
    return null;
  }
  const value = effectiveTokens(usage);
  return Number.isFinite(value) ? value : null;
}

/**
 * `Δ% = (baseline - assisted) / baseline * 100`. Never divides by zero: a missing
 * or zero baseline yields `null`, so a report can never contain `Infinity`/`NaN`.
 */
function deltaPercentOf(baseline: number | null, assisted: number | null): number | null {
  if (baseline === null || assisted === null || baseline === 0) {
    return null;
  }
  const delta = ((baseline - assisted) / baseline) * 100;
  return Number.isFinite(delta) ? delta : null;
}

/** Both sides known and identical; `null` when either Pass@1 is unknown. */
function passAt1ParityOf(baseline: TaskRunOutcome, assisted: TaskRunOutcome): boolean | null {
  const baselinePassed = baseline.passed;
  const assistedPassed = assisted.passed;
  if (typeof baselinePassed !== 'boolean' || typeof assistedPassed !== 'boolean') {
    return null;
  }
  return baselinePassed === assistedPassed;
}

interface ComparisonInput {
  task: EvalTask;
  index: number;
  warmup: boolean;
  baseline: TaskRunOutcome;
  assisted: TaskRunOutcome;
}

function compareTask(input: ComparisonInput): TaskComparison {
  const { task, index, warmup, baseline, assisted } = input;
  const baselineTotalTokens = totalTokensOf(baseline);
  const assistedTotalTokens = totalTokensOf(assisted);
  const baselineEffTokens = effectiveTokensOf(baseline);
  const assistedEffTokens = effectiveTokensOf(assisted);
  const passAt1Parity = passAt1ParityOf(baseline, assisted);

  return {
    task,
    index,
    warmup,
    baseline,
    assisted,
    baselineTotalTokens,
    assistedTotalTokens,
    baselineEffTokens,
    assistedEffTokens,
    deltaTokensPct: deltaPercentOf(baselineTotalTokens, assistedTotalTokens),
    deltaEffTokensPct: deltaPercentOf(baselineEffTokens, assistedEffTokens),
    passAt1Parity,
    comparable:
      !warmup && passAt1Parity === true && baselineTotalTokens !== null && assistedTotalTokens !== null,
  };
}

/**
 * Aggregate the summary. Means run over comparable tasks only (§9 protocol step
 * 4: report ΔT% and ΔT_eff% "only where Pass@1 parity holds"), skipping a
 * comparable task whose delta is null (zero baseline telemetry). The parity rate
 * uses every non-warm-up task with a known parity. USD sums include every
 * non-warm-up task that reported a numeric `costUsd`, even when usage telemetry
 * was missing, because spend is still real; they are null when nothing reported.
 */
function summarize(comparisons: TaskComparison[]): BenchmarkReport['summary'] {
  const nonWarmup = comparisons.filter((comparison) => !comparison.warmup);
  const comparable = nonWarmup.filter((comparison) => comparison.comparable);

  const meanOf = (values: Array<number | null>): number | null => {
    const present = values.filter((value): value is number => value !== null);
    if (present.length === 0) {
      return null;
    }
    let sum = 0;
    for (const value of present) {
      sum += value;
    }
    const mean = sum / present.length;
    return Number.isFinite(mean) ? mean : null;
  };

  const parityKnown = nonWarmup.filter((comparison) => comparison.passAt1Parity !== null);
  const parityTrue = parityKnown.filter((comparison) => comparison.passAt1Parity === true);

  const summedUsd = (arm: Arm): number | null => {
    let total = 0;
    let seen = false;
    for (const comparison of nonWarmup) {
      const cost = comparison[arm]?.costUsd;
      if (isFiniteNumber(cost)) {
        total += cost;
        seen = true;
      }
    }
    return seen ? total : null;
  };

  return {
    comparableTasks: comparable.length,
    meanDeltaTokensPct: meanOf(comparable.map((comparison) => comparison.deltaTokensPct)),
    meanDeltaEffTokensPct: meanOf(comparable.map((comparison) => comparison.deltaEffTokensPct)),
    passAt1ParityRate: parityKnown.length === 0 ? null : parityTrue.length / parityKnown.length,
    baselineUsd: summedUsd('baseline'),
    assistedUsd: summedUsd('assisted'),
  };
}

function emptySummary(): BenchmarkReport['summary'] {
  return {
    comparableTasks: 0,
    meanDeltaTokensPct: null,
    meanDeltaEffTokensPct: null,
    passAt1ParityRate: null,
    baselineUsd: null,
    assistedUsd: null,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the report as Markdown: a title, a metadata block, the per-task table,
 * and a summary whose means are explicitly marked as comparable-tasks-only.
 *
 * Cell conventions: `-` for unknown values, signed percentages with two
 * decimals, `Pass@1` as `baseline/assisted` where `P` = passed, `F` = failed,
 * `-` = unknown. Rendered deterministically (no locale-dependent formatting) so
 * it can be committed or diffed.
 */
export function renderMarkdownReport(report: BenchmarkReport): string {
  const { comparisons, summary } = report;
  const totalTasks = comparisons.length;
  const warmupCount = comparisons.filter((comparison) => comparison.warmup).length;
  const nonWarmupCount = totalTasks - warmupCount;
  const parityKnown = comparisons.filter((comparison) => !comparison.warmup && comparison.passAt1Parity !== null).length;
  const parityTrue = comparisons.filter((comparison) => !comparison.warmup && comparison.passAt1Parity === true).length;

  const lines: string[] = [
    '# LogLode Eval Report',
    '',
    `- Repo root: ${report.repoRoot}`,
    `- Base commit: ${report.baseCommit}`,
    `- Tasks: ${totalTasks} total (${warmupCount} warm-up, ${nonWarmupCount} non-warm-up)`,
    `- Comparable tasks (used for the means): ${summary.comparableTasks}`,
    '',
    '| Task | Warmup | Baseline T | Assisted T | ΔT% | ΔT_eff% | Pass@1 | Parity | Comparable |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const comparison of comparisons) {
    const cells = [
      escapeTableCell(comparison.task.name),
      yesNoCell(comparison.warmup),
      numberCell(comparison.baselineTotalTokens),
      numberCell(comparison.assistedTotalTokens),
      formatSignedPercent(comparison.deltaTokensPct),
      formatSignedPercent(comparison.deltaEffTokensPct),
      `${passCell(comparison.baseline)}/${passCell(comparison.assisted)}`,
      parityCell(comparison.passAt1Parity),
      yesNoCell(comparison.comparable),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }

  lines.push(
    '',
    '## Summary',
    '',
    `- Comparable tasks: ${summary.comparableTasks}`,
    `- Mean ΔT%: ${formatSignedPercent(summary.meanDeltaTokensPct)}`,
    `- Mean ΔT_eff%: ${formatSignedPercent(summary.meanDeltaEffTokensPct)}`,
    `- Pass@1 parity rate: ${formatRate(summary.passAt1ParityRate)} (${parityTrue}/${parityKnown} non-warm-up tasks with known parity)`,
    `- Baseline USD (non-warm-up tasks reporting cost): ${formatUsd(summary.baselineUsd)}`,
    `- Assisted USD (non-warm-up tasks reporting cost): ${formatUsd(summary.assistedUsd)}`,
    '',
    '> Means cover comparable tasks only: non-warm-up tasks where Pass@1 parity holds and both arms reported usage telemetry. Tasks outside that set are listed above but do not move the means.',
    '> Pass@1 is shown as baseline/assisted (`P` = passed, `F` = failed, `-` = unknown). Warm-up tasks never contribute to any summary aggregate.',
    '> USD totals include every non-warm-up task that reported a numeric cost, even ones excluded from the means.',
  );

  return `${lines.join('\n')}\n`;
}

/**
 * Render the report as CSV (CRLF line endings, per RFC 4180) for spreadsheets and
 * downstream scripts. Null values become empty fields.
 */
export function renderCsvReport(report: BenchmarkReport): string {
  const header = [
    'task',
    'index',
    'warmup',
    'baseline_tokens',
    'assisted_tokens',
    'delta_tokens_pct',
    'baseline_eff_tokens',
    'assisted_eff_tokens',
    'delta_eff_pct',
    'pass_baseline',
    'pass_assisted',
    'parity',
    'comparable',
  ].join(',');

  const lines = [header];
  for (const comparison of report.comparisons) {
    const fields = [
      csvField(comparison.task.name),
      String(comparison.index),
      String(comparison.warmup),
      csvNumber(comparison.baselineTotalTokens),
      csvNumber(comparison.assistedTotalTokens),
      csvPercent(comparison.deltaTokensPct),
      csvNumber(comparison.baselineEffTokens),
      csvNumber(comparison.assistedEffTokens),
      csvPercent(comparison.deltaEffTokensPct),
      csvBool(comparison.baseline?.passed),
      csvBool(comparison.assisted?.passed),
      csvBool(comparison.passAt1Parity),
      String(comparison.comparable),
    ];
    lines.push(fields.join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}

function numberCell(value: number | null): string {
  return value === null ? '-' : String(value);
}

function yesNoCell(value: boolean): string {
  return value ? 'yes' : 'no';
}

function parityCell(value: boolean | null): string {
  return value === null ? '-' : yesNoCell(value);
}

function passCell(outcome: TaskRunOutcome | undefined): string {
  if (outcome?.passed === true) {
    return 'P';
  }
  if (outcome?.passed === false) {
    return 'F';
  }
  return '-';
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Signed with two decimals, e.g. `+12.34%`; `-` for null. */
function formatSignedPercent(value: number | null): string {
  if (value === null) {
    return '-';
  }
  const sign = value < 0 ? '-' : '+';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

/** Unsigned two-decimal ratio, e.g. `100.00%`; `-` for null. */
function formatRate(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(2)}%`;
}

/** Four-decimal USD, e.g. `0.1875`; `-` for null. */
function formatUsd(value: number | null): string {
  return value === null ? '-' : value.toFixed(4);
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

function csvPercent(value: number | null): string {
  return value === null ? '' : value.toFixed(2);
}

function csvBool(value: boolean | null | undefined): string {
  if (value === true) {
    return 'true';
  }
  if (value === false) {
    return 'false';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Task suite parsing
// ---------------------------------------------------------------------------

const ITEM_LINE = /^- (.*)$/;
const KEY_LINE = /^(name|prompt):(?:\s+(.*))?$/;
const BLOCK_HEADER = /^([|>])([+-]?)$/;
const BLOCK_START = /^[|>]/;

interface ParsedKey {
  key: 'name' | 'prompt';
  /** Plain scalar value; null when the key opens a block scalar. */
  value: string | null;
  block: boolean;
}

/**
 * Parse the deterministic task-suite subset used by `loglode eval --suite`.
 *
 * This is intentionally **not** a general YAML parser. It accepts exactly a flat
 * list of `{name, prompt}` mappings:
 *
 * ```yaml
 * # comments and blank lines are ignored
 * - name: fix-login-bug
 *   prompt: |
 *     Fix the login bug in auth.ts.
 *
 * - name: add-tests
 *   prompt: Add a regression test.
 * ```
 *
 * Supported: top-level `- ` items; `name` and `prompt` in either order; plain
 * scalars (optionally quoted); `|` and `>` block scalars with the block dedented
 * by its minimum indentation (folded `>` is treated exactly like `|` — no line
 * folding, matching how multi-line task prompts are written); trailing comments
 * introduced by `#` at line start or after whitespace outside quotes.
 * Block-scalar content is taken verbatim, so `#` lines inside a block are content.
 *
 * Anything else (nested lists, extra keys, anchors, tags, multi-document input,
 * tab indentation, ...) throws a descriptive `Error` naming the offending line.
 */
export function parseTasksYaml(source: string): EvalTask[] {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lines = withoutBom.split(/\r?\n/);
  const tasks: EvalTask[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const itemLineText = lines[cursor];
    if (isSkippableLine(itemLineText)) {
      cursor++;
      continue;
    }
    assertNoTabIndentation(itemLineText, cursor + 1);

    const itemMatch = ITEM_LINE.exec(itemLineText);
    if (itemMatch === null) {
      if (/^[ \t]/.test(itemLineText)) {
        throw new Error(
          `Line ${cursor + 1}: expected a top-level list item starting with '- ' at column 1, found indented content '${preview(itemLineText)}'.`,
        );
      }
      throw new Error(
        `Line ${cursor + 1}: expected a top-level list item starting with '- ', found '${preview(itemLineText)}'. This is not a general YAML parser; it only supports a flat list of {name, prompt} items.`,
      );
    }

    const itemStartLine = cursor + 1;
    let name: string | null = null;
    let prompt: string | null = null;
    let pending: { text: string; indent: number; lineNumber: number } | null =
      itemMatch[1].trim() === '' ? null : { text: itemMatch[1], indent: 2, lineNumber: itemStartLine };
    cursor++;

    while (pending !== null || cursor < lines.length) {
      if (pending === null) {
        const nextLine = lines[cursor];
        if (isSkippableLine(nextLine)) {
          cursor++;
          continue;
        }
        if (ITEM_LINE.test(nextLine)) {
          break;
        }
        if (/^[ \t]+- /.test(nextLine)) {
          throw new Error(
            `Line ${cursor + 1}: nested list items are not supported; each item must be a flat {name, prompt} mapping.`,
          );
        }
        if (!/^[ \t]/.test(nextLine)) {
          throw new Error(
            `Line ${cursor + 1}: unexpected content '${preview(nextLine)}'; indent 'name:'/'prompt:' lines under its '- ' item, or start the next item with '- '.`,
          );
        }
        assertNoTabIndentation(nextLine, cursor + 1);
        pending = { text: nextLine, indent: countLeadingSpaces(nextLine), lineNumber: cursor + 1 };
        cursor++;
      }

      const entry = pending;
      pending = null;
      const parsed = parseKeyLine(entry.text, entry.lineNumber);

      if (parsed.key === 'name') {
        if (name !== null) {
          throw new Error(`Line ${entry.lineNumber}: duplicate 'name' key for the item that starts at line ${itemStartLine}.`);
        }
        name = parsed.value ?? '';
        continue;
      }

      if (prompt !== null) {
        throw new Error(`Line ${entry.lineNumber}: duplicate 'prompt' key for the item that starts at line ${itemStartLine}.`);
      }
      if (parsed.block) {
        const block = readBlockScalar(lines, cursor, entry.indent, entry.lineNumber);
        prompt = block.value;
        cursor = block.next;
        continue;
      }
      prompt = parsed.value ?? '';
    }

    if (name === null) {
      throw new Error(`Line ${itemStartLine}: list item is missing the required 'name' key.`);
    }
    if (prompt === null) {
      throw new Error(`Line ${itemStartLine}: list item is missing the required 'prompt' key.`);
    }
    if (prompt.trim() === '') {
      throw new Error(`Line ${itemStartLine}: 'prompt' is empty.`);
    }
    tasks.push({ name, prompt });
  }

  return tasks;
}

function parseKeyLine(rawText: string, lineNumber: number): ParsedKey {
  const text = stripComment(rawText).trim();
  const match = KEY_LINE.exec(text);
  if (match === null) {
    const looksLikeKey = /^([A-Za-z0-9_.-]+):/.exec(text);
    if (looksLikeKey !== null) {
      throw new Error(`Line ${lineNumber}: unsupported key '${looksLikeKey[1]}'; only 'name' and 'prompt' are supported.`);
    }
    throw new Error(`Line ${lineNumber}: expected a 'name:' or 'prompt:' line, found '${preview(text)}'.`);
  }

  const key: 'name' | 'prompt' = match[1] === 'name' ? 'name' : 'prompt';
  const rawValue = (match[2] ?? '').trim();
  if (rawValue === '') {
    if (key === 'name') {
      throw new Error(`Line ${lineNumber}: 'name' must be a non-empty plain scalar.`);
    }
    throw new Error(`Line ${lineNumber}: 'prompt' must be a non-empty plain scalar, a '|' block, or a '>' block.`);
  }

  if (key === 'name') {
    if (BLOCK_START.test(rawValue)) {
      throw new Error(`Line ${lineNumber}: 'name' must be a single-line plain scalar; block scalars are only supported for 'prompt'.`);
    }
    return { key, value: parsePlainScalar(rawValue, lineNumber, 'name'), block: false };
  }

  if (BLOCK_HEADER.test(rawValue)) {
    return { key, value: null, block: true };
  }
  if (BLOCK_START.test(rawValue)) {
    throw new Error(`Line ${lineNumber}: unsupported block scalar header '${preview(rawValue)}'; use '|' or '>'.`);
  }
  return { key, value: parsePlainScalar(rawValue, lineNumber, 'prompt'), block: false };
}

function parsePlainScalar(rawValue: string, lineNumber: number, key: 'name' | 'prompt'): string {
  const first = rawValue.charAt(0);
  if (first === '"' || first === "'") {
    if (rawValue.length < 2 || rawValue.charAt(rawValue.length - 1) !== first) {
      throw new Error(`Line ${lineNumber}: unterminated quoted scalar for '${key}'.`);
    }
    const inner = rawValue.slice(1, -1);
    return first === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'");
  }
  return rawValue;
}

interface BlockScalar {
  value: string;
  next: number;
}

/**
 * Collect a `|`/`>` block starting at `start`: every following blank line and
 * every line indented deeper than the owning key, dedented by the minimum indent
 * of its non-blank lines. Trailing blank lines are dropped so prompts do not end
 * with a stray newline.
 */
function readBlockScalar(lines: string[], start: number, keyIndent: number, lineNumber: number): BlockScalar {
  const collected: string[] = [];
  let cursor = start;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim() === '') {
      collected.push('');
      cursor++;
      continue;
    }
    if (countLeadingSpaces(line) <= keyIndent) {
      break;
    }
    collected.push(line);
    cursor++;
  }

  while (collected.length > 0 && collected[collected.length - 1].trim() === '') {
    collected.pop();
  }

  const nonBlank = collected.filter((line) => line.trim() !== '');
  if (nonBlank.length === 0) {
    throw new Error(`Line ${lineNumber}: 'prompt' block scalar has no content.`);
  }

  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of nonBlank) {
    minIndent = Math.min(minIndent, countLeadingSpaces(line));
  }

  const value = collected.map((line) => (line.trim() === '' ? '' : line.slice(minIndent))).join('\n');
  return { value, next: cursor };
}

function isSkippableLine(line: string): boolean {
  return stripComment(line).trim() === '';
}

/**
 * Remove a trailing `#` comment. A `#` only starts a comment at line start or
 * after whitespace, and never inside single or double quotes.
 */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    if (inDouble) {
      if (char === '\\') {
        index++;
        continue;
      }
      if (char === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (char === "'") {
        if (line.charAt(index + 1) === "'") {
          index++;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line.charAt(index - 1)))) {
      return line.slice(0, index);
    }
  }

  return line;
}

function assertNoTabIndentation(line: string, lineNumber: number): void {
  if (/^ *\t/.test(line)) {
    throw new Error(`Line ${lineNumber}: tab indentation is not supported; indent YAML lines with spaces.`);
  }
}

function countLeadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line.charAt(count) === ' ') {
    count++;
  }
  return count;
}

function preview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 60 ? `${compact.slice(0, 57)}...` : compact;
}
