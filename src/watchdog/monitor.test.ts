import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TokenUsage, WatchdogActions } from '../adapters/types.js';
import { DEFAULT_CONFIG, type BudgetConfig, type LoopsConfig } from '../config.js';
import { BudgetWatchdog, EDIT_TOOL_PATTERN, type WatchdogConfig } from './monitor.js';

/**
 * Cheap model from `DEFAULT_PRICING` (src/cost.ts), matched by prefix:
 * `claude-haiku-4` => $1 / $1.25 / $0.10 / $5 per 1M tokens
 * (input / cache write / cache read / output).
 *
 * Exact token counts used below:
 *   - 740_000 input => $0.74 (below the $0.75 soft cap)
 *   - 260_000 input => +$0.26 => $1.00 cumulative (crosses the soft cap)
 *   - 750_000 input => $0.75 exactly (inclusive soft threshold)
 *   - 1_000_000 input => $1.00
 *   - 2_000_000 input => $2.00 exactly (inclusive hard threshold)
 */
const HAIKU = 'claude-haiku-4-5';
const UNKNOWN_MODEL = 'mystery-model';

interface CapturedActions {
  actions: WatchdogActions;
  banners: string[];
  notifies: string[];
  aborts: string[];
}

function makeActions(): CapturedActions {
  const banners: string[] = [];
  const notifies: string[] = [];
  const aborts: string[] = [];
  const actions: WatchdogActions = {
    banner: (message) => {
      banners.push(message);
    },
    notify: (message) => {
      notifies.push(message);
    },
    requestAbort: (reason) => {
      aborts.push(reason);
    },
  };
  return { actions, banners, notifies, aborts };
}

interface WatchdogOptions {
  budget?: Partial<BudgetConfig>;
  loops?: Partial<LoopsConfig>;
  noKill?: boolean;
}

function makeWatchdog(options: WatchdogOptions = {}): CapturedActions & { watchdog: BudgetWatchdog } {
  const captured = makeActions();
  const config: WatchdogConfig = {
    budget: { ...DEFAULT_CONFIG.budget, ...options.budget },
    loops: { ...DEFAULT_CONFIG.loops, ...options.loops },
    ...(options.noKill === undefined ? {} : { noKill: options.noKill }),
  };
  const watchdog = new BudgetWatchdog(config, captured.actions);
  return { ...captured, watchdog };
}

function tokens(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...overrides };
}

function toolCall(toolName: string, targetPath: string | null): { turnIndex: number; toolName: string; targetPath: string | null } {
  return { turnIndex: 1, toolName, targetPath };
}

function toolResult(
  overrides: Partial<{ exitCode: number | null; outputTokens: number; errorFingerprint: string | null }> = {},
): { turnIndex: number; exitCode: number | null; outputTokens: number; errorFingerprint: string | null } {
  return { turnIndex: 1, exitCode: 0, outputTokens: 10, errorFingerprint: null, ...overrides };
}

/** Float-tolerant equality for USD sums (token counts here are exact anyway). */
function assertClose(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `expected ~${expected}, got ${actual}`);
}

function breachKinds(watchdog: BudgetWatchdog): string[] {
  return watchdog.getSummary().breaches.map((breach) => breach.kind);
}

describe('EDIT_TOOL_PATTERN', () => {
  it('matches edit-style tool names and not read-style ones', () => {
    for (const name of ['edit', 'edit_file', 'write', 'write_file', 'apply_patch', 'EditFile', 'PATCH']) {
      assert.ok(EDIT_TOOL_PATTERN.test(name), `${name} should be an edit tool`);
    }
    for (const name of ['read_file', 'grep', 'glob', 'bash', 'view']) {
      assert.equal(EDIT_TOOL_PATTERN.test(name), false, `${name} should not be an edit tool`);
    }
  });
});

