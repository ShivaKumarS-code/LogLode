#!/usr/bin/env node
/**
 * Test-only stand-in for `claude --output-format stream-json`.
 *
 * The pipeline spawns this file with `process.execPath` (i.e. `node fake-claude.mjs`),
 * so it must be dependency-free, side-effect-limited, and deterministic. It emits a
 * realistic stream-json session (system init, two assistant turns, matching tool
 * results, a final result frame) and makes one real HTTP POST through the LogLode
 * loopback proxy, which is how the pipeline captures provider usage.
 *
 * Environment contract:
 * - `ANTHROPIC_BASE_URL`  — the proxy URL to POST to. Unset: no request is made.
 * - `FAKE_REPO_ROOT`      — absolute repo root used to build the tool-call paths.
 *                           The pipeline must relativize them before persisting.
 * - `FAKE_ABORT=1`        — loop the POST many times with small delays so a tiny
 *                           `--budget` can kill this process mid-flight.
 * - `FAKE_DONE_FILE`      — path written once the (possibly looping) requests are
 *                           finished and before the final frames. A killed run
 *                           therefore never creates it, which lets tests prove the
 *                           SIGINT actually landed.
 *
 * tsc never sees this file (`.mjs`, `allowJs` off); it cannot affect `npm run build`.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.env.FAKE_REPO_ROOT ?? process.cwd();
const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '');
const model = 'claude-haiku-4-5';
const appPath = join(repoRoot, 'src', 'app.ts');

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function postMessages() {
  if (baseUrl === '') {
    return;
  }
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'fake-test-key' },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Summarize the repository state.' }],
      }),
    });
    // Drain the SSE body: the proxy forwards it untouched and scans a copy for usage.
    await response.text();
  } catch {
    // A missing/failed upstream must not prevent the synthetic stream from ending.
  }
}

emit({
  type: 'system',
  subtype: 'init',
  session_id: 'fake-claude-session',
  model,
  tools: ['Read', 'Bash', 'Edit'],
});

// Turn 1: a read of an ABSOLUTE path plus a failing shell command. The absolute
// path is deliberate: it is what the pipeline must relativize for the store.
emit({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me inspect the app entry point and run the unit tests.' },
      {
        type: 'tool_use',
        id: 'toolu_read_01',
        name: 'Read',
        input: { file_path: appPath },
      },
      {
        type: 'tool_use',
        id: 'toolu_bash_01',
        name: 'Bash',
        input: { command: 'pytest tests/unit -q --tb=short tests/unit/test_app.py' },
      },
    ],
  },
});

emit({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_read_01',
        is_error: false,
        content: [{ type: 'text', text: 'export function app(): string {\n  return "ok";\n}\n' }],
      },
    ],
  },
});

emit({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_bash_01',
        is_error: true,
        content: [
          {
            type: 'text',
            text: 'FAILED tests/unit/test_app.py::test_app - AssertionError: expected 1 got 2\n1 failed, 3 passed in 0.42s\n',
          },
        ],
      },
    ],
  },
});

// Provider usage must come from the proxy, not from this stream: the pipeline
// ignores `usage` fields here on purpose.
if (process.env.FAKE_ABORT === '1') {
  for (let index = 0; index < 15; index += 1) {
    await postMessages();
    await sleep(40);
  }
} else {
  await postMessages();
  // Give the proxy a beat to finish scanning the response before this process
  // exits and the pipeline closes the proxy.
  await sleep(60);
}

if (process.env.FAKE_DONE_FILE) {
  writeFileSync(process.env.FAKE_DONE_FILE, 'done\n', 'utf8');
}

// Turn 2: an edit of the same path the read targeted.
emit({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'The returned value is wrong; fixing it.' },
      {
        type: 'tool_use',
        id: 'toolu_edit_01',
        name: 'Edit',
        input: { file_path: appPath, old_string: 'return "ok";', new_string: 'return "1";' },
      },
    ],
  },
});

emit({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_edit_01',
        is_error: false,
        content: [{ type: 'text', text: 'The file has been updated.' }],
      },
    ],
  },
});

emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1234,
  num_turns: 2,
  session_id: 'fake-claude-session',
  total_cost_usd: 0.001,
  usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
});
