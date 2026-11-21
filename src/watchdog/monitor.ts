/**
 * Live in-process budget watchdog (architecture §3 "Stage 3: Live Watchdog
 * Evaluation", thresholds from §7 `[budget]` / `[loops]`).
 *
 * The monitor is deliberately pure: it holds no child process, no timers, and
 * no file handles. The pipeline feeds it telemetry through `onToolCall`,
 * `onToolResult`, and `onUsage`, and it decides when a rule has been crossed.
 * Every side effect goes through the injected `WatchdogActions` (banner, OS
 * notification, abort request) so the CLI wiring owns the real I/O and tests
 * can capture the calls instead.
 *
 * Rules (all thresholds inclusive — a value equal to the limit fires):
 *  1. Spend caps — soft alert at `soft_alert_usd`, hard stop at `hard_stop_usd`.
 *     `noKill` (`--no-kill`) still records and announces the hard breach but
 *     never calls `requestAbort`.
 *  2. Retry loop — the same non-null `errorFingerprint` seen
 *     `max_same_error_retries` times or more.
 *  3. Read loop — the same non-null `targetPath` read
 *     `max_same_file_reads` times or more without an intervening edit to that
 *     path. An edit resets both the count and the "already alerted" latch.
 *  4. Single-turn spike — a tool result whose `outputTokens` exceeds
 *     `max_single_turn_tokens`. Fires on every occurrence (no latch).
 *  5. Cache-hit collapse — cumulative `cacheReadToken / totalInputToken` below
 *     `min_cache_hit_ratio`, evaluated from the fourth usage frame onward,
 *     latched to one alert per session.
 *
 * The methods never throw on malformed telemetry: non-finite or negative token
 * counts are clamped to zero, and null/empty fingerprints and paths are ignored.
 */

import type { BreachKind, TokenUsage, WatchdogActions, WatchdogBreach } from '../adapters/types.js';
import type { BudgetConfig, LoopsConfig } from '../config.js';
import { estimateCostUsd } from '../cost.js';

/**
 * Tool names matching this pattern are edits rather than reads, so they reset a
 * path's read-loop counter. Exported because the pipeline reuses it when
 * normalising tool records.
 */
export const EDIT_TOOL_PATTERN = /edit|write|apply|patch/i;

/** Cache-hit collapse is only meaningful after this many usage frames (§3). */
const CACHE_RATIO_MIN_USAGE_EVENTS = 4;

export interface WatchdogConfig {
  budget: BudgetConfig;
  loops: LoopsConfig;
  /** `--no-kill`: downgrade the hard stop to a loud warning and never abort. */
  noKill?: boolean;
}

export interface WatchdogSummary {
  spendUsd: number;
  usageEvents: number;
  breaches: WatchdogBreach[];
}

/** Coerce a token count to a finite, non-negative number (clamp, never throw). */
function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Defensive clone of an incoming usage frame; malformed fields become zero. */
function normalizeUsage(usage: TokenUsage | null | undefined): TokenUsage {
  return {
    inputTokens: toCount(usage?.inputTokens),
    cacheReadTokens: toCount(usage?.cacheReadTokens),
    cacheWriteTokens: toCount(usage?.cacheWriteTokens),
    outputTokens: toCount(usage?.outputTokens),
  };
}

/**
 * Identity key for fingerprints / paths: null for anything that is not a
 * non-blank string, otherwise the original string (identity is preserved, no
 * trimming, so distinct keys stay distinct).
 */
function identityKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function formatUsd(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '$?';
}

function formatPercent(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '?%';
  }
  return `${Number((value * 100).toFixed(1))}%`;
}

export class BudgetWatchdog {
  private readonly budget: BudgetConfig;
  private readonly loops: LoopsConfig;
  private readonly noKill: boolean;
  private readonly actions: WatchdogActions;

  private spendUsd = 0;
  private usageEvents = 0;
  private totalInputTokens = 0;
  private totalCacheReadTokens = 0;

  private softAlertFired = false;
  private hardStopFired = false;
  private abortRequested = false;
  private cacheCollapseFired = false;

  private readonly errorCounts = new Map<string, number>();
  private readonly alertedErrors = new Set<string>();
  private readonly readCounts = new Map<string, number>();
  private readonly alertedReads = new Set<string>();
  private readonly breaches: WatchdogBreach[] = [];

  constructor(config: WatchdogConfig, actions: WatchdogActions) {
    // Copy the threshold objects so later mutation of the caller's config cannot
    // silently change an in-flight session's rules.
    this.budget = { ...config.budget };
    this.loops = { ...config.loops };
    this.noKill = config.noKill === true;
    this.actions = actions;
  }

