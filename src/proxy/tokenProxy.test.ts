/**
 * Loopback token proxy tests (Piece C).
 *
 * Everything runs on `127.0.0.1` ephemeral ports: a fake upstream built with
 * `node:http` stands in for the provider, the proxy forwards to it, and `fetch`
 * plays the CLI. No real network, no `~/.loglode`, no fixed ports.
 */

import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import type { TokenUsage } from '../adapters/types.js';
import { startTokenProxy, type ProxyUsageFrame, type TokenProxy } from './tokenProxy.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeUpstream {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

type UpstreamHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
) => void | Promise<void>;

function listen(server: Server, port = 0): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address !== null && typeof address === 'object') resolve(address.port);
      else reject(new Error('fake upstream did not bind to a TCP port'));
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function startFakeUpstream(handler: UpstreamHandler): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: body.toString('utf8'),
      });
      Promise.resolve()
        .then(() => handler(req, res, body))
        .catch((error: unknown) => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(String(error));
        });
    });
  });
  const port = await listen(server);
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => closeServer(server) };
}

interface ProxyHarness {
  proxy: TokenProxy;
  frames: ProxyUsageFrame[];
  errors: Error[];
  close(): Promise<void>;
}

async function startProxy(upstreamBaseUrl: string): Promise<ProxyHarness> {
  const frames: ProxyUsageFrame[] = [];
  const errors: Error[] = [];
  const proxy = await startTokenProxy({
    upstreamBaseUrl,
    onUsage: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
  });
  return { proxy, frames, errors, close: () => proxy.close() };
}

async function postJson(
  baseUrl: string,
  path: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function connectionRefused(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const settle = (refused: boolean): void => {
      socket.destroy();
      resolve(refused);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => settle(false));
    socket.once('error', () => settle(true));
    socket.once('timeout', () => settle(false));
  });
}

function expectedUsage(usage: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}): TokenUsage {
  return usage;
}

// ---------------------------------------------------------------------------
// 1. Anthropic SSE — byte-identical passthrough, incremental line scanning
// ---------------------------------------------------------------------------

