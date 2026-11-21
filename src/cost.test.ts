import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_COST_MULTIPLIERS,
  DEFAULT_PRICING,
  effectiveTokens,
  estimateCostUsd,
  pricingForModel,
  type CostMultipliers,
  type ModelPricing,
} from './cost.js';
import type { TokenUsage } from './adapters/types.js';

// Chosen so every product is exactly representable as a binary float:
// 1000*1.0 + 800*1.25 + 10000*0.10 + 200*5.0 = 1000 + 1000 + 1000 + 1000.
const usage: TokenUsage = {
  inputTokens: 1000,
  cacheReadTokens: 10000,
  cacheWriteTokens: 800,
  outputTokens: 200,
};

describe('DEFAULT_COST_MULTIPLIERS', () => {
  it('uses the §9 T_eff weights', () => {
    assert.deepStrictEqual(DEFAULT_COST_MULTIPLIERS, {
      uncachedInput: 1.0,
      cacheWrite: 1.25,
      cacheRead: 0.1,
      output: 5.0,
    });
  });
});

describe('effectiveTokens', () => {
  it('applies the default weights exactly', () => {
    assert.equal(effectiveTokens(usage), 4000);
  });

  it('returns 0 for an all-zero usage record', () => {
    assert.equal(effectiveTokens({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }), 0);
  });

  it('honours injected multipliers', () => {
    const multipliers: CostMultipliers = { uncachedInput: 2, cacheWrite: 2, cacheRead: 0.25, output: 10 };
    // 2000 + 1600 + 2500 + 2000
    assert.equal(effectiveTokens(usage, multipliers), 8100);
  });
});

describe('pricingForModel', () => {
  it('matches an exact model id and a longer model id by prefix', () => {
    assert.deepStrictEqual(pricingForModel('gpt-4o'), DEFAULT_PRICING['gpt-4o']);
    assert.deepStrictEqual(pricingForModel('gpt-4o-2024-08-06'), DEFAULT_PRICING['gpt-4o']);
  });

  it('matches the longest prefix and is case-insensitive', () => {
    assert.deepStrictEqual(pricingForModel('gpt-4o-mini-2024-07-18'), DEFAULT_PRICING['gpt-4o-mini']);
    assert.deepStrictEqual(pricingForModel('CLAUDE-SONNET-4-5-20250929'), DEFAULT_PRICING['claude-sonnet-4']);
    assert.deepStrictEqual(pricingForModel('  claude-haiku-4-5  '), DEFAULT_PRICING['claude-haiku-4']);
  });

  it('prefers the longest prefix in an injected pricing map', () => {
    const parent: ModelPricing = { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 };
    const child: ModelPricing = { input: 2, cacheWrite: 2, cacheRead: 2, output: 2 };
    const pricing: Record<string, ModelPricing> = { 'gpt-4': parent, 'gpt-4o': child };

    assert.deepStrictEqual(pricingForModel('gpt-4-turbo', pricing), parent);
    assert.deepStrictEqual(pricingForModel('gpt-4o-mini', pricing), child);
  });

  it('returns null for unknown or empty model ids', () => {
    assert.equal(pricingForModel('llama-3-local'), null);
    assert.equal(pricingForModel(''), null);
    assert.equal(pricingForModel('   '), null);
    assert.equal(pricingForModel('gpt-4o', {}), null);
  });
});

describe('estimateCostUsd', () => {
  it('computes USD exactly from an injected pricing map', () => {
    const pricing: Record<string, ModelPricing> = {
      'test-model': { input: 2, cacheWrite: 4, cacheRead: 1, output: 8 },
    };
    const recorded: TokenUsage = {
      inputTokens: 2_000_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    };

    // 2M*2 + 1M*4 + 0.5M*1 + 1M*8 = 16.5 USD
    assert.equal(estimateCostUsd(recorded, 'test-model-v2', pricing), 16.5);
  });

  it('uses the default pricing table for known model ids', () => {
    const oneMillionEach: TokenUsage = {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    // 1 + 1.25 + 0.10 + 5 = 7.35 USD for haiku-tier defaults.
    const cost = estimateCostUsd(oneMillionEach, 'claude-haiku-4-5');
    assert.ok(Math.abs(cost - 7.35) < 1e-9, `expected ~7.35, got ${cost}`);
  });

  it('returns 0 for unknown models', () => {
    assert.equal(estimateCostUsd(usage, 'totally-unknown-model'), 0);
    assert.equal(estimateCostUsd(usage, '', DEFAULT_PRICING), 0);
  });

  it('returns 0 for zero usage', () => {
    assert.equal(estimateCostUsd({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, 'gpt-4o'), 0);
  });
});
