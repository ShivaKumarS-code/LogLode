import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { CliTool, MicroSkillRecord, ToolCallRecord } from '../adapters/types.js';
import { readManagedBlock } from '../adapters/codexCli.js';
import { runCli } from '../cli.js';
import { DEFAULT_CONFIG } from '../config.js';
import { resolveRepoContext } from '../repo.js';
import type { LoglodeDb } from '../store/db.js';
import { openStateDb } from '../store/db.js';
import {
  getRecentSessions,
  getToolCallsForSessions,
  getWasteFindingsBySignature,
  getWasteFindingsForRepo,
  insertMicroSkill,
  insertSession,
  insertToolCall,
  insertWasteFindings,
  listAllMicroSkills,
  listActiveMicroSkills,
} from '../store/queries.js';
import { initTempGitRepo, withTempDir } from '../testing/tmp.js';
import { runSession, type RunSessionResult } from './pipeline.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fixtures');
const FAKE_CLAUDE = join(FIXTURES_DIR, 'fake-claude.mjs');
const FAKE_CODEX = join(FIXTURES_DIR, 'fake-codex.mjs');

/** 1M input tokens at Haiku pricing + 100 output tokens. */
const EXPECTED_ANTHROPIC_INPUT = 1_000_000;
const EXPECTED_ANTHROPIC_OUTPUT = 100;
/** 1M * $1/M + 100 * $5/M. */
const EXPECTED_ANTHROPIC_SPEND = 1.0005;

interface Captured {
  stream: NodeJS.WritableStream;
  text(): string;
}

function capture(): Captured {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

interface FakeUpstream {
  baseUrl: string;
  requestCount(): number;
  close(): Promise<void>;
}

/**
 * Minimal provider stand-in. Anthropic answers with an SSE stream whose frames
 * carry exactly the usage the proxy should capture (1M input, 100 output);
 * OpenAI answers with a non-streaming JSON body (2000 prompt incl. 500 cached,
 * 300 completion).
 */
function startFakeUpstream(kind: 'anthropic' | 'openai'): Promise<FakeUpstream> {
  return new Promise<FakeUpstream>((resolve, reject) => {
    let requests = 0;

    const server: Server = createServer((req, res) => {
      requests += 1;
      // Drain the forwarded request body before answering.
      req.on('data', () => undefined);
      req.on('end', () => {
        if (kind === 'anthropic') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const frame = (event: unknown): void => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          };
          frame({
            type: 'message_start',
            message: {
              id: 'msg_fake',
              type: 'message',
              role: 'assistant',
              usage: {
                input_tokens: EXPECTED_ANTHROPIC_INPUT,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 0,
              },
            },
          });
          frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
          frame({ type: 'content_block_stop', index: 0 });
          frame({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: EXPECTED_ANTHROPIC_OUTPUT },
          });
          frame({ type: 'message_stop' });
          res.end();
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            model: 'gpt-5-mini',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 2_000,
              completion_tokens: 300,
              total_tokens: 2_300,
              prompt_tokens_details: { cached_tokens: 500 },
            },
          }),
        );
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address !== 'object') {
        reject(new Error('fake upstream did not bind to a TCP port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requestCount: () => requests,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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
        resolve(String(stdout).trim());
      },
    );
  });
}

async function writeFile(repo: string, relativePath: string, content: string): Promise<void> {
  const absolute = join(repo, ...relativePath.split('/'));
  await fs.mkdir(dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
}

/** `git add -A && git commit`, returning the new HEAD. */
async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** Parent env scrubbed of anything that could reach the real providers. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.OPENAI_BASE_URL;
  return env;
}

interface Harness {
  repo: string;
  home: string;
  repoHash: string;
  upstream: FakeUpstream;
}