test('anthropic SSE: byte-identical passthrough and exactly one usage frame', async () => {
  const sseBody =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"cache_creation_input_tokens":12,"cache_read_input_tokens":34,"output_tokens":1}}}\n' +
    '\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n' +
    '\n' +
    'event: message_delta\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":10}}\n' +
    '\n' +
    'event: message_delta\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":56}}\n' +
    '\n' +
    'event: message_stop\n' +
    'data: {"type":"message_stop"}\n' +
    '\n';

  const upstream = await startFakeUpstream(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    res.flushHeaders();
    // Deliberately split mid-line and mid-JSON to exercise the partial-line buffer.
    const bytes = Buffer.from(sseBody, 'utf8');
    const cuts = [11, 37, 71, 113, 179, 251, 337];
    let cursor = 0;
    for (const cut of cuts) {
      const end = Math.min(cut, bytes.length);
      if (end <= cursor) continue;
      res.write(bytes.subarray(cursor, end));
      cursor = end;
      await delay(2);
    }
    res.write(bytes.subarray(cursor));
    res.end();
  });
  const harness = await startProxy(upstream.baseUrl);

  try {
    const response = await postJson(
      harness.proxy.baseUrl,
      '/v1/messages?beta=true',
      { model: 'claude-sonnet-4-5', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      { authorization: 'Bearer test-anthropic-key', 'anthropic-version': '2023-06-01' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(await response.text(), sseBody, 'client must receive the exact upstream bytes');

    await waitFor(() => harness.frames.length >= 1, 'anthropic SSE usage frame');
    await delay(50);
    assert.equal(harness.frames.length, 1, 'exactly one frame per completed request');

    const frame = harness.frames[0] as ProxyUsageFrame;
    assert.equal(frame.provider, 'anthropic');
    assert.equal(frame.model, 'claude-sonnet-4-5');
    assert.equal(frame.requestId, 1);
    assert.deepEqual(
      frame.usage,
      expectedUsage({ inputTokens: 100, cacheReadTokens: 34, cacheWriteTokens: 12, outputTokens: 56 }),
    );

    assert.equal(upstream.requests.length, 1);
    const forwarded = upstream.requests[0] as RecordedRequest;
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.url, '/v1/messages?beta=true');
    assert.equal(forwarded.headers.authorization, 'Bearer test-anthropic-key');
    assert.equal(forwarded.headers['anthropic-version'], '2023-06-01');
    assert.equal(forwarded.headers['content-type'], 'application/json');
    assert.equal(forwarded.headers.host, new URL(upstream.baseUrl).host);
    assert.deepEqual(JSON.parse(forwarded.body), {
      model: 'claude-sonnet-4-5',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.deepEqual(harness.errors, []);
  } finally {
    await harness.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 2. OpenAI JSON (non-streaming)
// ---------------------------------------------------------------------------

test('openai JSON: prompt/cached mapping, request headers and body forwarded', async () => {
  const completion = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 400 },
    },
  };
  const responseBody = JSON.stringify(completion);

  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-upstream': 'openai-json' });
    res.end(responseBody);
  });
  const harness = await startProxy(upstream.baseUrl);

  try {
    const response = await postJson(
      harness.proxy.baseUrl,
      '/v1/chat/completions',
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] },
      { authorization: 'Bearer test-openai-key' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-upstream'), 'openai-json');
    assert.equal(await response.text(), responseBody);

    await waitFor(() => harness.frames.length >= 1, 'openai JSON usage frame');
    const frame = harness.frames[0] as ProxyUsageFrame;
    assert.equal(harness.frames.length, 1);
    assert.equal(frame.provider, 'openai');
    assert.equal(frame.model, 'gpt-4o-mini');
    assert.equal(frame.requestId, 1);
    assert.deepEqual(
      frame.usage,
      expectedUsage({ inputTokens: 600, cacheReadTokens: 400, cacheWriteTokens: 0, outputTokens: 50 }),
    );

    assert.equal(upstream.requests.length, 1);
    assert.equal((upstream.requests[0] as RecordedRequest).headers.authorization, 'Bearer test-openai-key');
  } finally {
    await harness.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Anthropic JSON (non-streaming)
// ---------------------------------------------------------------------------

test('anthropic JSON: full-body usage mapping', async () => {
  const responseBody = JSON.stringify({
    id: 'msg_02',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-1',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 200,
      cache_creation_input_tokens: 25,
      cache_read_input_tokens: 75,
      output_tokens: 40,
    },
  });

  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(responseBody);
  });
  const harness = await startProxy(upstream.baseUrl);

  try {
    const response = await postJson(harness.proxy.baseUrl, '/v1/messages', {
      model: 'claude-opus-4-1',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), responseBody);

    await waitFor(() => harness.frames.length >= 1, 'anthropic JSON usage frame');
    const frame = harness.frames[0] as ProxyUsageFrame;
    assert.equal(harness.frames.length, 1);
    assert.equal(frame.provider, 'anthropic');
    assert.equal(frame.model, 'claude-opus-4-1');
    assert.deepEqual(
      frame.usage,
      expectedUsage({ inputTokens: 200, cacheReadTokens: 75, cacheWriteTokens: 25, outputTokens: 40 }),
    );
  } finally {
    await harness.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 4. SSE without usage events
// ---------------------------------------------------------------------------

test('SSE without usage events: passthrough works and no frame is emitted', async () => {
  const sseBody =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"id":"msg_03","model":"claude-haiku-4-5"}}\n' +
    '\n' +
    'event: ping\n' +
    'data: {"type":"ping"}\n' +
    '\n' +
    'event: message_stop\n' +
    'data: {"type":"message_stop"}\n' +
    '\n';

  const upstream = await startFakeUpstream(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseBody.slice(0, 20));
    await delay(2);
    res.end(sseBody.slice(20));
  });
  const harness = await startProxy(upstream.baseUrl);

  try {
    const response = await postJson(harness.proxy.baseUrl, '/v1/messages', {
      model: 'claude-haiku-4-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), sseBody);

    await delay(100);
    assert.deepEqual(harness.frames, []);
    assert.deepEqual(harness.errors, []);
  } finally {
    await harness.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Upstream error responses
// ---------------------------------------------------------------------------

test('upstream 500 passes through unchanged and yields no frame', async () => {
  const errorBody = '{"type":"error","error":{"type":"api_error","message":"upstream exploded"}}';
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'x-upstream-error': 'exploded' });
    res.end(errorBody);
  });
  const harness = await startProxy(upstream.baseUrl);

  try {
    const response = await postJson(harness.proxy.baseUrl, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-upstream-error'), 'exploded');
    assert.equal(await response.text(), errorBody);

    await delay(100);
    assert.deepEqual(harness.frames, [], 'error responses carry no usage frame');
    assert.deepEqual(harness.errors, [], 'an upstream error status is not a proxy error');
  } finally {
    await harness.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Sequential + concurrent requests on one proxy instance
// ---------------------------------------------------------------------------

test('sequential and concurrent requests get per-request frames and monotonic request ids', async () => {
  const upstream = await startFakeUpstream(async (_req, res, body) => {
    const parsed = JSON.parse(body.toString('utf8')) as { model: string };
    const index = Number(parsed.model.split('-').at(-1));
    // Even-numbered calls answer slower so the concurrent pair interleaves.
    await delay(index % 2 === 0 ? 25 : 1);
    const payload = JSON.stringify({
      id: `completion-${index}`,
      model: parsed.model,
      usage: {
        prompt_tokens: 100 + index,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  const harness = await startProxy(upstream.baseUrl);

  const send = async (index: number): Promise<{ index: number; status: number; text: string }> => {
    const response = await postJson(harness.proxy.baseUrl, '/v1/chat/completions', {
      model: `gpt-4o-mini-${index}`,
      messages: [{ role: 'user', content: `call ${index}` }],
    });
    return { index, status: response.status, text: await response.text() };
  };

  try {
    const first = await send(1);
    const second = await send(2);
    const concurrent = await Promise.all([send(3), send(4)]);

    for (const result of [first, second, ...concurrent]) {
      assert.equal(result.status, 200);
      const parsed = JSON.parse(result.text) as { id: string };
      assert.equal(parsed.id, `completion-${result.index}`, 'responses must not cross-route');
    }

    await waitFor(() => harness.frames.length >= 4, 'four usage frames');
    await delay(50);
    assert.equal(harness.frames.length, 4);

    const requestIds = harness.frames.map((frame) => frame.requestId).sort((a, b) => a - b);
    assert.deepEqual(requestIds, [1, 2, 3, 4], 'request ids increment per request');

    for (const frame of harness.frames) {
      const index = Number(frame.model.split('-').at(-1));
      assert.equal(frame.provider, 'openai');
      assert.deepEqual(
        frame.usage,
        expectedUsage({
          inputTokens: 100 + index - 40,
          cacheReadTokens: 40,
          cacheWriteTokens: 0,
          outputTokens: 7,
        }),
      );
    }
    assert.equal(upstream.requests.length, 4);
  } finally {
    await harness.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 7. close()
// ---------------------------------------------------------------------------

test('close() resolves, releases the port, and a new proxy can bind afterwards', async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'cmpl-close', usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
  const first = await startProxy(upstream.baseUrl);

  try {
    const response = await postJson(first.proxy.baseUrl, '/v1/chat/completions', { model: 'gpt-4o-mini' });
    assert.equal(response.status, 200);
    await response.text();
    await waitFor(() => first.frames.length === 1, 'frame before close');

    const closedPort = first.proxy.port;
    await first.proxy.close();
    await first.proxy.close(); // idempotent
    assert.equal(first.proxy.server.listening, false);
    assert.equal(await connectionRefused(closedPort), true, 'the ephemeral port must stop accepting connections');

    const second = await startProxy(upstream.baseUrl);
    try {
      assert.notEqual(second.proxy.port, closedPort);
      const secondResponse = await postJson(second.proxy.baseUrl, '/v1/chat/completions', { model: 'gpt-4o-mini' });
      assert.equal(secondResponse.status, 200);
      await secondResponse.text();
      await waitFor(() => second.frames.length === 1, 'frame from the second proxy');
      assert.equal((second.frames[0] as ProxyUsageFrame).requestId, 1, 'ids are per proxy instance');
    } finally {
      await second.proxy.close();
    }
  } finally {
    // `close()` is idempotent: this also covers an early assertion failure above.
    await first.proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Upstream connection failure
// ---------------------------------------------------------------------------

test('upstream connection failure responds 502, reports onError, emits no frame', async () => {
  const deadUpstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const deadBaseUrl = deadUpstream.baseUrl;
  await deadUpstream.close();

  const harness = await startProxy(deadBaseUrl);
  try {
    const response = await postJson(harness.proxy.baseUrl, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 502);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const payload = JSON.parse(await response.text()) as { error: string; message: string };
    assert.equal(payload.error, 'loglode_proxy_upstream_error');
    assert.equal(typeof payload.message, 'string');

    await waitFor(() => harness.errors.length >= 1, 'upstream error report');
    await delay(50);
    assert.equal(harness.errors.length, 1);
    assert.match(String(harness.errors[0]?.message), /ECONNREFUSED|connect|socket|refused/i);
    assert.deepEqual(harness.frames, [], 'failed calls yield no usage frame');
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// 9. gzip-compressed responses (real CLIs advertise gzip via fetch/undici)
// ---------------------------------------------------------------------------

test('gzip anthropic JSON: scanner decodes its copy, client receives exact wire bytes', async () => {
  const message = JSON.stringify({
    id: 'msg_04',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'compressed' }],
    usage: {
      input_tokens: 300,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 90,
      output_tokens: 20,
    },
  });
  const wireBody = gzipSync(Buffer.from(message, 'utf8'));

  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(wireBody);
  });
  const harness = await startProxy(upstream.baseUrl);

  try {
    // fetch/undici transparently decodes gzip, so `message` is what the client sees.
    const response = await postJson(harness.proxy.baseUrl, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), message);

    await waitFor(() => harness.frames.length >= 1, 'gzip JSON usage frame');
    assert.deepEqual(
      (harness.frames[0] as ProxyUsageFrame).usage,
      expectedUsage({ inputTokens: 300, cacheReadTokens: 90, cacheWriteTokens: 10, outputTokens: 20 }),
    );
  } finally {
    await harness.close();
    await upstream.close();
  }
});

test('gzip SSE: incremental decompression captures usage without buffering the stream', async () => {
  const sseBody =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"id":"msg_05","model":"claude-haiku-4-5","usage":{"input_tokens":40,"cache_creation_input_tokens":0,"cache_read_input_tokens":8,"output_tokens":1}}}\n' +
    '\n' +
    'event: message_delta\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n' +
    '\n';
  const wireBody = gzipSync(Buffer.from(sseBody, 'utf8'));

  const upstream = await startFakeUpstream(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    // Split the compressed stream so decompression is genuinely incremental.
    res.write(wireBody.subarray(0, 12));
    await delay(2);
    res.end(wireBody.subarray(12));
  });
  const harness = await startProxy(upstream.baseUrl);

  try {
    const response = await postJson(harness.proxy.baseUrl, '/v1/messages', {
      model: 'claude-haiku-4-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), sseBody);

    await waitFor(() => harness.frames.length >= 1, 'gzip SSE usage frame');
    assert.deepEqual(
      (harness.frames[0] as ProxyUsageFrame).usage,
      expectedUsage({ inputTokens: 40, cacheReadTokens: 8, cacheWriteTokens: 0, outputTokens: 12 }),
    );
  } finally {
    await harness.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 10. OpenAI Responses API stream shape (Codex CLI target)
// ---------------------------------------------------------------------------

test('openai Responses SSE: response.completed usage is mapped like chat completions', async () => {
  const sseBody =
    'event: response.completed\n' +
    'data: {"type":"response.completed","response":{"id":"resp_01","usage":{"input_tokens":120,"output_tokens":30,"input_tokens_details":{"cached_tokens":20}}}}\n' +
    '\n';

  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseBody);
  });
  const harness = await startProxy(upstream.baseUrl);

  try {
    const response = await postJson(harness.proxy.baseUrl, '/v1/responses', {
      model: 'gpt-5-codex',
      stream: true,
      input: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), sseBody);

    await waitFor(() => harness.frames.length >= 1, 'Responses API usage frame');
    const frame = harness.frames[0] as ProxyUsageFrame;
    assert.equal(frame.provider, 'openai');
    assert.equal(frame.model, 'gpt-5-codex');
    assert.deepEqual(
      frame.usage,
      expectedUsage({ inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 30 }),
    );
  } finally {
    await harness.close();
    await upstream.close();
  }
});
