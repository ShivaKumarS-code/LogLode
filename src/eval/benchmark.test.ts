import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import type { TokenUsage } from '../adapters/types.js';
import { initTempGitRepo, withTempDir } from '../testing/tmp.js';
import {
  parseTasksYaml,
  renderCsvReport,
  renderMarkdownReport,
  runBenchmark,
  type BenchmarkOptions,
  type BenchmarkReport,
  type EvalTask,
  type TaskRunOutcome,
} from './benchmark.js';

const execFileAsync = promisify(execFile);

/** Deterministic stand-ins for the report metadata: nothing here touches the disk. */
const REPO_ROOT = 'C:/fixtures/repo';
const BASE_COMMIT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

const GIT_COMMIT_OVERRIDES = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath='];

/** Test-local git helper (mirrors `src/testing/tmp.ts`, which keeps its runner private). */
async function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;

  const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  return String(stdout);
}

function usage(inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number): TokenUsage {
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens };
}

interface GitCall {
  args: string[];
  cwd: string;
}

function recordingGit(calls: GitCall[]): (args: string[], cwd: string) => Promise<string> {
  return async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    return '';
  };
}

interface FakeBenchmarkInput {
  tasks: EvalTask[];
  warmupTasks?: number;
  runTask: BenchmarkOptions['runTask'];
  runGit?: BenchmarkOptions['runGit'];
  repoRoot?: string;
  baseCommit?: string;
}

/** Run the benchmark against a fake git runner inside a throwaway worktree base. */
async function runFakeBenchmark(input: FakeBenchmarkInput): Promise<BenchmarkReport> {
  return withTempDir(async (worktreeBase) =>
    runBenchmark({
      repoRoot: input.repoRoot ?? REPO_ROOT,
      baseCommit: input.baseCommit ?? BASE_COMMIT,
      worktreeBase,
      tasks: input.tasks,
      warmupTasks: input.warmupTasks,
      runGit: input.runGit ?? recordingGit([]),
      runTask: input.runTask,
    }),
  );
}