async function withHarness(kind: 'anthropic' | 'openai', fn: (harness: Harness) => Promise<void>): Promise<void> {
  const repo = await initTempGitRepo();
  try {
    await withTempDir(async (home) => {
      const context = await resolveRepoContext(repo);
      const upstream = await startFakeUpstream(kind);
      try {
        await fn({ repo, home, repoHash: context.repoHash, upstream });
      } finally {
        await upstream.close();
      }
    });
  } finally {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

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

function skillRecord(repoHash: string, overrides: Partial<MicroSkillRecord> & { skillKey: string }): MicroSkillRecord {
  const base: MicroSkillRecord = {
    id: null,
    repoHash,
    skillKey: overrides.skillKey,
    ruleText: 'Run pytest with -q --tb=short; bare pytest boots integration containers.',
    tokenCount: 20,
    linkedPathsJson: null,
    sourceSessions: 2,
    estimatedSavings: 900,
    lastValidatedCommit: null,
    active: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

/** Seed one completed session plus its tool calls, outside the pipeline. */
function seedSessionWithCalls(
  db: LoglodeDb,
  repoHash: string,
  sessionId: string,
  startedAt: string,
  toolCalls: ToolCallRecord[],
): void {
  insertSession(db, {
    id: sessionId,
    repoHash,
    cliTool: 'claude_code',
    taskPromptHash: null,
    gitHeadStart: null,
    skillVersionId: null,
    status: 'completed',
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    startedAt,
    endedAt: startedAt,
  });
  for (const call of toolCalls) {
    insertToolCall(db, call);
  }
}

/** A failed shell command; two of these with the same signature mine as `fail_loop`. */
function failedBashCall(sessionId: string, turnIndex: number): ToolCallRecord {
  return {
    sessionId,
    turnIndex,
    toolName: 'bash',
    targetPath: null,
    commandSignature: 'pytest -q',
    exitCode: 1,
    outputTokens: 100,
    errorFingerprint: null,
    createdAt: '2020-01-01T00:00:00.000Z',
  };
}

/** A repo-relative read, which the detector treats as a read (not an edit). */
function readCall(sessionId: string, turnIndex: number, targetPath = 'src/app.ts'): ToolCallRecord {
  return {
    sessionId,
    turnIndex,
    toolName: 'read_file',
    targetPath,
    commandSignature: null,
    exitCode: null,
    outputTokens: 100,
    errorFingerprint: null,
    createdAt: '2020-01-01T00:00:00.000Z',
  };
}

interface RunOptionsOverrides {
  cli?: CliTool;
  agentArgs?: string[];
  noInject?: boolean;
  noKill?: boolean;
  budgetUsd?: number | null;
  parentEnv?: NodeJS.ProcessEnv;
  command?: string;
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
}

function runFixtureSession(harness: Harness, overrides: RunOptionsOverrides = {}): Promise<RunSessionResult> {
  const cli = overrides.cli ?? 'claude_code';
  // Default to throwaway capture streams so tests never interleave fixture output
  // with the test runner's own console.
  const io = overrides.io ?? { stdout: capture().stream, stderr: capture().stream };
  return runSession({
    cli,
    agentArgs: overrides.agentArgs ?? [cli === 'codex' ? FAKE_CODEX : FAKE_CLAUDE],
    repoRoot: harness.repo,
    repoHash: harness.repoHash,
    noInject: overrides.noInject ?? false,
    noKill: overrides.noKill ?? false,
    budgetUsd: overrides.budgetUsd ?? null,
    config: DEFAULT_CONFIG,
    basePath: harness.home,
    parentEnv: overrides.parentEnv ?? {
      ...baseEnv(),
      FAKE_REPO_ROOT: harness.repo,
      ...(cli === 'codex'
        ? { OPENAI_BASE_URL: harness.upstream.baseUrl }
        : { ANTHROPIC_BASE_URL: harness.upstream.baseUrl }),
    },
    command: overrides.command ?? process.execPath,
    // No key: Stage 5 must skip the LLM and never touch the network.
    distillerApiKey: null,
    io,
  });
}

/* -------------------------------------------------------------------------- */
/* Claude Code happy path                                                      */
/* -------------------------------------------------------------------------- */

describe('runSession — Claude Code', () => {
  it(
    'captures proxy usage, injects skills, relativizes tool paths and passes stdout through',
    { timeout: 30_000 },
    async () => {
      await withHarness('anthropic', async (harness) => {
        await writeFile(harness.repo, 'src/app.ts', 'export function app(): string {\n  return "ok";\n}\n');
        await commitAll(harness.repo, 'add app');

        seedState(harness.home, harness.repoHash, (db) => {
          insertMicroSkill(
            db,
            skillRecord(harness.repoHash, {
              skillKey: 'cmd-pytest-flags',
              linkedPathsJson: '["src/app.ts"]',
            }),
          );
        });

        const out = capture();
        const err = capture();
        // The fake upstream is listening before/after; any extra TCP server handle
        // left behind by the run would be the token proxy that never closed.
        const serversBefore = process
          .getActiveResourcesInfo()
          .filter((resource) => resource === 'TCPServerWrap').length;
        const result = await runFixtureSession(harness, { io: { stdout: out.stream, stderr: err.stream } });
        await delay(25);
        assert.equal(
          process.getActiveResourcesInfo().filter((resource) => resource === 'TCPServerWrap').length,
          serversBefore,
          'the token proxy must release its loopback port before runSession resolves',
        );

        assert.equal(result.status, 'completed');
        assert.equal(result.childExitCode, 0);
        assert.deepEqual(result.usage, {
          inputTokens: EXPECTED_ANTHROPIC_INPUT,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: EXPECTED_ANTHROPIC_OUTPUT,
        });
        assert.ok(
          Math.abs(result.spendUsd - EXPECTED_ANTHROPIC_SPEND) < 1e-9,
          `expected $${EXPECTED_ANTHROPIC_SPEND}, got $${result.spendUsd}`,
        );
        assert.equal(result.skillVersionId, 1);
        assert.equal(result.skillsFilePath, join(harness.repo, '.loglode', 'micro-skills.md'));
        assert.ok(result.minedFindings >= 0);
        assert.equal(result.breaches.some((breach) => breach.kind === 'hard_stop'), false);
        assert.equal(harness.upstream.requestCount(), 1);

        // Transparent passthrough of every raw stream-json line.
        assert.match(out.text(), /"type":"system"/);
        assert.match(out.text(), /"subtype":"init"/);
        assert.match(out.text(), /"type":"result"/);
        assert.match(out.text(), /toolu_read_01/);

        // The artifact is the injected file and carries the seeded rule.
        assert.ok(result.skillsFilePath !== null);
        const artifact = await fs.readFile(result.skillsFilePath, 'utf8');
        assert.match(artifact, /^---\n/);
        assert.match(artifact, new RegExp(`repo_hash: ${harness.repoHash}`));
        assert.match(artifact, /version: 1/);
        assert.match(artifact, /- Run pytest with -q --tb=short/);
        assert.match(artifact, /last_commit: [0-9a-f]{7,}/);

        const sessions = readState(harness.home, harness.repoHash, (db) =>
          getRecentSessions(db, harness.repoHash, 10),
        );
        assert.equal(sessions.length, 1);
        const session = sessions[0];
        assert.ok(session !== undefined);
        assert.equal(session.id, result.sessionId);
        assert.equal(session.status, 'completed');
        assert.equal(session.cliTool, 'claude_code');
        assert.equal(session.skillVersionId, 1);
        assert.equal(session.inputTokens, EXPECTED_ANTHROPIC_INPUT);
        assert.equal(session.outputTokens, EXPECTED_ANTHROPIC_OUTPUT);
        assert.equal(session.estimatedCostUsd, result.spendUsd);
        assert.equal(session.endedAt !== null, true);
        assert.equal(session.gitHeadStart, await git(harness.repo, ['rev-parse', 'HEAD']));

        const calls = readState(harness.home, harness.repoHash, (db) =>
          getToolCallsForSessions(db, [result.sessionId]),
        );
        assert.equal(calls.length, 3);
        const paths = calls.map((call) => call.targetPath);
        assert.equal(paths.filter((path) => path === 'src/app.ts').length, 2, 'read and edit are both repo-relative');
        assert.ok(
          paths.every((path) => path === null || !path.startsWith(harness.repo.replace(/\\/g, '/'))),
          `expected no absolute repo paths, got ${JSON.stringify(paths)}`,
        );

        const bash = calls.find((call) => call.toolName === 'Bash');
        assert.ok(bash !== undefined);
        assert.equal(bash.commandSignature, 'pytest -q --tb=short');
        assert.ok(bash.outputTokens !== null && bash.outputTokens > 0);
        assert.ok(bash.errorFingerprint !== null, 'the failing Bash result must be fingerprinted');
      });
    },
  );

  it(
    'records a baseline --no-inject run without a skill file or version',
    { timeout: 30_000 },
    async () => {
      await withHarness('anthropic', async (harness) => {
        await writeFile(harness.repo, 'src/app.ts', 'export function app(): string {\n  return "ok";\n}\n');
        await commitAll(harness.repo, 'add app');

        seedState(harness.home, harness.repoHash, (db) => {
          insertMicroSkill(db, skillRecord(harness.repoHash, { skillKey: 'cmd-pytest-flags' }));
        });

        const result = await runFixtureSession(harness, { noInject: true });

        assert.equal(result.status, 'completed');
        assert.equal(result.skillVersionId, null);
        assert.equal(result.skillsFilePath, null);
        assert.equal(existsSync(join(harness.repo, '.loglode', 'micro-skills.md')), false);
        assert.equal(result.usage.inputTokens, EXPECTED_ANTHROPIC_INPUT);

        const sessions = readState(harness.home, harness.repoHash, (db) =>
          getRecentSessions(db, harness.repoHash, 1),
        );
        assert.equal(sessions[0]?.skillVersionId, null);

        // Stage 5 skip: no key means a documented note and no crash.
        const notes = result.distillNotes.join('\n');
        assert.match(notes, /skipped/i);
        assert.match(notes, /ANTHROPIC_API_KEY/);
      });
    },
  );

  it(
    'auto-retires a skill whose linked path was deleted before injecting',
    { timeout: 30_000 },
    async () => {
      await withHarness('anthropic', async (harness) => {
        await writeFile(harness.repo, 'src/keep.ts', 'export const keep = 1;\n');
        await commitAll(harness.repo, 'add keep');
        await writeFile(harness.repo, 'src/gone.ts', 'export const gone = 1;\n');
        const baseCommit = await commitAll(harness.repo, 'add gone');
        await fs.rm(join(harness.repo, 'src', 'gone.ts'));
        await commitAll(harness.repo, 'delete gone');

        seedState(harness.home, harness.repoHash, (db) => {
          insertMicroSkill(
            db,
            skillRecord(harness.repoHash, {
              skillKey: 'cmd-keep',
              ruleText: 'Keep using the src/keep.ts helper.',
              linkedPathsJson: '["src/keep.ts"]',
              lastValidatedCommit: baseCommit,
            }),
          );
          insertMicroSkill(
            db,
            skillRecord(harness.repoHash, {
              skillKey: 'nav-gone',
              ruleText: 'Read src/gone.ts for the database schema.',
              linkedPathsJson: '["src/gone.ts"]',
              lastValidatedCommit: baseCommit,
            }),
          );
        });

        const err = capture();
        const result = await runFixtureSession(harness, { io: { stdout: capture().stream, stderr: err.stream } });

        assert.equal(result.status, 'completed');
        assert.match(err.text(), /retired stale micro-skill 'nav-gone'/);

        const skills = readState(harness.home, harness.repoHash, (db) => listAllMicroSkills(db, harness.repoHash));
        const gone = skills.find((skill) => skill.skillKey === 'nav-gone');
        const keep = skills.find((skill) => skill.skillKey === 'cmd-keep');
        assert.equal(gone?.active, 0, 'the deleted path must auto-retire the skill');
        assert.equal(keep?.active, 1, 'the surviving skill stays active');

        assert.ok(result.skillsFilePath !== null);
        const artifact = await fs.readFile(result.skillsFilePath, 'utf8');
        assert.match(artifact, /- Keep using the src\/keep\.ts helper\./);
        assert.doesNotMatch(artifact, /src\/gone\.ts for the database schema/);

        // The injected file lists exactly the one surviving active skill.
        const active = readState(harness.home, harness.repoHash, (db) => listActiveMicroSkills(db, harness.repoHash));
        assert.deepEqual(
          active.map((skill) => skill.skillKey),
          ['cmd-keep'],
        );
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Watchdog                                                                    */
/* -------------------------------------------------------------------------- */

describe('runSession — budget watchdog', () => {
  it(
    'kills the child on a hard budget breach and records aborted_budget',
    { timeout: 30_000 },
    async () => {
      await withHarness('anthropic', async (harness) => {
        await writeFile(harness.repo, 'src/app.ts', 'export function app(): string {\n  return "ok";\n}\n');
        await commitAll(harness.repo, 'add app');
        const doneFile = join(harness.home, 'abort-done.txt');

        const err = capture();
        const result = await runFixtureSession(harness, {
          budgetUsd: 0.0001,
          parentEnv: {
            ...baseEnv(),
            FAKE_REPO_ROOT: harness.repo,
            ANTHROPIC_BASE_URL: harness.upstream.baseUrl,
            FAKE_ABORT: '1',
            FAKE_DONE_FILE: doneFile,
          },
          io: { stdout: capture().stream, stderr: err.stream },
        });

        assert.equal(result.status, 'aborted_budget');
        assert.ok(
          result.breaches.some((breach) => breach.kind === 'hard_stop' && breach.hard),
          `expected a hard_stop breach, got ${JSON.stringify(result.breaches)}`,
        );
        assert.match(err.text(), /hard budget stop/);
        assert.equal(existsSync(doneFile), false, 'the killed fixture must not reach its completion marker');

        const session = readState(harness.home, harness.repoHash, (db) =>
          getRecentSessions(db, harness.repoHash, 1),
        )[0];
        assert.equal(session?.status, 'aborted_budget');
        assert.equal(session?.endedAt !== null, true);
      });
    },
  );

  it(
    'records the hard breach but does not kill the child with --no-kill',
    { timeout: 60_000 },
    async () => {
      await withHarness('anthropic', async (harness) => {
        await writeFile(harness.repo, 'src/app.ts', 'export function app(): string {\n  return "ok";\n}\n');
        await commitAll(harness.repo, 'add app');
        const doneFile = join(harness.home, 'nokill-done.txt');

        const result = await runFixtureSession(harness, {
          budgetUsd: 0.0001,
          noKill: true,
          parentEnv: {
            ...baseEnv(),
            FAKE_REPO_ROOT: harness.repo,
            ANTHROPIC_BASE_URL: harness.upstream.baseUrl,
            FAKE_ABORT: '1',
            FAKE_DONE_FILE: doneFile,
          },
        });

        assert.equal(result.status, 'completed');
        assert.equal(result.childExitCode, 0);
        assert.ok(
          result.breaches.some((breach) => breach.kind === 'hard_stop' && breach.hard),
          '--no-kill must still record the hard breach',
        );
        assert.equal(existsSync(doneFile), true, 'with --no-kill the fixture runs to completion');
        assert.ok(result.usage.inputTokens >= EXPECTED_ANTHROPIC_INPUT * 2, 'every looped request is priced');
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Spawn failure                                                               */
/* -------------------------------------------------------------------------- */

describe('runSession — spawn failure', () => {
  it(
    'records a failed session when the agent binary is missing',
    { timeout: 30_000 },
    async () => {
      await withHarness('anthropic', async (harness) => {
        await writeFile(harness.repo, 'src/app.ts', 'export function app(): string {\n  return "ok";\n}\n');
        await commitAll(harness.repo, 'add app');

        const err = capture();
        const result = await runFixtureSession(harness, {
          command: join(harness.home, 'loglode-definitely-not-a-real-binary'),
          io: { stdout: capture().stream, stderr: err.stream },
        });

        assert.equal(result.status, 'failed');
        assert.equal(result.childExitCode, null);
        assert.equal(result.usage.inputTokens, 0);
        assert.match(err.text(), /could not run/);
        assert.match(err.text(), /ENOENT|not found/i);
        assert.equal(harness.upstream.requestCount(), 0);

        // The child never emitted session_start; the pipeline still records the
        // attempt instead of finalizing a missing row.
        const sessions = readState(harness.home, harness.repoHash, (db) =>
          getRecentSessions(db, harness.repoHash, 5),
        );
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0]?.status, 'failed');
        assert.equal(sessions[0]?.endedAt !== null, true);
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Codex                                                                       */
/* -------------------------------------------------------------------------- */

describe('runSession — Codex', () => {
  it(
    'writes the managed AGENTS.md block and records proxy usage',
    { timeout: 30_000 },
    async () => {
      await withHarness('openai', async (harness) => {
        await writeFile(harness.repo, 'src/app.ts', 'export function app(): string {\n  return "ok";\n}\n');
        await commitAll(harness.repo, 'add app');
        await fs.writeFile(join(harness.repo, 'AGENTS.md'), '# Human notes\n\nKeep this line.\n', 'utf8');

        seedState(harness.home, harness.repoHash, (db) => {
          insertMicroSkill(
            db,
            skillRecord(harness.repoHash, {
              skillKey: 'cmd-codex-tests',
              ruleText: 'Run codex tests with --run; bare vitest hangs in watch mode.',
            }),
          );
        });

        const result = await runFixtureSession(harness, {
          cli: 'codex',
          parentEnv: {
            ...baseEnv(),
            FAKE_REPO_ROOT: harness.repo,
            OPENAI_BASE_URL: harness.upstream.baseUrl,
          },
        });

        assert.equal(result.status, 'completed');
        assert.equal(result.childExitCode, 0);
        assert.deepEqual(result.usage, {
          // prompt_tokens 2000 minus 500 cached.
          inputTokens: 1_500,
          cacheReadTokens: 500,
          cacheWriteTokens: 0,
          outputTokens: 300,
        });
        // (1500 * 0.25 + 500 * 0.025 + 300 * 2) / 1e6
        assert.ok(Math.abs(result.spendUsd - 0.0009875) < 1e-9, `spend ${result.spendUsd}`);
        assert.equal(harness.upstream.requestCount(), 1);

        const agentsPath = join(harness.repo, 'AGENTS.md');
        const block = await readManagedBlock(agentsPath);
        assert.ok(block !== null, 'the managed block must be written before the run');
        assert.match(block, /version: 1/);
        assert.match(block, /- Run codex tests with --run/);
        // Human content outside the markers is preserved, and the block survives
        // the run (the next pre-flight rewrites it).
        const agents = await fs.readFile(agentsPath, 'utf8');
        assert.match(agents, /# Human notes/);
        assert.match(agents, /Keep this line\./);

        const sessions = readState(harness.home, harness.repoHash, (db) =>
          getRecentSessions(db, harness.repoHash, 1),
        );
        const session = sessions[0];
        assert.equal(session?.cliTool, 'codex');
        assert.equal(session?.inputTokens, 1_500);
        assert.equal(session?.cacheReadTokens, 500);
        assert.equal(session?.outputTokens, 300);

        const calls = readState(harness.home, harness.repoHash, (db) =>
          getToolCallsForSessions(db, [result.sessionId]),
        );
        const edit = calls.find((call) => call.toolName === 'edit');
        assert.ok(edit !== undefined);
        assert.equal(edit.targetPath, 'src/codex-file.ts', 'the absolute changed path must be relativized');
        assert.ok(calls.some((call) => call.toolName === 'bash' && call.commandSignature === 'vitest --run'));
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Convergent re-mining (deduplicated waste_findings)                          */
/* -------------------------------------------------------------------------- */

describe('runSession — deduplicated re-mining', () => {
  it(
    'replaces a prior session’s findings instead of duplicating them',
    { timeout: 60_000 },
    async () => {
      await withHarness('anthropic', async (harness) => {
        await writeFile(harness.repo, 'src/app.ts', 'export function app(): string {\n  return "ok";\n}\n');
        await commitAll(harness.repo, 'add app');

        // A prior session with two identical failed commands: a `fail_loop` finding
        // that every re-mining run will detect again.
        const seededId = '99999999-aaaa-4aaa-8aaa-999999999999';
        seedState(harness.home, harness.repoHash, (db) => {
          seedSessionWithCalls(db, harness.repoHash, seededId, '2020-01-01T00:00:00.000Z', [
            failedBashCall(seededId, 1),
            failedBashCall(seededId, 2),
          ]);
        });

        const first = await runFixtureSession(harness);
        assert.equal(first.status, 'completed');
        const afterFirst = readState(harness.home, harness.repoHash, (db) =>
          getWasteFindingsForRepo(db, harness.repoHash),
        );
        assert.deepEqual(
          afterFirst.map((finding) => [finding.sessionId, finding.signature]),
          [[seededId, 'fail_loop:pytest -q']],
        );

        const second = await runFixtureSession(harness);
        assert.equal(second.status, 'completed');
        const afterSecond = readState(harness.home, harness.repoHash, (db) =>
          getWasteFindingsForRepo(db, harness.repoHash),
        );

        // Idempotent: the second run replaces the seeded session's rows rather
        // than appending another copy of the same detection output.
        assert.equal(afterSecond.length, afterFirst.length, 're-mining must not grow the store');
        assert.deepEqual(
          afterSecond.map((finding) => [finding.sessionId, finding.signature, finding.wastedTokens]),
          afterFirst.map((finding) => [finding.sessionId, finding.signature, finding.wastedTokens]),
        );
        const signatureRows = readState(harness.home, harness.repoHash, (db) =>
          getWasteFindingsBySignature(db, harness.repoHash, 'fail_loop:pytest -q'),
        );
        assert.equal(signatureRows.length, 1);
      });
    },
  );

  it(
    're-attaches a cross-session repeat_read finding to the newest reading session',
    { timeout: 60_000 },
    async () => {
      await withHarness('anthropic', async (harness) => {
        await writeFile(harness.repo, 'src/app.ts', 'export function app(): string {\n  return "ok";\n}\n');
        await commitAll(harness.repo, 'add app');

        // Two prior sessions that each read the same path. Together with a fixture
        // run they cross the miner's 3-session threshold, so the finding is attached
        // to that run's session and later must move to the next run's session.
        const olderId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
        const middleId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
        seedState(harness.home, harness.repoHash, (db) => {
          seedSessionWithCalls(db, harness.repoHash, olderId, '2020-01-01T00:00:00.000Z', [readCall(olderId, 1)]);
          seedSessionWithCalls(db, harness.repoHash, middleId, '2020-01-02T00:00:00.000Z', [readCall(middleId, 1)]);
        });

        const first = await runFixtureSession(harness);
        const afterFirst = readState(harness.home, harness.repoHash, (db) =>
          getWasteFindingsBySignature(db, harness.repoHash, 'repeat_read:src/app.ts'),
        );
        assert.equal(afterFirst.length, 1);
        assert.equal(afterFirst[0]?.sessionId, first.sessionId);

        const second = await runFixtureSession(harness);
        const afterSecond = readState(harness.home, harness.repoHash, (db) =>
          getWasteFindingsBySignature(db, harness.repoHash, 'repeat_read:src/app.ts'),
        );

        // One row, now owned by the newest session: the stale row on the previous
        // session was deleted as part of the window re-mining.
        assert.equal(afterSecond.length, 1, 'the stale cross-session row must be replaced, not added to');
        assert.equal(afterSecond[0]?.sessionId, second.sessionId);
      });
    },
  );

  it('mine --dry-run does not mutate the store at all', { timeout: 30_000 }, async () => {
    await withHarness('anthropic', async (harness) => {
      const seededId = 'cccccccc-3333-4333-8333-cccccccccccc';
      const signature = 'fail_loop:pytest -q';
      seedState(harness.home, harness.repoHash, (db) => {
        seedSessionWithCalls(db, harness.repoHash, seededId, '2020-01-01T00:00:00.000Z', [
          failedBashCall(seededId, 1),
          failedBashCall(seededId, 2),
        ]);
        // A row a dry run must preserve byte-for-byte, even though re-mining the
        // window detects the same signature (a deletion would erase it).
        insertWasteFindings(db, [
          {
            repoHash: harness.repoHash,
            sessionId: seededId,
            patternType: 'fail_loop',
            signature,
            occurrences: 9,
            wastedTokens: 9_999,
            evidenceJson: '{"marker":"original"}',
          },
        ]);
      });

      const before = readState(harness.home, harness.repoHash, (db) =>
        getWasteFindingsForRepo(db, harness.repoHash),
      );
      assert.equal(before.length, 1);

      const out = capture();
      const err = capture();
      const code = await runCli(['mine', '--dry-run'], {
        stdout: out.stream,
        stderr: err.stream,
        cwd: harness.repo,
        env: { ...baseEnv(), LOGLODE_HOME: harness.home },
        configPaths: {
          globalConfigPath: join(harness.home, '.loglode', 'config.toml'),
          repoConfigPath: join(harness.repo, '.loglode', 'config.toml'),
        },
      });

      assert.equal(code, 0);
      assert.match(out.text(), /dry run: not persisted/);
      const after = readState(harness.home, harness.repoHash, (db) =>
        getWasteFindingsForRepo(db, harness.repoHash),
      );
      assert.deepEqual(after, before, 'a dry run must neither insert nor delete findings');
    });
  });
});
