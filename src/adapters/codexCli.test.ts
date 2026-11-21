/**
 * Tests for the Codex CLI adapter.
 *
 * Everything here is fixture-driven: no `codex` binary is installed on the build
 * machine and no network is allowed, so the JSONL parser is exercised against
 * hand-written frames that mirror real `codex exec --json` output (including the
 * frames this adapter deliberately ignores). Managed-block tests use a temp
 * directory so the developer's real `AGENTS.md` and `~/.loglode` are never
 * touched.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  buildCodexArgs,
  buildCodexEnv,
  collectCodexEvents,
  createCodexEventParser,
  injectManagedBlock,
  readManagedBlock,
  removeManagedBlock,
} from './codexCli.js';
import type { CliEvent } from './types.js';
import { withTempDir } from '../testing/tmp.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OK_OUTPUT = 'tsc: no errors in 12 files.';
const FAILURE_OUTPUT = [
  "error TS2322: Type 'string' is not assignable to type 'number'.",
  '    at src/app.ts:12:3   ',
  '',
  'this trailing detail must not change the fingerprint',
].join('\n');

/**
 * Expected fingerprint, spelled out independently of the implementation: first
 * two lines, trimmed, whitespace collapsed, lower-cased, joined with `\n`, then
 * SHA-256 truncated to 16 hex chars.
 */
const EXPECTED_FINGERPRINT = createHash('sha256')
  .update("error ts2322: type 'string' is not assignable to type 'number'.\nat src/app.ts:12:3")
  .digest('hex')
  .slice(0, 16);

function commandExecution(command: string, exitCode: number | null, output: string): string {
  return JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command, exit_code: exitCode, aggregated_output: output },
  });
}

/** A full session: start, one success, one failure, two edits, usage, summary. */
const SESSION_LINES: string[] = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread_01' }),
  JSON.stringify({ type: 'turn.started' }),
  commandExecution('npx tsc --noEmit --strict', 0, OK_OUTPUT),
  commandExecution('npm test -- --watch=false', 1, FAILURE_OUTPUT),
  JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'file_change',
      changes: [
        { path: 'src/app.ts', kind: 'update' },
        { path: 'src\\app\\nested.ts', kind: 'add' },
      ],
    },
  }),
  JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 1200,
      cached_input_tokens: 800,
      output_tokens: 150,
      reasoning_output_tokens: 40,
    },
  }),
  // Newer builds append a summary frame this adapter does not interpret.
  JSON.stringify({ type: 'result', status: 'success' }),
];

const EXPECTED_SESSION_EVENTS: CliEvent[] = [
  { type: 'session_start', cliTool: 'codex', taskPromptHash: null },
  {
    type: 'tool_call',
    turnIndex: 1,
    toolName: 'bash',
    targetPath: null,
    commandSignature: 'npx --noEmit --strict',
  },
  {
    type: 'tool_result',
    turnIndex: 1,
    exitCode: 0,
    outputTokens: Math.ceil(OK_OUTPUT.length / 4),
    errorFingerprint: null,
  },
  {
    type: 'tool_call',
    turnIndex: 1,
    toolName: 'bash',
    targetPath: null,
    // `test` is an ephemeral positional argument, so only the program and flags remain.
    commandSignature: 'npm -- --watch=false',
  },
  {
    type: 'tool_result',
    turnIndex: 1,
    exitCode: 1,
    outputTokens: Math.ceil(FAILURE_OUTPUT.length / 4),
    errorFingerprint: EXPECTED_FINGERPRINT,
  },
  { type: 'tool_call', turnIndex: 1, toolName: 'edit', targetPath: 'src/app.ts', commandSignature: null },
  {
    type: 'tool_call',
    turnIndex: 1,
    toolName: 'edit',
    targetPath: 'src/app/nested.ts',
    commandSignature: null,
  },
  {
    type: 'usage',
    model: 'codex-cli',
    usage: { inputTokens: 1200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 150 },
  },
];

const blockText = (content: string): string =>
  `${MANAGED_BLOCK_BEGIN}\n${content}${MANAGED_BLOCK_END}\n`;

// ---------------------------------------------------------------------------
// Managed AGENTS.md block
// ---------------------------------------------------------------------------

