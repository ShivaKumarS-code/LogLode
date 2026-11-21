import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildClaudeArgs,
  buildClaudeEnv,
  buildClaudeSpawn,
  collectClaudeEvents,
  createClaudeEventParser,
  normalizeCommandSignature,
} from './claudeCode.js';
import type { CliEvent } from './types.js';

type EventOf<T extends CliEvent['type']> = Extract<CliEvent, { type: T }>;

function eventsOfType<T extends CliEvent['type']>(events: CliEvent[], type: T): EventOf<T>[] {
  return events.filter((event): event is EventOf<T> => event.type === type);
}

// --- stream-json fixture -----------------------------------------------------
//
// Hand-captured shape of `claude --output-format stream-json --verbose`: one JSON
// object per line, no turn numbers, usage embedded in frames (deliberately
// ignored here because the token proxy is the billing source of truth).

const READ_TOOL_USE_ID = 'toolu_read_1';
const BASH_TOOL_USE_ID = 'toolu_bash_1';
const EDIT_TOOL_USE_ID = 'toolu_edit_1';

/** As printed by the CLI on Windows; the adapter must normalize the separators. */
const READ_PATH_FROM_CLI = 'src\\adapters\\types.ts';
const READ_RESULT_TEXT = "export type CliTool = 'claude_code' | 'codex';";
const BASH_COMMAND = 'pytest tests/unit -q --tb=short extra.py';
const EDIT_RESULT_TEXT = 'Edited 1 file.';

const ERROR_LINE_1 = 'Error:    FAIL  tests/unit/foo.test.ts';
const ERROR_LINE_2 = '\tat   runner (tests/run.ts:12:5)';
const ERROR_LINE_3 = '    at ignored (internal/run.ts:99:1)';
const ERROR_RESULT_TEXT = `${ERROR_LINE_1}\n${ERROR_LINE_2}\n${ERROR_LINE_3}`;
const ERROR_CONTENT_BLOCKS = [
  { type: 'text', text: `${ERROR_LINE_1}\n` },
  { type: 'text', text: `${ERROR_LINE_2}\n${ERROR_LINE_3}` },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
];
/** First two lines only, trimmed, internal runs collapsed, lowercased. */
const EXPECTED_NORMALIZED_ERROR = 'error: fail tests/unit/foo.test.ts\nat runner (tests/run.ts:12:5)';

function fixtureLines(): string[] {
  return [
    '{"type":"system","subtype":"init","session_id":"sess-1","cwd":"D:/LogLode","tools":["Read","Bash","Edit"],"model":"claude-sonnet-4-5"}',
    // Turn 1: Read + Bash tool_use blocks.
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'Let me inspect the types and run the tests.' },
          { type: 'tool_use', id: READ_TOOL_USE_ID, name: 'Read', input: { file_path: READ_PATH_FROM_CLI } },
          { type: 'tool_use', id: BASH_TOOL_USE_ID, name: 'Bash', input: { command: BASH_COMMAND, description: 'Run unit tests' } },
        ],
      },
    }),
    // Both results for turn 1; the Bash one failed.
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: READ_TOOL_USE_ID, content: READ_RESULT_TEXT, is_error: false },
          { type: 'tool_result', tool_use_id: BASH_TOOL_USE_ID, content: ERROR_CONTENT_BLOCKS, is_error: true },
        ],
      },
    }),
    // Turn 2.
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_2',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: EDIT_TOOL_USE_ID,
            name: 'Edit',
            input: { file_path: 'src\\tokenize.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: EDIT_TOOL_USE_ID, content: EDIT_RESULT_TEXT, is_error: false }],
      },
    }),
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"result":"done","usage":{"input_tokens":10,"cache_read_input_tokens":2,"output_tokens":5}}',
  ];
}

// --- normalizeCommandSignature ----------------------------------------------

const SIGNATURE_CASES: Array<[input: string, expected: string]> = [
  ['', ''],
  ['   ', ''],
  ['pytest tests/unit -q --tb=short extra.py', 'pytest -q --tb=short'],
  ['pnpm --filter api test -- --run', 'pnpm --filter -- --run'],
  ['npm run build', 'npm'],
  ['npm\trun\tbuild', 'npm'],
  ['  npm   run   build  ', 'npm'],
  ['node -e "console.log(1)"', 'node -e'],
  ['python3.11 -m pytest tests -x', 'python3.11 -m -x'],
  ['mv src/a.ts src/b.ts', 'mv'],
  ['git commit -m "wip: stop"', 'git -m'],
  ['-q --tb=short', '-q --tb=short'],
  ['cargo --version', 'cargo --version'],
];