  /**
   * Observe a tool invocation. Reads are counted per `targetPath`; an edit to a
   * path resets that path's read count and alert latch.
   */
  onToolCall(event: { turnIndex: number; toolName: string; targetPath: string | null }): void {
    const targetPath = identityKey(event?.targetPath);
    if (targetPath === null) {
      return;
    }

    const toolName = typeof event?.toolName === 'string' ? event.toolName : '';
    if (EDIT_TOOL_PATTERN.test(toolName)) {
      this.readCounts.set(targetPath, 0);
      this.alertedReads.delete(targetPath);
      return;
    }

    const reads = (this.readCounts.get(targetPath) ?? 0) + 1;
    this.readCounts.set(targetPath, reads);
    if (reads >= this.loops.maxSameFileReads && !this.alertedReads.has(targetPath)) {
      this.alertedReads.add(targetPath);
      const message =
        `read loop: ${targetPath} has been read ${reads} times without an intervening edit ` +
        `(limit ${this.loops.maxSameFileReads})`;
      this.recordBreach('read_loop', message, false);
      this.actions.banner(message);
    }
  }

  /** Observe a tool result: retry-loop fingerprints and single-turn spikes. */
  onToolResult(event: { turnIndex: number; exitCode: number | null; outputTokens: number; errorFingerprint: string | null }): void {
    const fingerprint = identityKey(event?.errorFingerprint);
    if (fingerprint !== null) {
      const count = (this.errorCounts.get(fingerprint) ?? 0) + 1;
      this.errorCounts.set(fingerprint, count);
      if (count >= this.loops.maxSameErrorRetries && !this.alertedErrors.has(fingerprint)) {
        this.alertedErrors.add(fingerprint);
        const message =
          `retry loop: the same error fingerprint repeated ${count} times ` +
          `(limit ${this.loops.maxSameErrorRetries}) — ${fingerprint}`;
        this.recordBreach('retry_loop', message, false);
        this.actions.banner(message);
        this.actions.notify(message);
      }
    }

    const outputTokens = toCount(event?.outputTokens);
    if (outputTokens > this.budget.maxSingleTurnTokens) {
      const message =
        `single-turn spike: a tool result returned ${outputTokens} tokens, above the ` +
        `${this.budget.maxSingleTurnTokens}-token limit`;
      this.recordBreach('single_turn_spike', message, false);
      this.actions.banner(message);
    }
  }

  /**
   * Observe an API usage frame: spend caps and the cache-hit ratio. Unknown
   * models price at $0 (`estimateCostUsd`), so they never fabricate spend.
   */
  onUsage(model: string, usage: TokenUsage): void {
    const normalized = normalizeUsage(usage);
    const modelId = typeof model === 'string' ? model : '';
    const cost = estimateCostUsd(normalized, modelId);
    this.spendUsd += Number.isFinite(cost) && cost > 0 ? cost : 0;
    this.usageEvents += 1;

    const totalIn = normalized.inputTokens + normalized.cacheReadTokens + normalized.cacheWriteTokens;
    this.totalInputTokens += totalIn;
    this.totalCacheReadTokens += normalized.cacheReadTokens;

    const spend = this.spendUsd;

    // Rule 1a: soft cap, latched.
    if (!this.softAlertFired && spend > 0 && spend >= this.budget.softAlertUsd) {
      this.softAlertFired = true;
      const message =
        `soft budget alert: estimated spend ${formatUsd(spend)} reached the ` +
        `${formatUsd(this.budget.softAlertUsd)} soft cap`;
      this.recordBreach('soft_alert', message, false);
      this.actions.banner(message);
      this.actions.notify(message);
    }

    // Rule 1b: hard cap, latched; one abort request for the whole session.
    if (!this.hardStopFired && spend > 0 && spend >= this.budget.hardStopUsd) {
      this.hardStopFired = true;
      const suffix = this.noKill ? ' (--no-kill: abort suppressed)' : '';
      const message =
        `hard budget stop: estimated spend ${formatUsd(spend)} reached the ` +
        `${formatUsd(this.budget.hardStopUsd)} hard cap${suffix}`;
      this.recordBreach('hard_stop', message, true);
      this.actions.banner(message);
      this.actions.notify(message);
      if (!this.noKill && !this.abortRequested) {
        this.abortRequested = true;
        this.actions.requestAbort(message);
      }
    }

    // Rule 5: cumulative cache-hit collapse, evaluated from frame 4 onward.
    if (!this.cacheCollapseFired && this.usageEvents >= CACHE_RATIO_MIN_USAGE_EVENTS && this.totalInputTokens > 0) {
      const ratio = this.totalCacheReadTokens / this.totalInputTokens;
      if (ratio < this.loops.minCacheHitRatio) {
        this.cacheCollapseFired = true;
        const message =
          `cache-hit collapse: cache reads are ${formatPercent(ratio)} of total input tokens ` +
          `after ${this.usageEvents} usage frames (minimum ${formatPercent(this.loops.minCacheHitRatio)})`;
        this.recordBreach('cache_collapse', message, false);
        this.actions.banner(message);
        this.actions.notify(message);
      }
    }
  }

  /** Running totals and every breach recorded so far (never resets). */
  getSummary(): WatchdogSummary {
    return {
      spendUsd: this.spendUsd,
      usageEvents: this.usageEvents,
      breaches: this.breaches.map((breach) => ({ ...breach })),
    };
  }

  private recordBreach(kind: BreachKind, message: string, hard: boolean): void {
    this.breaches.push({ kind, message, hard });
  }
}