describe('managed AGENTS.md block', () => {
  it('creates a missing AGENTS.md containing marker, content and marker', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      const content = '## Commands & Tooling\n- Run unit tests with `npx vitest run`.\n';

      await injectManagedBlock(agentsMd, content);

      assert.equal(await fs.readFile(agentsMd, 'utf8'), blockText(content));
      assert.equal(await readManagedBlock(agentsMd), content);
    });
  });

  it('replaces only the content between markers and leaves the rest byte-identical', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      const prefix = '# Repo Notes\n\nHand-written instructions stay put.\n\n';
      const suffix = '\n## Tail\n\nKeep this too.\n';
      const original = `${prefix}${MANAGED_BLOCK_BEGIN}\nstale skill line\n${MANAGED_BLOCK_END}\n${suffix}`;
      await fs.writeFile(agentsMd, original, 'utf8');

      const content = '## Context Hygiene\n- Never read `pnpm-lock.yaml`.\n';
      await injectManagedBlock(agentsMd, content);

      const updated = await fs.readFile(agentsMd, 'utf8');
      assert.equal(updated, `${prefix}${MANAGED_BLOCK_BEGIN}\n${content}${MANAGED_BLOCK_END}\n${suffix}`);
      assert.ok(updated.startsWith(prefix), 'content before the markers must not move');
      assert.ok(updated.endsWith(suffix), 'content after the markers must not move');
      assert.equal(await readManagedBlock(agentsMd), content);
    });
  });

  it('is idempotent when injected repeatedly', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      const content = '## Commands\n- Use `npx tsc --noEmit`.\n';

      await injectManagedBlock(agentsMd, content);
      const first = await fs.readFile(agentsMd, 'utf8');
      await injectManagedBlock(agentsMd, content);
      assert.equal(await fs.readFile(agentsMd, 'utf8'), first);

      const tightened = '## Commands\n- Use `npx tsc -p tsconfig.json`.\n';
      await injectManagedBlock(agentsMd, tightened);
      assert.equal(await fs.readFile(agentsMd, 'utf8'), blockText(tightened));
    });
  });

  it('appends to a markerless file after exactly one blank line', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      await fs.writeFile(agentsMd, '# Repo Notes\n\nNo managed block yet.\n\n', 'utf8');

      const content = '## Commands\n- Run `npm test`.\n';
      await injectManagedBlock(agentsMd, content);

      assert.equal(
        await fs.readFile(agentsMd, 'utf8'),
        `# Repo Notes\n\nNo managed block yet.\n\n${blockText(content)}`,
      );
      assert.equal(await readManagedBlock(agentsMd), content);
    });
  });

  it('keeps a trailing newline after the end marker when the block ends the file', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      await fs.writeFile(agentsMd, `${MANAGED_BLOCK_BEGIN}\nold${MANAGED_BLOCK_END}`, 'utf8');

      await injectManagedBlock(agentsMd, 'fresh\n');

      assert.equal(await fs.readFile(agentsMd, 'utf8'), blockText('fresh\n'));
    });
  });

  it('readManagedBlock returns null when the file or the block is absent', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      assert.equal(await readManagedBlock(agentsMd), null);

      await fs.writeFile(agentsMd, '# Notes only\n', 'utf8');
      assert.equal(await readManagedBlock(agentsMd), null);
    });
  });

  it('readManagedBlock returns content verbatim, including blank lines', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      const content = 'line with trailing spaces   \n\nsecond\n';
      await injectManagedBlock(agentsMd, content);

      assert.equal(await readManagedBlock(agentsMd), content);
    });
  });

  it('removeManagedBlock leaves a markerless file untouched', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      await fs.writeFile(agentsMd, '# Notes only\n', 'utf8');

      await removeManagedBlock(agentsMd);

      assert.equal(await fs.readFile(agentsMd, 'utf8'), '# Notes only\n');
    });
  });

  it('removeManagedBlock does not create a missing file', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');

      await removeManagedBlock(agentsMd);

      await assert.rejects(fs.stat(agentsMd), (error: unknown) => {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      });
    });
  });

  it('removeManagedBlock empties a file that contained only the block', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      await injectManagedBlock(agentsMd, 'only managed content\n');

      await removeManagedBlock(agentsMd);

      assert.equal(await fs.readFile(agentsMd, 'utf8'), '');
    });
  });

  it('removeManagedBlock also drops the blank lines that followed the block', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      await fs.writeFile(agentsMd, '# Notes\n', 'utf8');
      await injectManagedBlock(agentsMd, 'managed\n');

      await removeManagedBlock(agentsMd);

      // Only blank lines *after* the block belong to it, so the separator blank
      // line that append added in front stays; a re-inject normalises trailing
      // newlines, so the file does not grow across sessions.
      assert.equal(await fs.readFile(agentsMd, 'utf8'), '# Notes\n\n');
    });
  });

  it('tolerates CRLF input files', async () => {
    await withTempDir(async (dir) => {
      const agentsMd = join(dir, 'AGENTS.md');
      const original = `# Notes\r\n\r\n${MANAGED_BLOCK_BEGIN}\r\nstale\r\n${MANAGED_BLOCK_END}\r\n\r\n## Tail\r\n`;
      await fs.writeFile(agentsMd, original, 'utf8');

      const content = 'crlf skill\n';
      await injectManagedBlock(agentsMd, content);

      const updated = await fs.readFile(agentsMd, 'utf8');
      assert.equal(
        updated,
        `# Notes\r\n\r\n${MANAGED_BLOCK_BEGIN}\n${content}${MANAGED_BLOCK_END}\r\n\r\n## Tail\r\n`,
      );
      assert.equal(await readManagedBlock(agentsMd), content);

      await removeManagedBlock(agentsMd);
      assert.equal(await fs.readFile(agentsMd, 'utf8'), '# Notes\r\n\r\n## Tail\r\n');
    });
  });
});

