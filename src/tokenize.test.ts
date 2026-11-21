import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateTokens } from './tokenize.js';

describe('estimateTokens', () => {
  it('returns 0 for the empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('estimates one token per four characters, rounded up', () => {
    assert.equal(estimateTokens('a'), 1);
    assert.equal(estimateTokens('abc'), 1);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.equal(estimateTokens('a'.repeat(400)), 100);
    assert.equal(estimateTokens('a'.repeat(401)), 101);
  });

  it('is deterministic across repeated calls', () => {
    const text = 'export function resolveRepoContext(cwd: string): Promise<RepoContext> {\n  return runGit(cwd);\n}\n';
    const first = estimateTokens(text);
    assert.equal(estimateTokens(text), first);
    assert.equal(estimateTokens(text), first);
    assert.equal(first, Math.ceil(text.length / 4));
  });

  it('counts UTF-16 code units rather than graphemes', () => {
    assert.equal(estimateTokens('é'.repeat(8)), 2);
    assert.equal(estimateTokens('🙂'), 1); // surrogate pair = 2 code units -> ceil(0.5) = 1
  });
});
