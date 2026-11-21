import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { MicroSkillRecord, SessionRecord, ToolCallRecord, WasteFindingRecord } from './adapters/types.js';
import { parseCliArgs, runCli, type CliIo } from './cli.js';
import { resolveRepoContext } from './repo.js';
import type { LoglodeDb } from './store/db.js';
import { openStateDb } from './store/db.js';
import {
  getRecentSessions,
  getWasteFindingsForRepo,
  insertMicroSkill,
  insertSession,
  insertToolCall,
  insertWasteFindings,
  listAllMicroSkills,
} from './store/queries.js';
import { initTempGitRepo, withTempDir } from './testing/tmp.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

type CapturedIo = CliIo & { stdoutText(): string; stderrText(): string };

/** A Writable-backed fake terminal that records everything written to it. */
function makeIo(overrides: Partial<CliIo> = {}): CapturedIo {
  let stdoutText = '';
  let stderrText = '';

  const stdout = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      stdoutText += chunk.toString();
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      stderrText += chunk.toString();
      callback();
    },
  });

  return {
    ...overrides,
    stdout,
    stderr,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
  };
}

interface RepoHome {
  repo: string;
  home: string;
  repoHash: string;
}

/** A disposable git repo plus a disposable `LOGLODE_HOME`; both always cleaned up. */
async function withRepoHome<T>(fn: (ctx: RepoHome) => Promise<T>): Promise<T> {
  const repo = await initTempGitRepo();
  try {
    return await withTempDir(async (home) => {
      const context = await resolveRepoContext(repo);
      return await fn({ repo, home, repoHash: context.repoHash });
    });
  } finally {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

/** Seed the state DB through the store API, then close it before the CLI opens it. */
function seedState(home: string, repoHash: string, seed: (db: LoglodeDb) => void): void {
  const db = openStateDb(repoHash, { basePath: home });
  try {
    seed(db);
  } finally {
    db.close();
  }
}

function readState<T>(home: string, repoHash: string, read: (db: LoglodeDb) => T): T {
  const db = openStateDb(repoHash, { basePath: home });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const REPO_HASH = 'cafebabe';

/** Environment for the CLI under test: no provider keys, so nothing can go online. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

/**
 * A hermetic `CliIo`: temp cwd + state root, and config paths pinned inside them
 * so a developer's real `~/.loglode/config.toml` can never influence a test.
 */
function cliIo(repo: string, home: string, extraEnv: NodeJS.ProcessEnv = {}): CapturedIo {
  return makeIo({
    cwd: repo,
    env: cleanEnv({ LOGLODE_HOME: home, ...extraEnv }),
    configPaths: {
      globalConfigPath: join(home, '.loglode', 'config.toml'),
      repoConfigPath: join(repo, '.loglode', 'config.toml'),
    },
  });
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'testing', 'fixtures');
const FAKE_CLAUDE = join(FIXTURES_DIR, 'fake-claude.mjs');

/**
 * One-request fake Anthropic upstream: an SSE body whose frames carry 1M input
 * and 100 output tokens, so the proxy has exact usage to record.
 */
function startFakeAnthropic(): Promise<{ baseUrl: string; requests(): number; close(): Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests += 1;
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_fake',
              type: 'message',
              role: 'assistant',
              usage: { input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
            },
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 100 } })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address !== 'object') {
        reject(new Error('fake upstream did not bind to a TCP port'));
        return;
      }
      resolvePromise({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests: () => requests,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            server.closeAllConnections();
          }),
      });
    });
  });
}

async function gitRun(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolvePromise(String(stdout).trim());
      },
    );
  });
}