// ---------------------------------------------------------------------------
// JSONL parser
// ---------------------------------------------------------------------------

describe('createCodexEventParser', () => {
  it('maps a full codex session in order', () => {
    const parser = createCodexEventParser();
    const events: CliEvent[] = [];
    for (const line of SESSION_LINES) events.push(...parser.write(line));

    assert.deepStrictEqual(events, EXPECTED_SESSION_EVENTS);
    assert.match(EXPECTED_FINGERPRINT, /^[0-9a-f]{16}$/);
    assert.deepStrictEqual(parser.stats(), {
      lines: SESSION_LINES.length,
      parseErrors: 0,
      // The `result` summary frame is recognised JSON but carries no telemetry.
      skippedEvents: 1,
    });
    assert.deepStrictEqual(parser.end(), [{ type: 'session_end', status: 'completed' }]);
    assert.deepStrictEqual(parser.end(), [], 'end() must not flush twice');
  });

  it('fingerprints failures deterministically and ignores success output', () => {
    assert.deepStrictEqual(collectCodexEvents([commandExecution('npm test', 1, FAILURE_OUTPUT)]), [
      {
        type: 'tool_call',
        turnIndex: 1,
        toolName: 'bash',
        targetPath: null,
        commandSignature: 'npm',
      },
      {
        type: 'tool_result',
        turnIndex: 1,
        exitCode: 1,
        outputTokens: Math.ceil(FAILURE_OUTPUT.length / 4),
        errorFingerprint: EXPECTED_FINGERPRINT,
      },
      { type: 'session_end', status: 'completed' },
    ]);

    const repeat = collectCodexEvents([commandExecution('npm test', 1, FAILURE_OUTPUT)]);
    const firstRun = collectCodexEvents([commandExecution('npm test', 1, FAILURE_OUTPUT)]);
    assert.deepStrictEqual(repeat, firstRun, 'identical output must fingerprint identically');

    const different = collectCodexEvents([commandExecution('npm test', 1, 'error: something else\nat x')]);
    assert.notDeepStrictEqual(different, firstRun);
  });

  it('treats a missing exit code as unknown rather than success', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'ls', aggregated_output: 'a\nb' },
    });

    assert.deepStrictEqual(collectCodexEvents([line]), [
      { type: 'tool_call', turnIndex: 1, toolName: 'bash', targetPath: null, commandSignature: 'ls' },
      { type: 'tool_result', turnIndex: 1, exitCode: null, outputTokens: 1, errorFingerprint: null },
      { type: 'session_end', status: 'completed' },
    ]);
  });

  it('maps OpenAI-style total_token_usage frames', () => {
    assert.deepStrictEqual(
      collectCodexEvents([
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'turn.completed',
          total_token_usage: {
            prompt_tokens: 1000,
            completion_tokens: 200,
            total_tokens: 1200,
            prompt_tokens_details: { cached_tokens: 600 },
          },
        }),
      ]),
      [
        {
          type: 'usage',
          model: 'codex-cli',
          usage: { inputTokens: 400, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 200 },
        },
        { type: 'session_end', status: 'completed' },
      ],
    );
  });

  it('never reports negative uncached input tokens', () => {
    assert.deepStrictEqual(
      collectCodexEvents([
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 250 },
          },
        }),
      ]),
      [
        {
          type: 'usage',
          model: 'codex-cli',
          usage: { inputTokens: 0, cacheReadTokens: 250, cacheWriteTokens: 0, outputTokens: 5 },
        },
        { type: 'session_end', status: 'completed' },
      ],
    );
  });

  it('keeps turn indices continuous across turns', () => {
    const events = collectCodexEvents([
      JSON.stringify({ type: 'turn.started' }),
      commandExecution('ls -la', 0, 'ok'),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
      JSON.stringify({ type: 'turn.started' }),
      commandExecution('cat package.json', 0, '{}'),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 4 } }),
    ]);

    const callTurns = events.flatMap((event) => (event.type === 'tool_call' ? [event.turnIndex] : []));
    const resultTurns = events.flatMap((event) =>
      event.type === 'tool_result' ? [event.turnIndex] : [],
    );
    assert.deepStrictEqual(callTurns, [1, 2]);
    assert.deepStrictEqual(resultTurns, [1, 2]);
  });

  it('opens turn 1 when a build omits turn.started', () => {
    assert.deepStrictEqual(collectCodexEvents([commandExecution('pwd', 0, '/repo')]), [
      { type: 'tool_call', turnIndex: 1, toolName: 'bash', targetPath: null, commandSignature: 'pwd' },
      { type: 'tool_result', turnIndex: 1, exitCode: 0, outputTokens: 2, errorFingerprint: null },
      { type: 'session_end', status: 'completed' },
    ]);
  });

  it('ends the session as failed on an error frame without double-emitting', () => {
    const parser = createCodexEventParser();

    assert.deepStrictEqual(parser.write(JSON.stringify({ type: 'thread.started' })), [
      { type: 'session_start', cliTool: 'codex', taskPromptHash: null },
    ]);
    assert.deepStrictEqual(parser.write(JSON.stringify({ type: 'error', message: 'stream disconnected' })), [
      { type: 'session_end', status: 'failed' },
    ]);
    assert.deepStrictEqual(parser.end(), [], 'error already ended the session');
    assert.deepStrictEqual(parser.stats(), { lines: 2, parseErrors: 0, skippedEvents: 0 });
  });

  it('counts unknown and malformed lines instead of throwing', () => {
    const parser = createCodexEventParser();
    const events: CliEvent[] = [
      ...parser.write(JSON.stringify({ type: 'agent_message', message: 'hello' })),
      ...parser.write(
        JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }),
      ),
      ...parser.write(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '...' } })),
      ...parser.write('{"type":"thread.started"'),
      ...parser.write('null'),
      ...parser.write('   '),
      ...parser.write(JSON.stringify({ type: 'turn.completed' })),
    ];

    assert.deepStrictEqual(events, []);
    assert.deepStrictEqual(parser.stats(), { lines: 6, parseErrors: 2, skippedEvents: 4 });
    assert.deepStrictEqual(parser.end(), [{ type: 'session_end', status: 'completed' }]);
  });

  it('collectCodexEvents accepts a whole stdout blob as one element', () => {
    const blob = `${SESSION_LINES.join('\r\n')}\r\n`;

    assert.deepStrictEqual(collectCodexEvents([blob]), [
      ...EXPECTED_SESSION_EVENTS,
      { type: 'session_end', status: 'completed' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Spawn spec
// ---------------------------------------------------------------------------

describe('buildCodexArgs', () => {
  it('appends the json flag once and preserves user args in order', () => {
    assert.deepStrictEqual(buildCodexArgs({ agentArgs: [] }), ['--json']);
    assert.deepStrictEqual(buildCodexArgs({ agentArgs: ['exec', '--model', 'o3', '--full-auto'] }), [
      'exec',
      '--model',
      'o3',
      '--full-auto',
      '--json',
    ]);
  });

  it('never duplicates an existing json flag', () => {
    assert.deepStrictEqual(buildCodexArgs({ agentArgs: ['--json', 'exec'] }), ['--json', 'exec']);
    assert.deepStrictEqual(buildCodexArgs({ agentArgs: ['exec', '--json=pretty'] }), [
      'exec',
      '--json=pretty',
    ]);
  });

  it('does not mutate the caller array', () => {
    const userArgs = ['exec'];
    const built = buildCodexArgs({ agentArgs: userArgs });

    assert.deepStrictEqual(userArgs, ['exec']);
    assert.notStrictEqual(built, userArgs);
  });
});

describe('buildCodexEnv', () => {
  it('injects OPENAI_BASE_URL without mutating the parent environment', () => {
    const parentEnv: NodeJS.ProcessEnv = Object.freeze({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      CODEX_HOME: '/tmp/codex',
    });

    const env = buildCodexEnv({ openaiBaseUrl: 'http://127.0.0.1:43111', parentEnv });

    assert.notStrictEqual(env, parentEnv);
    assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:43111');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/dev');
    assert.equal(env.CODEX_HOME, '/tmp/codex');
    assert.equal(Object.keys(env).length, 4);
    assert.equal(Object.hasOwn(parentEnv, 'OPENAI_BASE_URL'), false);
  });

  it('leaves an inherited OPENAI_BASE_URL alone when no proxy is configured', () => {
    const parentEnv: NodeJS.ProcessEnv = {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      PATH: '/usr/bin',
    };

    const env = buildCodexEnv({ openaiBaseUrl: null, parentEnv });

    assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1');
    assert.equal(parentEnv.OPENAI_BASE_URL, 'https://api.openai.com/v1');
  });
});