/** Fail loudly if any number anywhere in the report is NaN/Infinity. */
function assertAllNumbersFinite(value: unknown, path = 'report'): void {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} should be finite, got ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAllNumbersFinite(item, `${path}[${String(index)}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assertAllNumbersFinite(child, `${path}.${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUITE_3: EvalTask[] = [
  { name: 'warmup-task', prompt: 'Warm up the caches.' },
  { name: 'fix-login-bug', prompt: 'Fix the login bug in auth.ts.' },
  { name: 'add-tests', prompt: 'Add unit tests for auth.ts.' },
];

/**
 * Hand-picked so every delta is an exact integer (or exactly 50%):
 * - warm-up: totals 2300 -> 1150 (50%), T_eff 2620 -> 1310 (50%);
 * - task 2:  totals 4000 -> 3000 (25%), T_eff 5000 -> 4000 (20%);
 * - task 3:  totals 5000 -> 4000 (20%), T_eff 6000 -> 4800 (20%).
 * Costs are binary-exact fractions so the USD sums compare exactly.
 */
const OUTCOMES_3: Record<'baseline' | 'assisted', TaskRunOutcome[]> = {
  baseline: [
    { usage: usage(1600, 200, 400, 100), costUsd: 1, passed: true },
    { usage: usage(3750, 0, 0, 250), costUsd: 0.25, passed: true },
    { usage: usage(4000, 0, 800, 200), costUsd: 0.125, passed: true },
  ],
  assisted: [
    { usage: usage(800, 100, 200, 50), costUsd: 0.75, passed: true },
    { usage: usage(2750, 0, 0, 250), costUsd: 0.125, passed: true },
    { usage: usage(3800, 0, 0, 200), costUsd: 0.0625, passed: true },
  ],
};

function outcomeLookup(outcomes: Record<'baseline' | 'assisted', TaskRunOutcome[]>): BenchmarkOptions['runTask'] {
  const nextIndex = { baseline: 0, assisted: 0 };
  return async (arm) => {
    const index = nextIndex[arm];
    nextIndex[arm] = index + 1;
    return outcomes[arm][index];
  };
}

// ---------------------------------------------------------------------------
// runBenchmark — arms, worktrees, cleanup
// ---------------------------------------------------------------------------

describe('runBenchmark arms and worktrees', () => {
  it('creates a worktree per arm, runs the control arm first, and removes both afterwards', async () => {
    const gitCalls: GitCall[] = [];
    const runCalls: Array<{ arm: 'baseline' | 'assisted'; taskName: string; worktreeDir: string }> = [];
    const events: string[] = [];

    await withTempDir(async (worktreeBase) => {
      const report = await runBenchmark({
        repoRoot: REPO_ROOT,
        baseCommit: BASE_COMMIT,
        tasks: SUITE_3,
        worktreeBase,
        warmupTasks: 0,
        runGit: async (args, cwd) => {
          gitCalls.push({ args: [...args], cwd });
          events.push(`git:${args.slice(0, 2).join(' ')}`);
          return '';
        },
        runTask: async (arm, task, worktreeDir) => {
          runCalls.push({ arm, taskName: task.name, worktreeDir });
          events.push(`run:${arm}:${task.name}`);
          return { usage: usage(1000, 0, 0, 0), passed: true };
        },
      });

      assert.equal(report.comparisons.length, 3);

      // Two worktrees, both pinned to the same base commit.
      const adds = gitCalls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
      assert.equal(adds.length, 2);
      for (const add of adds) {
        assert.equal(add.cwd, REPO_ROOT);
        assert.equal(add.args[3], BASE_COMMIT);
        assert.ok(add.args[2].startsWith(join(worktreeBase, 'loglode-eval-')));
      }
      const addDirs = adds.map((add) => add.args[2]);
      assert.equal(new Set(addDirs).size, 2, 'the two arms must get distinct worktree directories');
      assert.ok(addDirs.some((dir) => dir.startsWith(join(worktreeBase, 'loglode-eval-baseline-'))));
      assert.ok(addDirs.some((dir) => dir.startsWith(join(worktreeBase, 'loglode-eval-assisted-'))));

      // Baseline runs to completion first, inside one worktree; assisted second, in the other.
      assert.deepEqual(
        runCalls.map((call) => `${call.arm}:${call.taskName}`),
        [
          'baseline:warmup-task',
          'baseline:fix-login-bug',
          'baseline:add-tests',
          'assisted:warmup-task',
          'assisted:fix-login-bug',
          'assisted:add-tests',
        ],
      );
      const baselineDir = runCalls[0].worktreeDir;
      const assistedDir = runCalls[3].worktreeDir;
      assert.notEqual(baselineDir, assistedDir);
      for (const call of runCalls.slice(0, 3)) {
        assert.equal(call.worktreeDir, baselineDir);
      }
      for (const call of runCalls.slice(3)) {
        assert.equal(call.worktreeDir, assistedDir);
      }
      assert.ok(baselineDir.startsWith(join(worktreeBase, 'loglode-eval-baseline-')));
      assert.ok(assistedDir.startsWith(join(worktreeBase, 'loglode-eval-assisted-')));

      // Worktree lifecycle: add, add, all the runs, remove, remove.
      assert.deepEqual(
        events.filter((event) => event.startsWith('git:')),
        ['git:worktree add', 'git:worktree add', 'git:worktree remove', 'git:worktree remove'],
      );
      const removes = gitCalls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'remove');
      assert.equal(removes.length, 2);
      assert.deepEqual(
        removes.map((remove) => remove.args[3]).sort(),
        [...addDirs].sort(),
        'both worktrees must be removed by directory',
      );
      for (const remove of removes) {
        assert.equal(remove.args[2], '--force');
        assert.equal(remove.cwd, REPO_ROOT);
      }
    });
  });

  it('materializes both worktrees at the pinned base commit in a real repository', async () => {
    await withTempDir(async (worktreeBase) => {
      const repo = await initTempGitRepo();
      try {
        const baseCommit = (await git(repo, ['rev-parse', 'HEAD'])).trim();
        await fs.writeFile(join(repo, 'second.txt'), 'second commit\n', 'utf8');
        await git(repo, ['add', 'second.txt']);
        await git(repo, [...GIT_COMMIT_OVERRIDES, 'commit', '-m', 'second']);
        const tipCommit = (await git(repo, ['rev-parse', 'HEAD'])).trim();
        assert.notEqual(tipCommit, baseCommit);

        const gitCalls: GitCall[] = [];
        const seenDirs: string[] = [];
        const tasks: EvalTask[] = [
          { name: 'first-task', prompt: 'Do the first task.' },
          { name: 'second-task', prompt: 'Do the second task.' },
        ];

        const report = await runBenchmark({
          repoRoot: repo,
          baseCommit,
          tasks,
          warmupTasks: 0,
          worktreeBase,
          runGit: async (args, cwd) => {
            gitCalls.push({ args: [...args], cwd });
            return (await git(cwd, args)).trim();
          },
          runTask: async (arm, task, worktreeDir) => {
            seenDirs.push(worktreeDir);
            assert.ok(existsSync(worktreeDir), `worktree ${worktreeDir} should exist while ${arm} runs '${task.name}'`);
            assert.ok(existsSync(join(worktreeDir, '.git')), 'a git worktree carries a .git file');
            assert.equal(
              existsSync(join(worktreeDir, 'second.txt')),
              false,
              'the worktree must be reset to baseCommit, not the branch tip',
            );
            assert.equal((await git(worktreeDir, ['rev-parse', 'HEAD'])).trim(), baseCommit);
            return { usage: usage(1000, 0, 0, 0), passed: true };
          },
        });

        assert.equal(report.comparisons.length, 2);
        assert.ok(report.comparisons.every((comparison) => comparison.comparable));

        const adds = gitCalls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
        assert.equal(adds.length, 2);
        for (const add of adds) {
          assert.equal(add.cwd, repo);
          assert.equal(add.args[3], baseCommit);
        }
        const worktreeDirs = [...new Set(adds.map((add) => add.args[2]))];
        assert.equal(worktreeDirs.length, 2);
        assert.ok(worktreeDirs.some((dir) => dir.includes('loglode-eval-baseline-')));
        assert.ok(worktreeDirs.some((dir) => dir.includes('loglode-eval-assisted-')));

        assert.equal(seenDirs[0], seenDirs[1]);
        assert.equal(seenDirs[2], seenDirs[3]);
        assert.notEqual(seenDirs[0], seenDirs[2]);

        const removes = gitCalls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'remove');
        assert.equal(removes.length, 2);
        assert.deepEqual(removes.map((remove) => remove.args[3]).sort(), [...worktreeDirs].sort());
        for (const dir of worktreeDirs) {
          assert.equal(existsSync(dir), false, `worktree directory ${dir} should be deleted`);
        }
        const remaining = (await git(repo, ['worktree', 'list', '--porcelain']))
          .split(/\r?\n/)
          .filter((line) => line.startsWith('worktree '));
        assert.equal(remaining.length, 1, 'only the main worktree may remain registered');
      } finally {
        await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  });

  it('records a thrown task, keeps running the suite, and still cleans up both worktrees', async () => {
    const gitCalls: GitCall[] = [];
    const tasks: EvalTask[] = [
      { name: 'first', prompt: 'First.' },
      { name: 'second', prompt: 'Second.' },
      { name: 'third', prompt: 'Third.' },
    ];

    const report = await runFakeBenchmark({
      tasks,
      warmupTasks: 0,
      runGit: recordingGit(gitCalls),
      runTask: async (arm, task) => {
        if (arm === 'baseline' && task.name === 'first') {
          throw new Error('baseline blew up');
        }
        if (arm === 'assisted' && task.name === 'second') {
          throw new Error('assisted blew up');
        }
        return { usage: usage(1000, 0, 0, 0), passed: true, costUsd: 0.5 };
      },
    });

    assert.equal(report.comparisons.length, 3);

    // The thrown baseline task is recorded, not fatal.
    assert.equal(report.comparisons[0].baseline?.error, 'baseline blew up');
    assert.equal(report.comparisons[0].baselineTotalTokens, null);
    assert.equal(report.comparisons[0].assistedTotalTokens, 1000, 'the assisted arm still ran the first task');

    // The thrown assisted task is recorded too.
    assert.equal(report.comparisons[1].assisted?.error, 'assisted blew up');
    assert.equal(report.comparisons[1].assistedTotalTokens, null);
    assert.equal(report.comparisons[1].passAt1Parity, null);
    assert.equal(report.comparisons[1].comparable, false);

    // Remaining tasks ran in both arms.
    assert.equal(report.comparisons[2].baselineTotalTokens, 1000);
    assert.equal(report.comparisons[2].assistedTotalTokens, 1000);
    assert.equal(report.comparisons[2].comparable, true);

    // The summary covers only the surviving comparable task.
    assert.equal(report.summary.comparableTasks, 1);
    assert.equal(report.summary.meanDeltaTokensPct, 0);

    const removes = gitCalls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'remove');
    assert.equal(removes.length, 2, 'cleanup must run even though tasks threw');
  });

  it('resolves and removes both worktrees when every task throws', async () => {
    const gitCalls: GitCall[] = [];
    const tasks: EvalTask[] = [
      { name: 'a', prompt: 'A.' },
      { name: 'b', prompt: 'B.' },
    ];

    const report = await runFakeBenchmark({
      tasks,
      warmupTasks: 0,
      runGit: recordingGit(gitCalls),
      runTask: async () => {
        throw new Error('always fails');
      },
    });

    assert.equal(report.comparisons.length, 2);
    for (const comparison of report.comparisons) {
      assert.equal(comparison.baseline?.error, 'always fails');
      assert.equal(comparison.assisted?.error, 'always fails');
      assert.equal(comparison.comparable, false);
    }
    assert.equal(report.summary.comparableTasks, 0);
    assert.equal(report.summary.meanDeltaTokensPct, null);

    const removes = gitCalls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'remove');
    assert.equal(removes.length, 2);
  });

  it('returns an empty report without touching git for an empty suite', async () => {
    const gitCalls: GitCall[] = [];
    const report = await runFakeBenchmark({
      tasks: [],
      runGit: recordingGit(gitCalls),
      runTask: async () => {
        throw new Error('must not run');
      },
    });

    assert.equal(gitCalls.length, 0);
    assert.deepEqual(report.comparisons, []);
    assert.deepEqual(report.summary, {
      comparableTasks: 0,
      meanDeltaTokensPct: null,
      meanDeltaEffTokensPct: null,
      passAt1ParityRate: null,
      baselineUsd: null,
      assistedUsd: null,
    });
  });
});

// ---------------------------------------------------------------------------
// runBenchmark — metrics
// ---------------------------------------------------------------------------

describe('runBenchmark metrics', () => {
  it('computes exact token and T_eff deltas and aggregates over comparable tasks only', async () => {
    const report = await runFakeBenchmark({
      tasks: SUITE_3,
      warmupTasks: 1,
      runTask: outcomeLookup(OUTCOMES_3),
    });

    const [warmup, second, third] = report.comparisons;

    // Warm-up: Task 1 runs cold and is excluded from the comparison (§9).
    assert.equal(warmup.index, 1);
    assert.equal(warmup.warmup, true);
    assert.equal(warmup.comparable, false);
    assert.equal(warmup.baselineTotalTokens, 2300);
    assert.equal(warmup.assistedTotalTokens, 1150);
    assert.equal(warmup.baselineEffTokens, 2620);
    assert.equal(warmup.assistedEffTokens, 1310);
    assert.equal(warmup.deltaTokensPct, 50);
    assert.equal(warmup.deltaEffTokensPct, 50);
    assert.equal(warmup.passAt1Parity, true);

    // Task 2: raw tokens fall 25%, cost-weighted tokens fall 20%.
    assert.equal(second.index, 2);
    assert.equal(second.warmup, false);
    assert.equal(second.comparable, true);
    assert.equal(second.baselineTotalTokens, 4000);
    assert.equal(second.assistedTotalTokens, 3000);
    assert.equal(second.baselineEffTokens, 5000);
    assert.equal(second.assistedEffTokens, 4000);
    assert.equal(second.deltaTokensPct, 25);
    assert.equal(second.deltaEffTokensPct, 20);

    // Task 3 includes cache writes in the baseline total (4000 + 0 + 800 + 200 = 5000).
    assert.equal(third.index, 3);
    assert.equal(third.baselineTotalTokens, 5000);
    assert.equal(third.assistedTotalTokens, 4000);
    assert.equal(third.baselineEffTokens, 6000);
    assert.equal(third.assistedEffTokens, 4800);
    assert.equal(third.deltaTokensPct, 20);
    assert.equal(third.deltaEffTokensPct, 20);
    assert.equal(third.comparable, true);

    // Means are over Tasks 2-3 only: (25 + 20) / 2 and (20 + 20) / 2.
    assert.deepEqual(report.summary, {
      comparableTasks: 2,
      meanDeltaTokensPct: 22.5,
      meanDeltaEffTokensPct: 20,
      passAt1ParityRate: 1,
      baselineUsd: 0.375,
      assistedUsd: 0.1875,
    });

    assertAllNumbersFinite(report);
  });

  it('marks a failed assisted run as parity false, excludes it from the means, but still lists its deltas', async () => {
    const tasks: EvalTask[] = [
      { name: 'keeps-parity', prompt: 'Keeps parity.' },
      { name: 'assisted-fails', prompt: 'Assisted arm fails.' },
    ];
    const outcomes: Record<'baseline' | 'assisted', TaskRunOutcome[]> = {
      baseline: [
        { usage: usage(1000, 0, 0, 0), costUsd: 0.5, passed: true },
        { usage: usage(2000, 0, 0, 0), costUsd: 1, passed: true },
      ],
      assisted: [
        { usage: usage(500, 0, 0, 0), costUsd: 0.25, passed: true },
        { usage: usage(1500, 0, 0, 0), costUsd: 0.5, passed: false },
      ],
    };

    const report = await runFakeBenchmark({ tasks, warmupTasks: 0, runTask: outcomeLookup(outcomes) });

    assert.equal(report.comparisons[0].passAt1Parity, true);
    assert.equal(report.comparisons[0].comparable, true);
    assert.equal(report.comparisons[0].deltaTokensPct, 50);

    const failed = report.comparisons[1];
    assert.equal(failed.passAt1Parity, false);
    assert.equal(failed.comparable, false);
    assert.equal(failed.baseline?.passed, true);
    assert.equal(failed.assisted?.passed, false);
    assert.equal(failed.deltaTokensPct, 25, 'deltas are still reported for a parity-breaking task');
    assert.equal(failed.deltaEffTokensPct, 25);

    assert.deepEqual(report.summary, {
      comparableTasks: 1,
      meanDeltaTokensPct: 50,
      meanDeltaEffTokensPct: 50,
      passAt1ParityRate: 0.5,
      baselineUsd: 1.5,
      assistedUsd: 0.75,
    });
  });

  it('returns null parity when either run outcome is unknown', async () => {
    const tasks: EvalTask[] = [{ name: 'unknown-pass', prompt: 'Pass state unknown.' }];
    const report = await runFakeBenchmark({
      tasks,
      warmupTasks: 0,
      runTask: async (arm) => ({
        usage: arm === 'baseline' ? usage(1000, 0, 0, 0) : usage(500, 0, 0, 0),
        passed: arm === 'baseline' ? true : null,
      }),
    });

    const comparison = report.comparisons[0];
    assert.equal(comparison.passAt1Parity, null);
    assert.equal(comparison.comparable, false);
    assert.equal(comparison.deltaTokensPct, 50);
    assert.equal(report.summary.passAt1ParityRate, null);
    assert.equal(report.summary.meanDeltaTokensPct, null);

    const markdown = renderMarkdownReport(report);
    assert.ok(markdown.includes('| unknown-pass | no | 1000 | 500 | +50.00% | +50.00% | P/- | - | no |'));
    assert.ok(markdown.includes('- Pass@1 parity rate: - (0/0 non-warm-up tasks with known parity)'));
  });

  it('never divides by zero: a zero-usage baseline yields null deltas and no NaN', async () => {
    const tasks: EvalTask[] = [{ name: 'zero-baseline', prompt: 'Baseline reports zeros.' }];
    const report = await runFakeBenchmark({
      tasks,
      warmupTasks: 0,
      runTask: async (arm) => ({
        usage: arm === 'baseline' ? usage(0, 0, 0, 0) : usage(500, 100, 200, 50),
        costUsd: arm === 'baseline' ? 0 : 0.5,
        passed: true,
      }),
    });

    const comparison = report.comparisons[0];
    assert.equal(comparison.baselineTotalTokens, 0);
    assert.equal(comparison.assistedTotalTokens, 850);
    assert.equal(comparison.deltaTokensPct, null);
    assert.equal(comparison.deltaEffTokensPct, null);
    // Zero usage is still reported telemetry, so the task is comparable...
    assert.equal(comparison.comparable, true);
    // ...but it cannot move means that need a baseline denominator.
    assert.equal(report.summary.comparableTasks, 1);
    assert.equal(report.summary.meanDeltaTokensPct, null);
    assert.equal(report.summary.meanDeltaEffTokensPct, null);
    assert.equal(report.summary.baselineUsd, 0);

    assertAllNumbersFinite(report);
    assert.ok(!renderMarkdownReport(report).includes('NaN'));
    assert.ok(!renderCsvReport(report).includes('NaN'));
  });

  it('treats missing usage as no telemetry and keeps its cost in the USD sums', async () => {
    const tasks: EvalTask[] = [{ name: 'no-usage', prompt: 'No usage reported.' }];
    const report = await runFakeBenchmark({
      tasks,
      warmupTasks: 0,
      runTask: async (arm) => ({
        usage: arm === 'baseline' ? null : usage(500, 0, 0, 100),
        costUsd: arm === 'baseline' ? 0.5 : 0.25,
        passed: true,
      }),
    });

    const comparison = report.comparisons[0];
    assert.equal(comparison.baselineTotalTokens, null);
    assert.equal(comparison.baselineEffTokens, null);
    assert.equal(comparison.assistedTotalTokens, 600);
    assert.equal(comparison.assistedEffTokens, 1000);
    assert.equal(comparison.deltaTokensPct, null);
    assert.equal(comparison.deltaEffTokensPct, null);
    assert.equal(comparison.passAt1Parity, true);
    assert.equal(comparison.comparable, false, 'comparability needs usage telemetry from both arms');
    assert.equal(report.summary.baselineUsd, 0.5);
    assert.equal(report.summary.assistedUsd, 0.25);

    const csvLines = renderCsvReport(report).split('\r\n');
    assert.equal(csvLines[1], 'no-usage,1,false,,600,,,1000,,true,true,true,false');
    assertAllNumbersFinite(report);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const RENDER_TASKS: EvalTask[] = [
  { name: 'task-one', prompt: 'Do one.' },
  { name: 'task-two', prompt: 'Do two.' },
];

const RENDER_OUTCOMES: Record<string, Record<'baseline' | 'assisted', TaskRunOutcome>> = {
  'task-one': {
    baseline: { usage: usage(1000, 0, 0, 100), costUsd: 0.5, passed: true },
    assisted: { usage: usage(500, 0, 0, 100), costUsd: 0.25, passed: true },
  },
  'task-two': {
    baseline: { usage: usage(3750, 0, 0, 250), costUsd: 0.25, passed: true },
    assisted: { usage: usage(2750, 0, 0, 250), costUsd: 0.125, passed: true },
  },
};

async function buildRenderReport(): Promise<BenchmarkReport> {
  return runFakeBenchmark({
    tasks: RENDER_TASKS,
    warmupTasks: 1,
    repoRoot: 'C:/fixtures/repo',
    baseCommit: BASE_COMMIT,
    runTask: async (arm, task) => RENDER_OUTCOMES[task.name][arm],
  });
}

const EXPECTED_MARKDOWN = [
  '# LogLode Eval Report',
  '',
  '- Repo root: C:/fixtures/repo',
  `- Base commit: ${BASE_COMMIT}`,
  '- Tasks: 2 total (1 warm-up, 1 non-warm-up)',
  '- Comparable tasks (used for the means): 1',
  '',
  '| Task | Warmup | Baseline T | Assisted T | ΔT% | ΔT_eff% | Pass@1 | Parity | Comparable |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| task-one | yes | 1100 | 600 | +45.45% | +33.33% | P/P | yes | no |',
  '| task-two | no | 4000 | 3000 | +25.00% | +20.00% | P/P | yes | yes |',
  '',
  '## Summary',
  '',
  '- Comparable tasks: 1',
  '- Mean ΔT%: +25.00%',
  '- Mean ΔT_eff%: +20.00%',
  '- Pass@1 parity rate: 100.00% (1/1 non-warm-up tasks with known parity)',
  '- Baseline USD (non-warm-up tasks reporting cost): 0.2500',
  '- Assisted USD (non-warm-up tasks reporting cost): 0.1250',
  '',
  '> Means cover comparable tasks only: non-warm-up tasks where Pass@1 parity holds and both arms reported usage telemetry. Tasks outside that set are listed above but do not move the means.',
  '> Pass@1 is shown as baseline/assisted (`P` = passed, `F` = failed, `-` = unknown). Warm-up tasks never contribute to any summary aggregate.',
  '> USD totals include every non-warm-up task that reported a numeric cost, even ones excluded from the means.',
  '',
].join('\n');

const EXPECTED_CSV = [
  'task,index,warmup,baseline_tokens,assisted_tokens,delta_tokens_pct,baseline_eff_tokens,assisted_eff_tokens,delta_eff_pct,pass_baseline,pass_assisted,parity,comparable',
  'task-one,1,true,1100,600,45.45,1500,1000,33.33,true,true,true,false',
  'task-two,2,false,4000,3000,25.00,5000,4000,20.00,true,true,true,true',
  '',
].join('\r\n');

describe('renderMarkdownReport', () => {
  it('renders the full report deterministically', async () => {
    const report = await buildRenderReport();
    assert.equal(renderMarkdownReport(report), EXPECTED_MARKDOWN);
  });

  it('uses - for every unknown value', async () => {
    const report = await runFakeBenchmark({
      tasks: [{ name: 'unknowns', prompt: 'Unknown everything.' }],
      warmupTasks: 0,
      runTask: async () => ({ passed: null }),
    });
    const markdown = renderMarkdownReport(report);
    assert.ok(markdown.includes('| unknowns | no | - | - | - | - | -/- | - | no |'));
    assert.ok(markdown.includes('- Mean ΔT%: -'));
    assert.ok(markdown.includes('- Baseline USD (non-warm-up tasks reporting cost): -'));
  });
});

describe('renderCsvReport', () => {
  it('renders the full report with CRLF line endings', async () => {
    const report = await buildRenderReport();
    const csv = renderCsvReport(report);
    assert.equal(csv, EXPECTED_CSV);
    assert.equal(csv.endsWith('\r\n'), true);
    assert.equal(csv.includes('\r\n'), true);
    assert.equal(csv.replace(/\r\n/g, '').includes('\n'), false, 'every newline must be CRLF');
  });

  it('quotes task names that contain separators', async () => {
    const report = await runFakeBenchmark({
      tasks: [{ name: 'fix "auth", now', prompt: 'Quote me.' }],
      warmupTasks: 0,
      runTask: async () => ({ usage: usage(100, 0, 0, 0), passed: true }),
    });
    assert.ok(renderCsvReport(report).split('\r\n')[1].startsWith('"fix ""auth"", now",1,false,'));
  });
});

// ---------------------------------------------------------------------------
// parseTasksYaml
// ---------------------------------------------------------------------------

describe('parseTasksYaml', () => {
  it('parses the canonical literal-block suite', () => {
    const source = [
      '- name: fix-login-bug',
      '  prompt: |',
      '    Fix the login bug in auth.ts.',
      '    Keep the change minimal.',
      '',
      '- name: add-tests',
      '  prompt: Add unit tests for auth.ts.',
    ].join('\n');

    assert.deepEqual(parseTasksYaml(source), [
      { name: 'fix-login-bug', prompt: 'Fix the login bug in auth.ts.\nKeep the change minimal.' },
      { name: 'add-tests', prompt: 'Add unit tests for auth.ts.' },
    ]);
  });

  it('treats > exactly like | (the subset does not fold lines)', () => {
    const source = ['- name: folded', '  prompt: >', '    first line', '    second line'].join('\n');
    assert.deepEqual(parseTasksYaml(source), [{ name: 'folded', prompt: 'first line\nsecond line' }]);
  });

  it('ignores comment lines and trailing comments, and keeps spaces in names', () => {
    const source = [
      '# LogLode eval suite',
      '',
      '- name: fix the login bug   # inline comment',
      '  # a comment between keys',
      '  prompt: Fix the login bug.',
      '',
      '  # trailing comment after a blank line',
    ].join('\n');

    assert.deepEqual(parseTasksYaml(source), [{ name: 'fix the login bug', prompt: 'Fix the login bug.' }]);
  });

  it('dedents a block by its minimum indentation and keeps inner blank lines', () => {
    const source = [
      '- name: dedent',
      '  prompt: |',
      '      three spaces',
      '        five spaces',
      '',
      '      back to three',
    ].join('\n');

    assert.deepEqual(parseTasksYaml(source), [
      { name: 'dedent', prompt: 'three spaces\n  five spaces\n\nback to three' },
    ]);
  });

  it('accepts name/prompt in either order and quoted scalars', () => {
    assert.deepEqual(parseTasksYaml(['- prompt: Do the thing.', '  name: reversed'].join('\n')), [
      { name: 'reversed', prompt: 'Do the thing.' },
    ]);
    assert.deepEqual(parseTasksYaml('- name: "fix: login bug"\n  prompt: \'It\'\'s broken.\''), [
      { name: 'fix: login bug', prompt: "It's broken." },
    ]);
  });

  it('rejects an item without a prompt', () => {
    assert.throws(
      () => parseTasksYaml('- name: lonely\n'),
      /Line 1: list item is missing the required 'prompt' key\./,
    );
  });

  it('rejects an item without a name', () => {
    assert.throws(
      () => parseTasksYaml('- prompt: no name here\n'),
      /Line 1: list item is missing the required 'name' key\./,
    );
  });

  it('rejects non-list input with the offending line number', () => {
    assert.throws(
      () => parseTasksYaml('name: nope\nprompt: nope\n'),
      /Line 1: expected a top-level list item starting with '- '/,
    );
  });

  it('rejects unsupported keys with a line number', () => {
    assert.throws(
      () => parseTasksYaml(['- name: ok', '  description: nope', '  prompt: fine'].join('\n')),
      /Line 2: unsupported key 'description'; only 'name' and 'prompt' are supported\./,
    );
  });

  it('rejects an empty prompt block', () => {
    assert.throws(
      () => parseTasksYaml(['- name: empty-block', '  prompt: |', '- name: next'].join('\n')),
      /Line 2: 'prompt' block scalar has no content\./,
    );
  });

  it('returns an empty suite for empty or comment-only input', () => {
    assert.deepEqual(parseTasksYaml(''), []);
    assert.deepEqual(parseTasksYaml('\n\n# only comments\n'), []);
  });
});