describe('BudgetWatchdog spend caps', () => {
  it('stays quiet below the soft cap and fires exactly once at the crossing', () => {
    const { watchdog, banners, notifies, aborts } = makeWatchdog();

    // $0.74: under the $0.75 soft cap.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 740_000 }));
    assertClose(watchdog.getSummary().spendUsd, 0.74);
    assert.equal(banners.length, 0);
    assert.equal(notifies.length, 0);
    assert.equal(watchdog.getSummary().breaches.length, 0);

    // +$0.26 => $1.00 cumulative: crosses the soft cap.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 260_000 }));
    assertClose(watchdog.getSummary().spendUsd, 1);
    assert.equal(banners.length, 1);
    assert.equal(notifies.length, 1);
    assert.match(banners[0], /soft budget alert/);
    assert.match(banners[0], /\$1\.00/);
    assert.match(notifies[0], /soft budget alert/);
    assert.deepStrictEqual(watchdog.getSummary().breaches.map((breach) => breach.kind), ['soft_alert']);
    assert.equal(watchdog.getSummary().breaches[0].hard, false);
    assert.equal(aborts.length, 0);

    // $1.50 cumulative: the soft alert is latched and must not refire.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 500_000 }));
    assertClose(watchdog.getSummary().spendUsd, 1.5);
    assert.equal(banners.length, 1);
    assert.equal(notifies.length, 1);
    assert.equal(watchdog.getSummary().breaches.length, 1);
  });

  it('fires at exactly soft_alert_usd (inclusive threshold)', () => {
    const { watchdog, banners, notifies } = makeWatchdog();

    // 750k input tokens * $1/1M => exactly $0.75.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 750_000 }));
    assert.equal(watchdog.getSummary().spendUsd, 0.75);
    assert.equal(banners.length, 1);
    assert.equal(notifies.length, 1);
    assert.deepStrictEqual(breachKinds(watchdog), ['soft_alert']);
  });

  it('requests abort exactly once when spend reaches hard_stop_usd', () => {
    const { watchdog, banners, notifies, aborts } = makeWatchdog();

    // $1.00: soft alert only.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000_000 }));
    assertClose(watchdog.getSummary().spendUsd, 1);
    assert.deepStrictEqual(breachKinds(watchdog), ['soft_alert']);
    assert.equal(aborts.length, 0);

    // $2.00 exactly: hard stop, one abort request.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000_000 }));
    assert.equal(watchdog.getSummary().spendUsd, 2);
    assert.deepStrictEqual(breachKinds(watchdog), ['soft_alert', 'hard_stop']);
    assert.equal(watchdog.getSummary().breaches[1].hard, true);
    assert.equal(banners.length, 2);
    assert.equal(notifies.length, 2);
    assert.equal(aborts.length, 1);
    assert.match(aborts[0], /^hard budget stop/);

    // $3.00: the hard stop and the abort are latched for the session.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000_000 }));
    assertClose(watchdog.getSummary().spendUsd, 3);
    assert.equal(aborts.length, 1);
    assert.equal(banners.length, 2);
    assert.equal(notifies.length, 2);
    assert.equal(watchdog.getSummary().breaches.length, 2);
  });

  it('records and announces the hard breach but never aborts with --no-kill', () => {
    const { watchdog, banners, notifies, aborts } = makeWatchdog({ noKill: true });

    watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000_000 })); // $1.00 soft
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000_000 })); // $2.00 hard
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000_000 })); // $3.00 still latched

    assertClose(watchdog.getSummary().spendUsd, 3);
    assert.deepStrictEqual(breachKinds(watchdog), ['soft_alert', 'hard_stop']);
    assert.equal(watchdog.getSummary().breaches[1].hard, true);
    assert.equal(banners.length, 2);
    assert.equal(notifies.length, 2);
    assert.match(banners[1], /hard budget stop/);
    assert.match(banners[1], /no-kill/);
    assert.equal(aborts.length, 0);
  });

  it('treats an explicit noKill: false like an unset flag', () => {
    const { watchdog, aborts } = makeWatchdog({ noKill: false });

    watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000_000 }));
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000_000 }));

    assert.equal(aborts.length, 1);
    assert.match(aborts[0], /hard budget stop/);
  });
});