async function writeRepoFile(repo: string, relativePath: string, content: string): Promise<void> {
  const absolute = join(repo, ...relativePath.split('/'));
  await fs.mkdir(dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
}

async function commitAll(repo: string, message: string): Promise<string> {
  await gitRun(repo, ['add', '-A']);
  await gitRun(repo, ['commit', '-m', message]);
  return gitRun(repo, ['rev-parse', 'HEAD']);
}

function sessionRecord(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  const base: SessionRecord = {
    id: overrides.id,
    repoHash: REPO_HASH,
    cliTool: 'claude_code',
    taskPromptHash: null,
    gitHeadStart: 'deadbeef',
    skillVersionId: 3,
    status: 'completed',
    inputTokens: 1_000,
    cacheReadTokens: 200,
    cacheWriteTokens: 50,
    outputTokens: 300,
    estimatedCostUsd: 0.0125,
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: '2026-01-01T10:05:00.000Z',
  };
  return { ...base, ...overrides };
}

function skillRecord(overrides: Partial<MicroSkillRecord> & { skillKey: string }): MicroSkillRecord {
  const base: MicroSkillRecord = {
    id: null,
    repoHash: REPO_HASH,
    skillKey: overrides.skillKey,
    ruleText: 'Run pytest with -q --tb=short.',
    tokenCount: 12,
    linkedPathsJson: null,
    sourceSessions: 2,
    estimatedSavings: 900,
    lastValidatedCommit: null,
    active: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function findingRecord(overrides: Partial<WasteFindingRecord> & { signature: string; sessionId: string }): WasteFindingRecord {
  const base: WasteFindingRecord = {
    repoHash: REPO_HASH,
    sessionId: overrides.sessionId,
    patternType: 'repeat_read',
    signature: overrides.signature,
    occurrences: 3,
    wastedTokens: 120,
    evidenceJson: '{"targetPath":"src/app.ts"}',
  };
  return { ...base, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* parseCliArgs                                                                */
/* -------------------------------------------------------------------------- */

describe('parseCliArgs', () => {
  it('shows help for no arguments, --help, -h and version', () => {
    assert.deepEqual(parseCliArgs([]), { kind: 'help' });
    assert.deepEqual(parseCliArgs(['--help']), { kind: 'help' });
    assert.deepEqual(parseCliArgs(['-h']), { kind: 'help' });
    assert.deepEqual(parseCliArgs(['run', '--help', '--', 'x']), { kind: 'help' });
    assert.deepEqual(parseCliArgs(['--version']), { kind: 'version' });
    assert.deepEqual(parseCliArgs(['report', '--version']), { kind: 'version' });
  });

  it('parses a bare run with agent args after --', () => {
    const parsed = parseCliArgs(['run', '--', 'claude', '-p', 'fix the bug']);
    assert.deepEqual(parsed, {
      kind: 'run',
      noInject: false,
      noKill: false,
      agentArgs: ['claude', '-p', 'fix the bug'],
    });
  });

  it('parses every run flag', () => {
    const parsed = parseCliArgs([
      'run',
      '--cli',
      'codex',
      '--no-inject',
      '--no-kill',
      '--budget',
      '1.5',
      '--',
      'exec',
      'do the thing',
    ]);
    assert.deepEqual(parsed, {
      kind: 'run',
      cli: 'codex',
      noInject: true,
      noKill: true,
      budgetUsd: 1.5,
      agentArgs: ['exec', 'do the thing'],
    });
  });

  it('keeps flags inside the agent args verbatim', () => {
    const parsed = parseCliArgs(['run', '--no-inject', '--', '--model', 'x', '--print']);
    assert.equal(parsed.kind, 'run');
    if (parsed.kind !== 'run') return;
    assert.deepEqual(parsed.agentArgs, ['--model', 'x', '--print']);
    assert.equal(parsed.noInject, true);
  });

  it('requires the agent command after --', () => {
    for (const argv of [['run'], ['run', '--no-inject'], ['run', '--cli', 'claude'], ['run', '--']]) {
      const parsed = parseCliArgs(argv);
      assert.equal(parsed.kind, 'error', `expected an error for ${JSON.stringify(argv)}`);
      if (parsed.kind !== 'error') return;
      assert.equal(parsed.message, "run requires the agent command after '--'");
    }
  });

  it('rejects unknown run flags and bad flag values', () => {
    for (const argv of [
      ['run', '--bogus', '--', 'x'],
      ['run', '--cli', 'gemini', '--', 'x'],
      ['run', '--budget', 'lots', '--', 'x'],
      ['run', '--budget', '-1', '--', 'x'],
      ['run', '--cli'],
    ]) {
      assert.equal(parseCliArgs(argv).kind, 'error', `expected an error for ${JSON.stringify(argv)}`);
    }
  });

  it('parses report flags', () => {
    assert.deepEqual(parseCliArgs(['report']), { kind: 'report' });
    assert.deepEqual(parseCliArgs(['report', '--last', '5']), { kind: 'report', last: 5 });
    assert.deepEqual(parseCliArgs(['report', '--session', 'abc123']), {
      kind: 'report',
      session: 'abc123',
    });
    assert.equal(parseCliArgs(['report', '--last', '0']).kind, 'error');
    assert.equal(parseCliArgs(['report', '--nope']).kind, 'error');
  });

  it('parses skills subcommands, with bare skills meaning list', () => {
    assert.deepEqual(parseCliArgs(['skills']), { kind: 'skills', sub: 'list' });
    for (const sub of ['list', 'edit', 'prune', 'reset'] as const) {
      assert.deepEqual(parseCliArgs(['skills', sub]), { kind: 'skills', sub });
    }
    assert.equal(parseCliArgs(['skills', 'nuke']).kind, 'error');
    assert.equal(parseCliArgs(['skills', 'list', 'extra']).kind, 'error');
  });

  it('parses mine flags', () => {
    assert.deepEqual(parseCliArgs(['mine']), { kind: 'mine', dryRun: false });
    assert.deepEqual(parseCliArgs(['mine', '--window', '3', '--dry-run']), {
      kind: 'mine',
      window: 3,
      dryRun: true,
    });
    assert.equal(parseCliArgs(['mine', '--window', '-2']).kind, 'error');
    assert.equal(parseCliArgs(['mine', '--bogus']).kind, 'error');
  });

  it('parses eval flags and requires --suite', () => {
    assert.deepEqual(parseCliArgs(['eval', '--suite', 'tasks.yaml']), {
      kind: 'eval',
      suite: 'tasks.yaml',
    });
    assert.deepEqual(
      parseCliArgs([
        'eval',
        '--suite',
        'tasks.yaml',
        '--base-commit',
        'abc123',
        '--csv',
        'out.csv',
        '--test-cmd',
        'npm test',
      ]),
      {
        kind: 'eval',
        suite: 'tasks.yaml',
        baseCommit: 'abc123',
        csvPath: 'out.csv',
        testCmd: 'npm test',
      },
    );

    const missing = parseCliArgs(['eval']);
    assert.equal(missing.kind, 'error');
    if (missing.kind !== 'error') return;
    assert.match(missing.message, /--suite/);
  });

  it('rejects unknown commands and options', () => {
    const unknownCommand = parseCliArgs(['bogus']);
    assert.equal(unknownCommand.kind, 'error');
    if (unknownCommand.kind !== 'error') return;
    assert.match(unknownCommand.message, /unknown command 'bogus'/);

    assert.equal(parseCliArgs(['--bogus']).kind, 'error');
  });
});

/* -------------------------------------------------------------------------- */
/* runCli                                                                      */
/* -------------------------------------------------------------------------- */

describe('runCli', () => {
  it('prints usage for --help and the package version for --version', async () => {
    const helpIo = makeIo();
    assert.equal(await runCli(['--help'], helpIo), 0);
    assert.match(helpIo.stdoutText(), /Usage:/);
    assert.match(helpIo.stdoutText(), /loglode run/);

    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    const versionIo = makeIo();
    assert.equal(await runCli(['--version'], versionIo), 0);
    assert.equal(versionIo.stdoutText().trim(), pkg.version);
  });

  it('returns exit code 2 and a usage message for bad arguments', async () => {
    const io = makeIo();
    const code = await runCli(['bogus'], io);
    assert.equal(code, 2);
    assert.match(io.stderrText(), /unknown command 'bogus'/);
    assert.match(io.stderrText(), /Usage:/);

    const runIo = makeIo();
    assert.equal(await runCli(['run'], runIo), 2);
    assert.match(runIo.stderrText(), /run requires the agent command after '--'/);
  });

  it('returns exit code 1 outside a git repository', async () => {
    // A plain temp directory: `git rev-parse` walks up and finds no `.git`.
    await withTempDir(async (dir) => {
      const io = makeIo({ cwd: dir, env: { ...process.env } });
      const code = await runCli(['report'], io);
      assert.equal(code, 1);
      assert.match(io.stderrText(), /not inside a git repository/i);
    });
  });

  it('runs an agent end-to-end and prints a one-line summary', { timeout: 60_000 }, async () => {
    await withRepoHome(async ({ repo, home, repoHash }) => {
      await writeRepoFile(repo, 'src/app.ts', 'export function app(): string {\n  return "ok";\n}\n');
      await commitAll(repo, 'add app');

      const upstream = await startFakeAnthropic();
      try {
        // `LOGLODE_CLAUDE_BIN` is the documented Windows escape hatch: point it at
        // node and the fixture script becomes the "claude" the pipeline launches.
        const io = cliIo(repo, home, {
          LOGLODE_CLAUDE_BIN: process.execPath,
          ANTHROPIC_BASE_URL: upstream.baseUrl,
          FAKE_REPO_ROOT: repo,
        });
        const code = await runCli(['run', '--no-inject', '--', FAKE_CLAUDE], io);

        assert.equal(code, 0);
        assert.match(io.stdoutText(), /session [0-9a-f-]{36} completed/);
        assert.match(io.stdoutText(), /in 1000000 \/ out 100 tokens, \$1\.0005/);
        // Transparent passthrough: the raw stream-json frames reach CLI stdout.
        assert.match(io.stdoutText(), /"type":"system"/);
        assert.match(io.stdoutText(), /"type":"result"/);
        assert.equal(upstream.requests(), 1);

        const sessions = readState(home, repoHash, (db) => getRecentSessions(db, repoHash, 5));
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0]?.status, 'completed');
        assert.equal(sessions[0]?.inputTokens, 1_000_000);
        assert.equal(sessions[0]?.outputTokens, 100);
        assert.equal(sessions[0]?.skillVersionId, null);
      } finally {
        await upstream.close();
      }
    });
  });

  it('returns exit code 2 for a missing or unparseable eval suite', async () => {
    await withRepoHome(async ({ repo, home }) => {
      const missingIo = cliIo(repo, home);
      assert.equal(await runCli(['eval', '--suite', 'missing.yaml'], missingIo), 2);
      assert.match(missingIo.stderrText(), /cannot read task suite/);

      await writeRepoFile(repo, 'tasks.yaml', 'this is not a task list\n');
      const invalidIo = cliIo(repo, home);
      assert.equal(await runCli(['eval', '--suite', 'tasks.yaml'], invalidIo), 2);
      assert.match(invalidIo.stderrText(), /invalid task suite/);
    });
  });

  it('lists skills in an aligned table', async () => {
    await withRepoHome(async ({ repo, home, repoHash }) => {
      seedState(home, repoHash, (db) => {
        insertMicroSkill(db, skillRecord({ repoHash, skillKey: 'cmd-pytest-flags' }));
        insertMicroSkill(db, skillRecord({ repoHash, skillKey: 'nav-schemas', tokenCount: 30, active: 0 }));
      });

      const io = cliIo(repo, home);
      const code = await runCli(['skills', 'list'], io);

      assert.equal(code, 0);
      const text = io.stdoutText();
      assert.match(text, /cmd-pytest-flags/);
      assert.match(text, /nav-schemas/);
      assert.match(text, /tokens\s+active/);
      // The active column distinguishes the live rule from the retired one.
      assert.match(text, /cmd-pytest-flags\s+12\s+yes\s+900\s+0/);
      assert.match(text, /nav-schemas\s+30\s+no\s+900\s+0/);
    });
  });

  it('reports the last sessions with tokens, cost, and top findings', async () => {
    await withRepoHome(async ({ repo, home, repoHash }) => {
      const olderId = '11111111-aaaa-4aaa-8aaa-111111111111';
      const newerId = '22222222-bbbb-4bbb-8bbb-222222222222';
      seedState(home, repoHash, (db) => {
        insertSession(
          db,
          sessionRecord({
            id: olderId,
            repoHash,
            status: 'aborted_budget',
            inputTokens: 10,
            cacheReadTokens: 1,
            cacheWriteTokens: 2,
            outputTokens: 3,
            estimatedCostUsd: 0.5,
            startedAt: '2026-01-01T10:00:00.000Z',
          }),
        );
        insertSession(
          db,
          sessionRecord({
            id: newerId,
            repoHash,
            cliTool: 'codex',
            inputTokens: 4_000,
            cacheReadTokens: 500,
            cacheWriteTokens: 0,
            outputTokens: 700,
            estimatedCostUsd: 0.03125,
            startedAt: '2026-01-02T10:00:00.000Z',
          }),
        );
        insertWasteFindings(db, [
          findingRecord({ repoHash, sessionId: newerId, signature: 'repeat_read:src/app.ts', wastedTokens: 900 }),
          findingRecord({ repoHash, sessionId: olderId, signature: 'fail_loop:pytest', wastedTokens: 300 }),
        ]);
      });

      const io = cliIo(repo, home);
      const code = await runCli(['report', '--last', '5'], io);

      assert.equal(code, 0);
      const text = io.stdoutText();
      // Rows are newest-first and show the 8-char id, cli, status and token split.
      assert.match(text, /11111111\s+claude_code\s+aborted_budget\s+10\s+1\s+2\s+3\s+\$0\.5000/);
      assert.match(text, /22222222\s+codex\s+completed\s+4000\s+500\s+0\s+700\s+\$0\.0313/);
      assert.ok(text.indexOf('22222222') < text.indexOf('11111111'), 'newest session must be listed first');
      // Top findings are ordered by wasted tokens.
      assert.match(text, /Top waste findings:/);
      assert.match(text, /repeat_read:src\/app\.ts\s+occurrences=3\s+wasted=900/);
      assert.ok(text.indexOf('wasted=900') < text.indexOf('wasted=300'));
    });
  });

  it('reports a single session in detail, with its own findings', async () => {
    await withRepoHome(async ({ repo, home, repoHash }) => {
      const sessionId = '33333333-cccc-4ccc-8ccc-333333333333';
      seedState(home, repoHash, (db) => {
        insertSession(db, sessionRecord({ id: sessionId, repoHash, status: 'failed' }));
        insertWasteFindings(db, [
          findingRecord({ repoHash, sessionId, signature: 'log_flood:pnpm-lock.yaml', wastedTokens: 12_000 }),
        ]);
      });

      const io = cliIo(repo, home);
      assert.equal(await runCli(['report', '--session', sessionId], io), 0);
      const text = io.stdoutText();
      assert.match(text, new RegExp(`session ${sessionId}`));
      assert.match(text, /status:\s+failed/);
      assert.match(text, /log_flood:pnpm-lock\.yaml/);

      const missingIo = cliIo(repo, home);
      assert.equal(await runCli(['report', '--session', 'nope'], missingIo), 1);
      assert.match(missingIo.stderrText(), /not found/);
    });
  });

  it('creates the skills file on edit and empties it on reset', async () => {
    await withRepoHome(async ({ repo, home, repoHash }) => {
      seedState(home, repoHash, (db) => {
        insertMicroSkill(db, skillRecord({ repoHash, skillKey: 'cmd-pytest-flags', ruleText: 'Use -q --tb=short.' }));
      });

      const skillsPath = join(repo, '.loglode', 'micro-skills.md');
      assert.equal(existsSync(skillsPath), false);

      const editIo = cliIo(repo, home);
      assert.equal(await runCli(['skills', 'edit'], editIo), 0);
      assert.equal(existsSync(skillsPath), true);
      assert.match(editIo.stdoutText(), /micro-skills\.md/);
      assert.match(editIo.stdoutText(), /hint:/);
      const created = await fs.readFile(skillsPath, 'utf8');
      assert.match(created, /version: 1/);
      assert.match(created, /- Use -q --tb=short\./);

      const resetIo = cliIo(repo, home);
      assert.equal(await runCli(['skills', 'reset'], resetIo), 0);
      assert.match(resetIo.stdoutText(), /deactivated 1 micro-skill/);

      const after = readState(home, repoHash, (db) => listAllMicroSkills(db, repoHash));
      assert.equal(after.length, 1);
      assert.equal(after[0]?.active, 0);

      const reset = await fs.readFile(skillsPath, 'utf8');
      assert.match(reset, /version: 2/);
      assert.doesNotMatch(reset, /- Use -q --tb=short\./);
    });
  });

  it('prunes stale skills and enforces the token ceiling', async () => {
    await withRepoHome(async ({ repo, home, repoHash }) => {
      // History: base commit has both files, HEAD deleted one of them.
      await writeRepoFile(repo, 'src/keep.ts', 'export const keep = 1;\n');
      await commitAll(repo, 'add keep');
      await writeRepoFile(repo, 'src/gone.ts', 'export const gone = 1;\n');
      const baseCommit = await commitAll(repo, 'add gone');
      await fs.rm(join(repo, 'src', 'gone.ts'));
      await commitAll(repo, 'delete gone');

      seedState(home, repoHash, (db) => {
        insertMicroSkill(
          db,
          skillRecord({
            repoHash,
            skillKey: 'nav-gone',
            ruleText: 'Read src/gone.ts for the schema.',
            tokenCount: 10,
            estimatedSavings: 100,
            linkedPathsJson: '["src/gone.ts"]',
            lastValidatedCommit: baseCommit,
          }),
        );
        // Token count above the ceiling with zero savings: the ROI eviction victim.
        insertMicroSkill(
          db,
          skillRecord({
            repoHash,
            skillKey: 'cmd-huge',
            ruleText: 'A very expensive rule.',
            tokenCount: 900,
            estimatedSavings: 0,
          }),
        );
        insertMicroSkill(
          db,
          skillRecord({
            repoHash,
            skillKey: 'cmd-small',
            ruleText: 'Keep the small cheap rule.',
            tokenCount: 10,
            estimatedSavings: 1_000,
          }),
        );
      });

      const io = cliIo(repo, home);
      assert.equal(await runCli(['skills', 'prune'], io), 0);
      const text = io.stdoutText();
      assert.match(text, /retired nav-gone \(deleted: src\/gone\.ts\)/);
      assert.match(text, /retired cmd-huge \(token ceiling 800/);
      assert.match(text, /pruned: 1 stale \+ 1 token-ceiling skill\(s\) retired/);

      const skills = readState(home, repoHash, (db) => listAllMicroSkills(db, repoHash));
      assert.equal(skills.find((skill) => skill.skillKey === 'nav-gone')?.active, 0);
      assert.equal(skills.find((skill) => skill.skillKey === 'cmd-huge')?.active, 0);
      assert.equal(skills.find((skill) => skill.skillKey === 'cmd-small')?.active, 1);

      const artifact = await fs.readFile(join(repo, '.loglode', 'micro-skills.md'), 'utf8');
      assert.match(artifact, /- Keep the small cheap rule\./);
      assert.doesNotMatch(artifact, /A very expensive rule\./);
      assert.doesNotMatch(artifact, /src\/gone\.ts for the schema/);
    });
  });

  it('mines on demand without persisting in dry-run mode', async () => {
    await withRepoHome(async ({ repo, home, repoHash }) => {
      const sessionId = '44444444-dddd-4ddd-8ddd-444444444444';
      seedState(home, repoHash, (db) => {
        insertSession(db, sessionRecord({ id: sessionId, repoHash }));
        // Three reads of the same path with no edit: a repeat_read finding.
        for (let turn = 1; turn <= 3; turn += 1) {
          const call: ToolCallRecord = {
            sessionId,
            turnIndex: turn,
            toolName: 'read_file',
            targetPath: 'src/app.ts',
            commandSignature: null,
            exitCode: null,
            outputTokens: 100,
            errorFingerprint: null,
            createdAt: '2026-01-01T10:00:00.000Z',
          };
          insertToolCall(db, call);
        }
      });

      const dryIo = cliIo(repo, home);
      assert.equal(await runCli(['mine', '--window', '5', '--dry-run'], dryIo), 0);
      assert.match(dryIo.stdoutText(), /repeat_read:src\/app\.ts/);
      assert.match(dryIo.stdoutText(), /dry run: not persisted/);
      assert.doesNotMatch(dryIo.stdoutText(), /distiller:/, 'a dry run must not distill');
      assert.equal(
        readState(home, repoHash, (db) => getWasteFindingsForRepo(db, repoHash).length),
        0,
        'dry-run must not persist findings',
      );

      const realIo = cliIo(repo, home);
      assert.equal(await runCli(['mine', '--window', '5'], realIo), 0);
      assert.match(realIo.stdoutText(), /persisted/);
      // No key in cleanEnv: the distiller is skipped, never called.
      assert.match(realIo.stdoutText(), /distiller skipped: ANTHROPIC_API_KEY is not set/);
      assert.equal(readState(home, repoHash, (db) => getWasteFindingsForRepo(db, repoHash).length), 1);
    });
  });
});