describe('normalizeCommandSignature', () => {
  for (const [input, expected] of SIGNATURE_CASES) {
    it(`reduces ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
      assert.equal(normalizeCommandSignature(input), expected);
    });
  }
});

// --- spawn spec --------------------------------------------------------------

describe('buildClaudeArgs', () => {
  it('adds stream-json output and verbose once', () => {
    assert.deepEqual(buildClaudeArgs({ agentArgs: [] }), ['--output-format', 'stream-json', '--verbose']);
    assert.deepEqual(buildClaudeArgs({ agentArgs: ['--model', 'sonnet'] }), [
      '--model',
      'sonnet',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
  });

  it('never duplicates flags the caller already passed', () => {
    const agentArgs = ['--output-format', 'stream-json', '--verbose', '--model', 'sonnet'];
    const args = buildClaudeArgs({ agentArgs });

    assert.deepEqual(args, agentArgs);
    assert.equal(args.filter((arg) => arg === '--output-format').length, 1);
    assert.equal(args.filter((arg) => arg === '--verbose').length, 1);
    assert.notStrictEqual(args, agentArgs);
  });

  it('respects a caller-supplied output format instead of doubling it', () => {
    assert.deepEqual(buildClaudeArgs({ agentArgs: ['--output-format', 'json'] }), ['--output-format', 'json', '--verbose']);
  });

  it('only appends the system prompt file when a path is given', () => {
    assert.deepEqual(buildClaudeArgs({ agentArgs: [], systemPromptFilePath: '.loglode/micro-skills.md' }), [
      '--output-format',
      'stream-json',
      '--verbose',
      '--append-system-prompt-file',
      '.loglode/micro-skills.md',
    ]);
    assert.deepEqual(buildClaudeArgs({ agentArgs: [], systemPromptFilePath: null }), [
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    assert.deepEqual(buildClaudeArgs({ agentArgs: [] }), ['--output-format', 'stream-json', '--verbose']);
  });

  it('does not mutate the caller argument list', () => {
    const agentArgs = ['--model', 'sonnet'];
    buildClaudeArgs({ agentArgs, systemPromptFilePath: 'skills.md' });
    assert.deepEqual(agentArgs, ['--model', 'sonnet']);
  });
});

describe('buildClaudeEnv', () => {
  it('points ANTHROPIC_BASE_URL at the proxy and preserves everything else', () => {
    const parentEnv: NodeJS.ProcessEnv = { PATH: 'C:\\Windows', HOME: '/home/dev', ANTHROPIC_API_KEY: 'sk-ant-test' };
    const env = buildClaudeEnv({ anthropicBaseUrl: 'http://127.0.0.1:45123', parentEnv });

    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45123');
    assert.equal(env.PATH, 'C:\\Windows');
    assert.equal(env.HOME, '/home/dev');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
    assert.notStrictEqual(env, parentEnv);
  });

  it('does not mutate the parent environment', () => {
    const parentEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const before = { ...parentEnv };

    buildClaudeEnv({ anthropicBaseUrl: 'http://127.0.0.1:1', parentEnv });

    assert.deepEqual(parentEnv, before);
    assert.equal(parentEnv.ANTHROPIC_BASE_URL, undefined);
  });

  it('leaves an inherited base URL alone when none is supplied', () => {
    const parentEnv: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
    assert.equal(buildClaudeEnv({ anthropicBaseUrl: null, parentEnv }).ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    assert.equal(buildClaudeEnv({ parentEnv }).ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  });
});

describe('buildClaudeSpawn', () => {
  it('composes command, args, and env', () => {
    const parentEnv: NodeJS.ProcessEnv = { PATH: 'C:\\Windows' };
    const spec = buildClaudeSpawn({
      agentArgs: ['--model', 'sonnet'],
      systemPromptFilePath: '.loglode/micro-skills.md',
      anthropicBaseUrl: 'http://127.0.0.1:45123',
      parentEnv,
    });

    assert.equal(spec.command, 'claude');
    assert.deepEqual(spec.args, [
      '--model',
      'sonnet',
      '--output-format',
      'stream-json',
      '--verbose',
      '--append-system-prompt-file',
      '.loglode/micro-skills.md',
    ]);
    assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45123');
    assert.equal(spec.env.PATH, 'C:\\Windows');
  });

  it('honours a custom command and leaves injection off for baseline runs', () => {
    const spec = buildClaudeSpawn({
      command: 'claude-next',
      agentArgs: [],
      systemPromptFilePath: null,
      anthropicBaseUrl: null,
      parentEnv: {},
    });

    assert.equal(spec.command, 'claude-next');
    assert.deepEqual(spec.args, ['--output-format', 'stream-json', '--verbose']);
    assert.equal(spec.env.ANTHROPIC_BASE_URL, undefined);
  });
});

// --- event parser ------------------------------------------------------------

describe('createClaudeEventParser', () => {
  it('maps a complete stream-json session onto normalized events', () => {
    const parser = createClaudeEventParser();
    const events: CliEvent[] = [];
    for (const line of fixtureLines()) {
      for (const event of parser.write(line)) {
        events.push(event);
      }
    }
    for (const event of parser.end()) {
      events.push(event);
    }

    assert.equal(events.length, 8);
    assert.deepEqual(events[0], { type: 'session_start', cliTool: 'claude_code', taskPromptHash: null });

    assert.deepEqual(eventsOfType(events, 'tool_call'), [
      {
        type: 'tool_call',
        turnIndex: 1,
        toolName: 'Read',
        targetPath: 'src/adapters/types.ts',
        commandSignature: null,
      },
      {
        type: 'tool_call',
        turnIndex: 1,
        toolName: 'Bash',
        targetPath: null,
        commandSignature: 'pytest -q --tb=short',
      },
      {
        type: 'tool_call',
        turnIndex: 2,
        toolName: 'Edit',
        targetPath: 'src/tokenize.ts',
        commandSignature: null,
      },
    ]);

    const expectedErrorFingerprint = createHash('sha256').update(EXPECTED_NORMALIZED_ERROR, 'utf8').digest('hex').slice(0, 16);
    assert.match(expectedErrorFingerprint, /^[0-9a-f]{16}$/);

    assert.deepEqual(eventsOfType(events, 'tool_result'), [
      {
        type: 'tool_result',
        turnIndex: 1,
        exitCode: null,
        outputTokens: Math.ceil(READ_RESULT_TEXT.length / 4),
        errorFingerprint: null,
      },
      {
        type: 'tool_result',
        turnIndex: 1,
        exitCode: null,
        outputTokens: Math.ceil(ERROR_RESULT_TEXT.length / 4),
        errorFingerprint: expectedErrorFingerprint,
      },
      {
        type: 'tool_result',
        turnIndex: 2,
        exitCode: null,
        outputTokens: Math.ceil(EDIT_RESULT_TEXT.length / 4),
        errorFingerprint: null,
      },
    ]);

    assert.deepEqual(eventsOfType(events, 'session_end'), [{ type: 'session_end', status: 'completed' }]);
    assert.equal(eventsOfType(events, 'usage').length, 0);
    assert.deepEqual(parser.stats(), { lines: 6, parseErrors: 0, skippedEvents: 0 });
  });

  it('counts every assistant message as a turn, even without tool calls', () => {
    const events = collectClaudeEvents([
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Grep', input: { pattern: 'foo' } }] },
      }),
    ]);

    const toolCalls = eventsOfType(events, 'tool_call');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].turnIndex, 3);
    assert.equal(toolCalls[0].targetPath, null);
    assert.equal(toolCalls[0].commandSignature, null);
  });

  it('reads target paths from file_path, path, or notebook_path', () => {
    const events = collectClaudeEvents([
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_a', name: 'Grep', input: { path: 'src\\store', pattern: 'db' } },
            { type: 'tool_use', id: 'toolu_b', name: 'NotebookEdit', input: { notebook_path: 'notebooks\\demo.ipynb' } },
            { type: 'tool_use', id: 'toolu_c', name: 'Glob', input: { pattern: '**/*.ts' } },
          ],
        },
      }),
    ]);

    assert.deepEqual(
      eventsOfType(events, 'tool_call').map((call) => call.targetPath),
      ['src/store', 'notebooks/demo.ipynb', null],
    );
  });

  it('falls back to the current turn for a tool result whose tool_use_id is unknown', () => {
    const parser = createClaudeEventParser();
    parser.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } }] },
      }),
    );

    const events = parser.write(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_unknown', content: 'x', is_error: false }] },
      }),
    );

    const results = eventsOfType(events, 'tool_result');
    assert.equal(results.length, 1);
    assert.equal(results[0].turnIndex, 1);
  });

  it('fingerprints only flagged errors, normalizing the first two lines', () => {
    const fingerprintOf = (content: unknown): string | null => {
      const events = collectClaudeEvents([
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content, is_error: true }] },
        }),
      ]);
      const [result] = eventsOfType(events, 'tool_result');
      assert.ok(result !== undefined);
      return result.errorFingerprint;
    };

    // Whitespace/case noise and a third line must not change the fingerprint.
    assert.equal(
      fingerprintOf('Error:    FAIL  x\n\tat FOO (a.ts:1:1)\nthird line ignored'),
      fingerprintOf('error: fail x\nat foo (a.ts:1:1)'),
    );
    assert.notEqual(fingerprintOf('boom'), fingerprintOf('bang'));
    assert.equal(fingerprintOf(''), createHash('sha256').update('', 'utf8').digest('hex').slice(0, 16));
  });

  it('maps non-success result subtypes to failed sessions', () => {
    for (const subtype of ['error_max_turns', 'error_during_execution']) {
      const parser = createClaudeEventParser();
      assert.deepEqual(parser.write(JSON.stringify({ type: 'result', subtype })), [{ type: 'session_end', status: 'failed' }]);
      assert.deepEqual(parser.end(), []);
    }

    // A result frame without a subtype is not a success either.
    assert.deepEqual(createClaudeEventParser().write('{"type":"result"}'), [{ type: 'session_end', status: 'failed' }]);
  });

  it('counts unknown types and malformed lines without throwing', () => {
    const parser = createClaudeEventParser();

    assert.deepEqual(parser.write('{"type":"system","subtype":"init"}'), [
      { type: 'session_start', cliTool: 'claude_code', taskPromptHash: null },
    ]);
    assert.deepEqual(parser.write('{"type":"debug","payload":{"x":1}}'), []);
    assert.deepEqual(parser.write('not json at all'), []);
    assert.deepEqual(parser.write('42'), []);
    assert.deepEqual(parser.write('   '), []);
    assert.deepEqual(parser.write(''), []);
    assert.deepEqual(parser.write('{"type":"assistant","message":{"content":[]}}'), []);
    assert.deepEqual(parser.write('{"type":"system","subtype":"compact_boundary"}'), []);
    assert.deepEqual(parser.write('{"type":"result","subtype":"success"}'), [{ type: 'session_end', status: 'completed' }]);

    assert.deepEqual(parser.stats(), { lines: 7, parseErrors: 2, skippedEvents: 2 });
  });

  it('flushes a synthetic session_end when the stream never printed a result', () => {
    const parser = createClaudeEventParser();
    parser.write('{"type":"system","subtype":"init"}');

    assert.deepEqual(parser.end(), [{ type: 'session_end', status: 'completed' }]);
    assert.deepEqual(parser.end(), []);
    assert.equal(parser.stats().lines, 1);
  });

  it('does not synthesize a second session_end after a result frame', () => {
    const parser = createClaudeEventParser();
    parser.write('{"type":"result","subtype":"success"}');

    assert.deepEqual(parser.end(), []);
    assert.equal(parser.stats().skippedEvents, 0);

    assert.deepEqual(parser.write('{"type":"result","subtype":"success"}'), []);
    assert.equal(parser.stats().skippedEvents, 1);
  });

  it('tolerates unusual payload shapes without throwing', () => {
    const events = collectClaudeEvents([
      '{"type":"assistant"}',
      '{"type":"assistant","message":{}}',
      '{"type":"assistant","message":{"content":"plain text"}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"command":42}}]}}',
      '{"type":"user"}',
      '{"type":"user","message":{"content":"plain text"}}',
      '{"type":"user","message":{"content":[{"type":"tool_result"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"missing","content":[{"type":"image"}]}]}}',
      '{"type":"user","message":{"content":[{"type":"text","text":"not a result"}]}}',
    ]);

    assert.equal(eventsOfType(events, 'tool_call').length, 1);
    assert.equal(eventsOfType(events, 'tool_result').length, 2);
    assert.equal(eventsOfType(events, 'session_end').length, 1);
    assert.equal(eventsOfType(events, 'session_end')[0].status, 'completed');
  });
});

describe('collectClaudeEvents', () => {
  it('parses a whole capture and always ends the session', () => {
    const events = collectClaudeEvents(fixtureLines());

    assert.equal(events.length, 8);
    assert.deepEqual(events[events.length - 1], { type: 'session_end', status: 'completed' });

    assert.deepEqual(collectClaudeEvents(['{"type":"system","subtype":"init"}']), [
      { type: 'session_start', cliTool: 'claude_code', taskPromptHash: null },
      { type: 'session_end', status: 'completed' },
    ]);
  });

  it('keeps a failed result status instead of flushing a completed one', () => {
    const events = collectClaudeEvents(['{"type":"system","subtype":"init"}', '{"type":"result","subtype":"error_max_turns"}']);

    assert.deepEqual(eventsOfType(events, 'session_end'), [{ type: 'session_end', status: 'failed' }]);
  });
});
