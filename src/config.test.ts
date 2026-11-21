import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, loadConfig, parseToml } from './config.js';
import { withTempDir } from './testing/tmp.js';

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  assert.fail('expected the function to throw');
}

describe('parseToml', () => {
  it('parses tables, strings, numbers, booleans, comments, and blank lines', () => {
    const source = [
      '# LogLode config',
      '',
      '[adapter]',
      'default_cli = "claude_code"         # inline comment',
      "injection_mode = 'managed_md_block'",
      '',
      '[budget]',
      'soft_alert_usd = 0.75',
      'hard_stop_usd = 2.00',
      'max_single_turn_tokens = 25000',
      'scientific = 1.5e3',
      'negative = -3',
      'enabled = true',
      'disabled = false',
      '',
      '[distiller]',
      'model = "claude-haiku-4-5"',
      'note = "a # b is not a comment"',
      'escaped = "say \\"hi\\""',
      'literal = ' + "'no \\ escapes here'",
    ].join('\n');

    assert.deepStrictEqual(parseToml(source), {
      adapter: {
        default_cli: 'claude_code',
        injection_mode: 'managed_md_block',
      },
      budget: {
        soft_alert_usd: 0.75,
        hard_stop_usd: 2,
        max_single_turn_tokens: 25000,
        scientific: 1500,
        negative: -3,
        enabled: true,
        disabled: false,
      },
      distiller: {
        model: 'claude-haiku-4-5',
        note: 'a # b is not a comment',
        escaped: 'say "hi"',
        literal: 'no \\ escapes here',
      },
    });
  });

  it('merges repeated table headers and accepts CRLF line endings', () => {
    const source = '[budget]\r\nsoft_alert_usd = 1\r\n\r\n[budget]\r\nhard_stop_usd = 2\r\n';
    assert.deepStrictEqual(parseToml(source), {
      budget: { soft_alert_usd: 1, hard_stop_usd: 2 },
    });
  });

  it('returns an empty document for empty or comment-only input', () => {
    assert.deepStrictEqual(parseToml(''), {});
    assert.deepStrictEqual(parseToml('# only a comment\n\n   \n'), {});
  });

  it('rejects malformed input with the offending line number', () => {
    const cases: Array<{ name: string; source: string; pattern: RegExp }> = [
      { name: 'unterminated table header', source: '[adapter\nkey = 1', pattern: /line 1/ },
      { name: 'dotted table name', source: '[adapter.extra]\nkey = 1', pattern: /line 1/ },
      { name: 'empty table name', source: '[]\nkey = 1', pattern: /line 1/ },
      { name: 'missing equals sign', source: '[budget]\nsoft_alert_usd 0.75', pattern: /line 2/ },
      { name: 'missing key', source: '[budget]\n= 0.75', pattern: /line 2/ },
      { name: 'missing value', source: '[budget]\nsoft_alert_usd =', pattern: /line 2/ },
      { name: 'garbage value', source: '[budget]\nsoft_alert_usd = nope', pattern: /line 2/ },
      { name: 'unterminated string', source: '[budget]\nmodel = "oops', pattern: /line 2/ },
      { name: 'trailing content after string', source: '[budget]\nmodel = "oops" tail', pattern: /line 2/ },
      { name: 'unsupported array value', source: '[budget]\nvalues = [1, 2]', pattern: /line 2/ },
      { name: 'duplicate key', source: '[budget]\nsoft_alert_usd = 0.5\nsoft_alert_usd = 0.6', pattern: /line 3/ },
    ];

    for (const testCase of cases) {
      assert.throws(() => parseToml(testCase.source), testCase.pattern, testCase.name);
    }
  });

  it('reports a descriptive message that includes the line', () => {
    const error = captureError(() => parseToml('[budget]\nnot a key value pair'));
    assert.match(error.message, /Invalid TOML at line 2/);
    assert.match(error.message, /expected 'key = value'/);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('matches the architecture §7 values', () => {
    assert.deepStrictEqual(DEFAULT_CONFIG, {
      adapter: {
        defaultCli: 'claude_code',
        injectionMode: 'system_prompt',
      },
      budget: {
        softAlertUsd: 0.75,
        hardStopUsd: 2.0,
        maxSingleTurnTokens: 25000,
      },
      loops: {
        maxSameErrorRetries: 3,
        maxSameFileReads: 4,
        minCacheHitRatio: 0.5,
      },
      distiller: {
        model: 'claude-haiku-4-5',
        maxSkillFileTokens: 800,
        minSessionsToPromote: 2,
        minSingleSessionWaste: 8000,
      },
    });
  });

  it('matches the shipped config.default.toml', () => {
    const source = readFileSync(new URL('../config.default.toml', import.meta.url), 'utf8');
    assert.deepStrictEqual(parseToml(source), {
      adapter: {
        default_cli: 'claude_code',
        injection_mode: 'system_prompt',
      },
      budget: {
        soft_alert_usd: 0.75,
        hard_stop_usd: 2.0,
        max_single_turn_tokens: 25000,
      },
      loops: {
        max_same_error_retries: 3,
        max_same_file_reads: 4,
        min_cache_hit_ratio: 0.5,
      },
      distiller: {
        model: 'claude-haiku-4-5',
        max_skill_file_tokens: 800,
        min_sessions_to_promote: 2,
        min_single_session_waste: 8000,
      },
    });
  });
});

describe('loadConfig', () => {
  it('returns the defaults when config files are missing', async () => {
    await withTempDir(async (dir) => {
      const config = loadConfig({
        globalConfigPath: join(dir, 'missing-global.toml'),
        repoConfigPath: join(dir, 'missing-repo.toml'),
      });
      assert.deepStrictEqual(config, DEFAULT_CONFIG);
      assert.notStrictEqual(config, DEFAULT_CONFIG);
    });
  });

  it('merges defaults -> global -> repo, with repo winning', async () => {
    await withTempDir(async (dir) => {
      const globalPath = join(dir, 'global.toml');
      const repoPath = join(dir, 'repo.toml');
      await writeFile(
        globalPath,
        ['[adapter]', 'default_cli = "codex"', '', '[budget]', 'soft_alert_usd = 1.5', '', '[loops]', 'max_same_file_reads = 9'].join('\n'),
        'utf8',
      );
      await writeFile(
        repoPath,
        ['[budget]', 'soft_alert_usd = 0.9', 'hard_stop_usd = 3.25', '', '[distiller]', 'model = "gpt-5-mini"'].join('\n'),
        'utf8',
      );

      const config = loadConfig({ globalConfigPath: globalPath, repoConfigPath: repoPath });

      assert.deepStrictEqual(config, {
        adapter: { defaultCli: 'codex', injectionMode: 'system_prompt' },
        budget: { softAlertUsd: 0.9, hardStopUsd: 3.25, maxSingleTurnTokens: 25000 },
        loops: { maxSameErrorRetries: 3, maxSameFileReads: 9, minCacheHitRatio: 0.5 },
        distiller: { model: 'gpt-5-mini', maxSkillFileTokens: 800, minSessionsToPromote: 2, minSingleSessionWaste: 8000 },
      });
    });
  });

  it('discovers the repo config under {repoRoot}/.loglode/config.toml', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = join(dir, 'repo');
      await mkdir(join(repoRoot, '.loglode'), { recursive: true });
      await writeFile(join(repoRoot, '.loglode', 'config.toml'), '[budget]\nmax_single_turn_tokens = 1234\n', 'utf8');

      const config = loadConfig({ repoRoot, globalConfigPath: join(dir, 'missing-global.toml') });
      assert.equal(config.budget.maxSingleTurnTokens, 1234);
      assert.equal(config.budget.softAlertUsd, DEFAULT_CONFIG.budget.softAlertUsd);
    });
  });

  it('prefers an explicit repoConfigPath over repoRoot', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = join(dir, 'repo');
      await mkdir(join(repoRoot, '.loglode'), { recursive: true });
      await writeFile(join(repoRoot, '.loglode', 'config.toml'), '[budget]\nsoft_alert_usd = 5\n', 'utf8');

      const explicitPath = join(dir, 'explicit.toml');
      await writeFile(explicitPath, '[budget]\nsoft_alert_usd = 0.25\n', 'utf8');

      const config = loadConfig({ repoRoot, globalConfigPath: join(dir, 'missing-global.toml'), repoConfigPath: explicitPath });
      assert.equal(config.budget.softAlertUsd, 0.25);
    });
  });

  it('ignores unknown keys and unknown tables', async () => {
    await withTempDir(async (dir) => {
      const globalPath = join(dir, 'global.toml');
      await writeFile(
        globalPath,
        ['[budget]', 'soft_alert_usd = 0.55', 'mystery_knob = 42', '', '[unknown_table]', 'whatever = true', '', '[adapter]', 'nope = "x"'].join('\n'),
        'utf8',
      );

      const config = loadConfig({ globalConfigPath: globalPath, repoConfigPath: join(dir, 'missing-repo.toml') });
      assert.equal(config.budget.softAlertUsd, 0.55);
      assert.equal(config.adapter.defaultCli, 'claude_code');
    });
  });

  it('does not mutate DEFAULT_CONFIG across loads', async () => {
    await withTempDir(async (dir) => {
      const globalPath = join(dir, 'global.toml');
      await writeFile(globalPath, '[budget]\nsoft_alert_usd = 99\n', 'utf8');

      const config = loadConfig({ globalConfigPath: globalPath, repoConfigPath: join(dir, 'missing-repo.toml') });
      assert.equal(config.budget.softAlertUsd, 99);
      config.budget.softAlertUsd = 123;
      assert.equal(DEFAULT_CONFIG.budget.softAlertUsd, 0.75);
    });
  });

  it('reports the file path for malformed TOML', async () => {
    await withTempDir(async (dir) => {
      const globalPath = join(dir, 'global.toml');
      await writeFile(globalPath, '[budget]\nnot a key value pair\n', 'utf8');

      const error = captureError(() => loadConfig({ globalConfigPath: globalPath, repoConfigPath: join(dir, 'missing-repo.toml') }));
      assert.match(error.message, /line 2/);
      assert.ok(error.message.includes(globalPath), `expected the error to name ${globalPath}: ${error.message}`);
    });
  });

  it('rejects an invalid adapter enum and a wrong value type', async () => {
    await withTempDir(async (dir) => {
      const globalPath = join(dir, 'global.toml');
      const repoPath = join(dir, 'missing-repo.toml');

      await writeFile(globalPath, '[adapter]\ndefault_cli = "aider"\n', 'utf8');
      assert.throws(() => loadConfig({ globalConfigPath: globalPath, repoConfigPath: repoPath }), /default_cli/);

      await writeFile(globalPath, '[budget]\nsoft_alert_usd = "0.75"\n', 'utf8');
      assert.throws(() => loadConfig({ globalConfigPath: globalPath, repoConfigPath: repoPath }), /must be a number/);
    });
  });
});
