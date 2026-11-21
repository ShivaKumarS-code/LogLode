/**
 * Cost estimation and cost-weighted effective tokens.
 *
 * Providers do not expose dollars, only token counters, so LogLode estimates USD
 * locally from a pricing table. The numbers here are rough, deterministic
 * defaults for model-id prefixes; callers can inject their own table (for example
 * from config) to track real prices. `effectiveTokens` is the T_eff metric from
 * architecture §9, used to compare the cost of cache reads/writes and output
 * against uncached input.
 */

import type { TokenUsage } from './adapters/types.js';

/** USD per 1,000,000 tokens for each token class. */
export interface ModelPricing {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * Rough default prices in USD per 1M tokens, keyed by model-id prefix.
 * These are illustrative defaults only (prices change); pass an explicit map to
 * override them from configuration.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'claude-sonnet-4': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-haiku-4': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  'claude-3-7-sonnet': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 },
  'gpt-5-mini': { input: 0.25, cacheWrite: 0.25, cacheRead: 0.025, output: 2 },
  'gpt-5': { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 },
  'gpt-4o-mini': { input: 0.15, cacheWrite: 0.15, cacheRead: 0.075, output: 0.6 },
  'gpt-4o': { input: 2.5, cacheWrite: 2.5, cacheRead: 1.25, output: 10 },
};

/**
 * Longest-prefix, case-insensitive pricing lookup. Returns `null` for unknown
 * models (e.g. a local model with no published price).
 */
export function pricingForModel(model: string, pricing: Record<string, ModelPricing> = DEFAULT_PRICING): ModelPricing | null {
  const needle = model.trim().toLowerCase();
  if (needle === '') {
    return null;
  }

  let matchedKey: string | null = null;
  let matchedLength = 0;
  for (const key of Object.keys(pricing)) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === '' || !needle.startsWith(normalizedKey)) {
      continue;
    }
    if (normalizedKey.length > matchedLength) {
      matchedKey = key;
      matchedLength = normalizedKey.length;
    }
  }

  return matchedKey === null ? null : pricing[matchedKey];
}

/**
 * Estimate USD cost for a usage record. Returns 0 for models absent from the
 * pricing table so an unknown model never fabricates spend.
 */
export function estimateCostUsd(usage: TokenUsage, model: string, pricing: Record<string, ModelPricing> = DEFAULT_PRICING): number {
  const rates = pricingForModel(model, pricing);
  if (rates === null) {
    return 0;
  }
  return (
    usage.inputTokens * rates.input +
    usage.cacheWriteTokens * rates.cacheWrite +
    usage.cacheReadTokens * rates.cacheRead +
    usage.outputTokens * rates.output
  ) / 1_000_000;
}

/** Weights applied to each token class in the T_eff metric (architecture §9). */
export interface CostMultipliers {
  uncachedInput: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Default T_eff weights: input x1.0, cache write x1.25, cache read x0.10, output x5.0. */
export const DEFAULT_COST_MULTIPLIERS: CostMultipliers = {
  uncachedInput: 1.0,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  output: 5.0,
};

/** Cost-weighted token count (T_eff): `1.0*input + 1.25*cacheWrite + 0.10*cacheRead + 5.0*output`. */
export function effectiveTokens(usage: TokenUsage, multipliers: CostMultipliers = DEFAULT_COST_MULTIPLIERS): number {
  return (
    usage.inputTokens * multipliers.uncachedInput +
    usage.cacheWriteTokens * multipliers.cacheWrite +
    usage.cacheReadTokens * multipliers.cacheRead +
    usage.outputTokens * multipliers.output
  );
}