describe('BudgetWatchdog retry loop', () => {
  it('alerts on the third identical fingerprint, once per fingerprint', () => {
    const { watchdog, banners, notifies } = makeWatchdog();
    const fingerprint = 'sha256:deadbeef';

    // Null and blank fingerprints are not loop evidence.
    for (let index = 0; index < 5; index += 1) {
      watchdog.onToolResult(toolResult({ errorFingerprint: null }));
      watchdog.onToolResult(toolResult({ errorFingerprint: '' }));
    }
    assert.equal(watchdog.getSummary().breaches.length, 0);

    // Two occurrences: under the max_same_error_retries=3 limit.
    watchdog.onToolResult(toolResult({ exitCode: 1, errorFingerprint: fingerprint }));
    watchdog.onToolResult(toolResult({ exitCode: 1, errorFingerprint: fingerprint }));
    assert.equal(banners.length, 0);
    assert.equal(notifies.length, 0);
    assert.equal(watchdog.getSummary().breaches.length, 0);

    // Third occurrence: retry_loop, banner + notify.
    watchdog.onToolResult(toolResult({ exitCode: 1, errorFingerprint: fingerprint }));
    assert.deepStrictEqual(breachKinds(watchdog), ['retry_loop']);
    assert.equal(watchdog.getSummary().breaches[0].hard, false);
    assert.match(banners[0], /retry loop/);
    assert.equal(banners.length, 1);
    assert.equal(notifies.length, 1);

    // Fourth occurrence: already latched for this fingerprint.
    watchdog.onToolResult(toolResult({ exitCode: 1, errorFingerprint: fingerprint }));
    assert.equal(banners.length, 1);
    assert.equal(notifies.length, 1);
    assert.equal(watchdog.getSummary().breaches.length, 1);

    // A different fingerprint gets its own count and its own alert.
    for (let index = 0; index < 3; index += 1) {
      watchdog.onToolResult(toolResult({ exitCode: 2, errorFingerprint: 'sha256:cafebabe' }));
    }
    assert.deepStrictEqual(breachKinds(watchdog), ['retry_loop', 'retry_loop']);
    assert.equal(banners.length, 2);
    assert.equal(notifies.length, 2);
  });
});

describe('BudgetWatchdog read loop', () => {
  it('alerts on the fourth read of a path and resets after an edit', () => {
    const { watchdog, banners } = makeWatchdog();

    // Null and blank paths are not read-loop evidence.
    for (let index = 0; index < 6; index += 1) {
      watchdog.onToolCall(toolCall('read_file', null));
      watchdog.onToolCall(toolCall('read_file', '   '));
    }
    assert.equal(watchdog.getSummary().breaches.length, 0);

    // Three reads: under the max_same_file_reads=4 limit.
    for (let index = 0; index < 3; index += 1) {
      watchdog.onToolCall(toolCall('read_file', 'src/a.ts'));
    }
    assert.equal(watchdog.getSummary().breaches.length, 0);

    // Fourth read: read_loop, banner only (no notification for soft loops).
    watchdog.onToolCall(toolCall('read_file', 'src/a.ts'));
    assert.deepStrictEqual(breachKinds(watchdog), ['read_loop']);
    assert.equal(watchdog.getSummary().breaches[0].hard, false);
    assert.match(banners[0], /read loop/);
    assert.match(banners[0], /src\/a\.ts/);
    assert.equal(banners.length, 1);

    // Further reads stay latched on this path.
    for (let index = 0; index < 2; index += 1) {
      watchdog.onToolCall(toolCall('read_file', 'src/a.ts'));
    }
    assert.equal(watchdog.getSummary().breaches.length, 1);

    // An edit to a different path does not reset src/a.ts.
    watchdog.onToolCall(toolCall('edit', 'src/other.ts'));
    watchdog.onToolCall(toolCall('read_file', 'src/a.ts'));
    assert.equal(watchdog.getSummary().breaches.length, 1);

    // An edit to src/a.ts resets both the counter and the alert latch.
    watchdog.onToolCall(toolCall('apply_patch', 'src/a.ts'));
    for (let index = 0; index < 3; index += 1) {
      watchdog.onToolCall(toolCall('read_file', 'src/a.ts'));
    }
    assert.equal(watchdog.getSummary().breaches.length, 1);

    // Reads of another path do not interfere with src/a.ts.
    for (let index = 0; index < 3; index += 1) {
      watchdog.onToolCall(toolCall('read_file', 'src/b.ts'));
    }
    assert.equal(watchdog.getSummary().breaches.length, 1);

    // The next read of src/a.ts is its fourth since the edit: alert again.
    watchdog.onToolCall(toolCall('read_file', 'src/a.ts'));
    assert.deepStrictEqual(breachKinds(watchdog), ['read_loop', 'read_loop']);
    assert.equal(banners.length, 2);
    assert.match(banners[1], /src\/a\.ts/);

    // src/b.ts is tracked independently and trips at its own fourth read.
    watchdog.onToolCall(toolCall('read_file', 'src/b.ts'));
    assert.deepStrictEqual(breachKinds(watchdog), ['read_loop', 'read_loop', 'read_loop']);
    assert.match(banners[2], /src\/b\.ts/);
  });
});

