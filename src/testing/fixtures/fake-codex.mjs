#!/usr/bin/env node
/**
 * Test-only stand-in for `codex exec --json`.
 *
 * Emits the JSONL shapes `createCodexEventParser` understands (`thread.started`,
 * `item.completed` for a command execution and a file change, `turn.completed`
 * with usage) and makes one real HTTP POST through the LogLode loopback proxy so
 * provider usage is captured by the proxy, exactly like the Claude fixture.
 *
 * Environment contract:
 * - `OPENAI_BASE_URL` — the proxy URL to POST to. Unset: no request is made.
 * - `FAKE_REPO_ROOT`  — absolute repo root used to build the changed-file path.
 *                       The pipeline must relativize it before persisting.
 *
 * tsc never sees this file (`.mjs`, `allowJs` off).
 */

import { join } from 'node:path';

const repoRoot = process.env.FAKE_REPO_ROOT ?? process.cwd();
const baseUrl = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const changedPath = join(repoRoot, 'src', 'codex-file.ts');

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

emit({ type: 'thread.started', thread_id: 'fake-codex-thread' });
emit({ type: 'turn.started', thread_id: 'fake-codex-thread' });

emit({
  type: 'item.completed',
  item: {
    id: 'item_cmd_1',
    type: 'command_execution',
    command: 'vitest --run tests/app.test.ts',
    aggregated_output: '1 passed (12ms)\n',
    exit_code: 0,
  },
});

emit({
  type: 'item.completed',
  item: {
    id: 'item_file_1',
    type: 'file_change',
    status: 'completed',
    changes: [{ path: changedPath, kind: 'update' }],
  },
});

if (baseUrl !== '') {
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer fake-test-key' },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: 'Summarize the failing test.' }],
      }),
    });
    // Non-streaming JSON: the proxy scans the whole body for `usage`.
    await response.text();
  } catch {
    // A missing/failed upstream must not abort the synthetic stream.
  }
  // Let the proxy finish scanning before this process exits.
  await sleep(60);
}

emit({
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, total_tokens: 15 },
});

process.exitCode = 0;