describe('BudgetWatchdog single-turn spike', () => {
  it('fires per occurrence when output tokens exceed max_single_turn_tokens', () => {
    const { watchdog, banners, notifies } = makeWatchdog();

    // Exactly at the limit (25000) is not a spike.
    watchdog.onToolResult(toolResult({ outputTokens: 25_000 }));
    assert.equal(watchdog.getSummary().breaches.length, 0);

    // One over the limit fires, banner only.
    watchdog.onToolResult(toolResult({ outputTokens: 25_001 }));
    assert.deepStrictEqual(breachKinds(watchdog), ['single_turn_spike']);
    assert.equal(watchdog.getSummary().breaches[0].hard, false);
    assert.match(banners[0], /single-turn spike/);
    assert.equal(banners.length, 1);
    assert.equal(notifies.length, 0);

    // No latch: the next spike is recorded and announced again.
    watchdog.onToolResult(toolResult({ outputTokens: 25_001 }));
    assert.deepStrictEqual(breachKinds(watchdog), ['single_turn_spike', 'single_turn_spike']);
    assert.equal(banners.length, 2);
    assert.equal(notifies.length, 0);
  });
});

describe('BudgetWatchdog cache-hit collapse', () => {
  it('stays quiet while the cumulative cache-read ratio is healthy', () => {
    const { watchdog, banners, notifies } = makeWatchdog();

    // 10k total input tokens per frame, 9000 of them cache reads => ratio 0.9.
    for (let index = 0; index < 5; index += 1) {
      watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000, cacheReadTokens: 9_000 }));
    }

    assert.equal(watchdog.getSummary().usageEvents, 5);
    assert.equal(watchdog.getSummary().breaches.length, 0);
    assert.equal(banners.length, 0);
    assert.equal(notifies.length, 0);
  });

  it('does not evaluate before the fourth usage frame', () => {
    const { watchdog } = makeWatchdog();

    // Three fully unhealthy frames: ratio 0, but usageEvents < 4.
    for (let index = 0; index < 3; index += 1) {
      watchdog.onUsage(HAIKU, tokens({ inputTokens: 100_000 }));
    }
    assert.equal(watchdog.getSummary().usageEvents, 3);
    assert.equal(watchdog.getSummary().breaches.length, 0);

    // The fourth frame is when the rule becomes active.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 100_000 }));
    assert.deepStrictEqual(breachKinds(watchdog), ['cache_collapse']);
  });

  it('alerts once after a big uncached turn and never refires as it worsens', () => {
    const { watchdog, banners, notifies } = makeWatchdog();

    // Frames 1-3: healthy cumulative ratio (27000 / 30000 = 0.9).
    for (let index = 0; index < 3; index += 1) {
      watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000, cacheReadTokens: 9_000 }));
    }
    assert.equal(watchdog.getSummary().breaches.length, 0);

    // Frame 4 adds 100k uncached input: cumulative 28000 / 131000 < 0.5.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 100_000, cacheReadTokens: 1_000 }));
    assert.deepStrictEqual(breachKinds(watchdog), ['cache_collapse']);
    assert.equal(watchdog.getSummary().breaches[0].hard, false);
    assert.match(banners[0], /cache-hit collapse/);
    assert.equal(banners.length, 1);
    assert.equal(notifies.length, 1);

    // Frame 5 worsens the ratio; the single alert is latched.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 200_000 }));
    assert.equal(watchdog.getSummary().usageEvents, 5);
    assert.equal(watchdog.getSummary().breaches.length, 1);
    assert.equal(banners.length, 1);
    assert.equal(notifies.length, 1);
  });
});

describe('BudgetWatchdog unknown models', () => {
  it('prices unknown models at zero and raises no spend alerts', () => {
    const { watchdog, banners, notifies, aborts } = makeWatchdog();

    watchdog.onUsage(
      UNKNOWN_MODEL,
      tokens({ inputTokens: 10_000_000, cacheReadTokens: 5_000_000, cacheWriteTokens: 5_000_000, outputTokens: 10_000_000 }),
    );

    const summary = watchdog.getSummary();
    assert.equal(summary.spendUsd, 0);
    assert.equal(summary.usageEvents, 1);
    assert.deepStrictEqual(summary.breaches, []);
    assert.equal(banners.length, 0);
    assert.equal(notifies.length, 0);
    assert.equal(aborts.length, 0);
  });
});

describe('BudgetWatchdog getSummary', () => {
  it('accumulates spend and usage events and keeps breaches in order', () => {
    const { watchdog } = makeWatchdog({ noKill: true });

    // Usage frame 1: $1.00 => soft_alert.
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000_000 }));
    const snapshot = watchdog.getSummary();
    assertClose(snapshot.spendUsd, 1);
    assert.equal(snapshot.usageEvents, 1);
    assert.deepStrictEqual(snapshot.breaches.map((breach) => breach.kind), ['soft_alert']);

    // Usage frame 2: $2.00 => hard_stop (noKill keeps requestAbort silent).
    watchdog.onUsage(HAIKU, tokens({ inputTokens: 1_000_000 }));

    // A spike, then a retry loop on a different fingerprint.
    watchdog.onToolResult(toolResult({ outputTokens: 30_000 }));
    for (let index = 0; index < 3; index += 1) {
      watchdog.onToolResult(toolResult({ outputTokens: 10, errorFingerprint: 'sha256:loop' }));
    }

    const summary = watchdog.getSummary();
    assertClose(summary.spendUsd, 2);
    assert.equal(summary.usageEvents, 2);
    assert.deepStrictEqual(
      summary.breaches.map((breach) => breach.kind),
      ['soft_alert', 'hard_stop', 'single_turn_spike', 'retry_loop'],
    );
    assert.deepStrictEqual(
      summary.breaches.map((breach) => breach.hard),
      [false, true, false, false],
    );
    for (const breach of summary.breaches) {
      assert.equal(typeof breach.message, 'string');
      assert.ok(breach.message.length > 0);
    }

    // Earlier snapshots are copies, not live views of the running totals.
    assert.equal(snapshot.breaches.length, 1);
    assertClose(snapshot.spendUsd, 1);
    assert.deepStrictEqual(watchdog.getSummary(), summary);
  });
});

describe('BudgetWatchdog malformed input', () => {
  it('never throws and clamps negative, null, and non-finite counts', () => {
    const { watchdog, banners, notifies, aborts } = makeWatchdog();

    // Negative and NaN token counts on an unknown model: clamped to zero.
    watchdog.onUsage(UNKNOWN_MODEL, {
      inputTokens: -100,
      cacheReadTokens: Number.NaN,
      cacheWriteTokens: -5,
      outputTokens: -1,
    });
    // A null usage frame must not throw.
    watchdog.onUsage(HAIKU, null as unknown as TokenUsage);
    // Infinity is not a real count either.
    watchdog.onUsage(HAIKU, {
      inputTokens: Number.POSITIVE_INFINITY,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });

    // Negative/NaN tool output and blank fingerprints.
    watchdog.onToolResult({ turnIndex: 0, exitCode: null, outputTokens: -50, errorFingerprint: null });
    watchdog.onToolResult({ turnIndex: 0, exitCode: null, outputTokens: Number.NaN, errorFingerprint: '' });
    // Blank paths never create read-loop state.
    watchdog.onToolCall({ turnIndex: 0, toolName: 'read_file', targetPath: '' });

    const summary = watchdog.getSummary();
    assert.equal(summary.spendUsd, 0);
    assert.equal(summary.usageEvents, 3);
    assert.deepStrictEqual(summary.breaches, []);
    assert.equal(banners.length, 0);
    assert.equal(notifies.length, 0);
    assert.equal(aborts.length, 0);
  });
});
