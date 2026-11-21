/**
 * LogLode — loopback token proxy (architecture §2 "Loopback HTTP Proxy",
 * §3 Stage 2 "Dual-Layer Telemetry Capture").
 *
 * A single-process forwarder that binds an ephemeral `127.0.0.1` port. The
 * spawned CLI is pointed at it via `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, so
 * every provider call passes through here and exact token usage can be read off
 * the wire without relying on a CLI's structured-output stream.
 *
 * The proxy is deliberately a tee, not a buffer: response bytes are written to
 * the client as they arrive and only a passive copy is scanned for usage. SSE
 * bodies are scanned line-by-line with a partial-line buffer, so a multi-megabyte
 * stream never sits in memory. Non-streaming JSON bodies are buffered because the
 * document is complete, but a size guard keeps a pathological response from
 * exhausting memory.
 *
 * Usage semantics live in `TokenUsage` (src/adapters/types.ts):
 * `inputTokens` is *uncached* input, which is why the OpenAI mapping subtracts
 * `prompt_tokens_details.cached_tokens` from `prompt_tokens`.
 *
 * Zero runtime dependencies: `node:http`, `node:https`, and `node:zlib` only.
 * The zlib import exists to scan gzip/deflate/brotli-compressed provider
 * responses; those bytes are still forwarded untouched.
 */

import {
  Agent as HttpAgent,
  createServer as createHttpServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Duplex, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { brotliDecompressSync, createBrotliDecompress, createUnzip, unzipSync } from 'node:zlib';

import type { TokenUsage } from '../adapters/types.js';

export interface ProxyUsageFrame {
  provider: 'anthropic' | 'openai';
  /** Model name from the request body's `model` field, or `'unknown'`. */
  model: string;
  /** Exact usage in `TokenUsage` semantics (`inputTokens` = uncached input). */
  usage: TokenUsage;
  /** Per-proxy monotonically increasing counter (1, 2, ...). */
  requestId: number;
}

export interface TokenProxyOptions {
  /** Upstream origin, e.g. `https://api.anthropic.com` or a loopback test server. */
  upstreamBaseUrl: string;
  /** Called exactly once per completed request that yielded usage. */
  onUsage: (frame: ProxyUsageFrame) => void;
  onError?: (error: Error, context?: { requestId?: number }) => void;
}

export interface TokenProxy {
  port: number;
  /** `http://127.0.0.1:<port>` — value for ANTHROPIC_BASE_URL / OPENAI_BASE_URL. */
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

/** Request-side model capture is best effort; anything larger is streamed as-is. */
const MAX_REQUEST_CAPTURE_BYTES = 32 * 1024 * 1024;
/** Response bodies above this size are still forwarded but not scanned for usage. */
const MAX_RESPONSE_CAPTURE_BYTES = 32 * 1024 * 1024;
/** A single SSE `data:` line larger than this is treated as garbage and dropped. */
const MAX_SSE_LINE_LENGTH = 8 * 1024 * 1024;
/** Socket-inactivity budget for connecting and receiving response headers. */
const UPSTREAM_RESPONSE_TIMEOUT_MS = 120_000;

/** Connection-scoped headers that must not be forwarded by a single-hop proxy. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type Provider = ProxyUsageFrame['provider'];
type ScanMode = 'sse' | 'json' | 'none';
type ContentEncoding = 'identity' | 'gzip' | 'deflate' | 'br' | 'unsupported';

/**
 * Bind the loopback proxy on `127.0.0.1:0` and resolve once it is accepting
 * connections. Resolves with the ephemeral port and the matching base URL.
 */
export async function startTokenProxy(options: TokenProxyOptions): Promise<TokenProxy> {
  if (typeof options.onUsage !== 'function') {
    throw new TypeError('startTokenProxy: options.onUsage must be a function');
  }
  const upstream = parseUpstreamUrl(options.upstreamBaseUrl);
  const runtime = new ProxyRuntime(upstream, options.onUsage, options.onError);

  const server = createHttpServer((req, res) => runtime.handle(req, res));
  const sockets = new Set<Duplex>();
  server.on('connection', (socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const port = await listenOnEphemeralPort(server);
  // Listening succeeded; anything after this is a runtime server error.
  server.on('error', (error: Error) => runtime.reportServerError(error));

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
      // A CLI (or fetch/undici keep-alive pool) can hold sockets open forever.
      // Drop them so the ephemeral port is actually released.
      server.closeIdleConnections();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      runtime.dispose();
    });
    return closePromise;
  };

  return { port, baseUrl: `http://127.0.0.1:${port}`, server, close };
}

// ---------------------------------------------------------------------------
// Runtime: one instance per proxy, owns request ids and upstream agents.
// ---------------------------------------------------------------------------

interface RequestState {
  requestId: number;
  provider: Provider;
  collector: UsageCollector;
  model: string;
}

class ProxyRuntime {
  private nextRequestId = 1;
  private readonly upstream: URL;
  private readonly onUsage: (frame: ProxyUsageFrame) => void;
  private readonly onError: TokenProxyOptions['onError'];
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;

  constructor(upstream: URL, onUsage: (frame: ProxyUsageFrame) => void, onError: TokenProxyOptions['onError']) {
    this.upstream = upstream;
    this.onUsage = onUsage;
    this.onError = onError;
    this.httpAgent = new HttpAgent({ keepAlive: true });
    this.httpsAgent = new HttpsAgent({ keepAlive: true });
  }

  dispose(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  reportServerError(error: Error): void {
    this.reportError(error);
  }

  /** Entry point for every HTTP request. Never throws. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const requestId = this.nextRequestId++;
    try {
      this.forward(req, res, requestId);
    } catch (error) {
      const failure = toError(error);
      this.reportError(failure, requestId);
      this.respondBadGateway(res, failure);
    }
  }

  private reportError(error: Error, requestId?: number): void {
    const handler = this.onError;
    if (handler === undefined) return;
    try {
      handler(error, requestId === undefined ? undefined : { requestId });
    } catch {
      // An error reporter that throws must not break the proxy.
    }
  }

  private emitUsage(frame: ProxyUsageFrame): void {
    try {
      this.onUsage(frame);
    } catch (error) {
      this.reportError(toError(error), frame.requestId);
    }
  }

  private forward(req: IncomingMessage, res: ServerResponse, requestId: number): void {
    const rawUrl = req.url !== undefined && req.url.length > 0 ? req.url : '/';
    const provider = classifyProvider(rawUrl);
    const state: RequestState = {
      requestId,
      provider,
      collector: new UsageCollector(provider),
      model: 'unknown',
    };
    const upstreamReq = this.buildUpstreamRequest(req, rawUrl);

    let clientGone = false;
    let forwardingStopped = false;
    let responseStarted = false;
    let responseCompleted = false;
    let errorReported = false;
    const requestChunks: Buffer[] = [];
    let requestBytes = 0;
    // Honour an oversized Content-Length up front instead of buffering 32 MB first.
    const declaredLength = Number(headerValue(req.headers['content-length']));
    let requestOverflow =
      Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_CAPTURE_BYTES;

    const reportOnce = (error: Error): void => {
      if (errorReported) return;
      errorReported = true;
      this.reportError(error, requestId);
    };

    const abortUpstream = (): void => {
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    };

    const fail = (error: Error): void => {
      if (responseCompleted || clientGone) return;
      forwardingStopped = true;
      abortUpstream();
      if (responseStarted) {
        if (!res.writableEnded && !res.destroyed) res.destroy();
      } else {
        this.respondBadGateway(res, error);
      }
      reportOnce(error);
    };

    const markClientGone = (): void => {
      if (clientGone) return;
      clientGone = true;
      forwardingStopped = true;
      abortUpstream();
      try {
        if (!req.destroyed) req.resume();
      } catch {
        // Draining a torn-down request is best effort.
      }
    };

    // Client-side lifecycle: abort the upstream call when the CLI disappears.
    res.on('close', () => {
      if (!res.writableFinished) markClientGone();
    });
    res.on('error', () => {
      markClientGone();
    });
    req.on('aborted', markClientGone);
    req.on('error', (error: unknown) => {
      markClientGone();
      reportOnce(toError(error));
    });

    // --- Request tee: forward bytes immediately, keep a bounded copy to parse `model`.
    req.on('data', (chunk: Buffer) => {
      try {
        if (forwardingStopped) return;
        if (!requestOverflow) {
          requestBytes += chunk.length;
          if (requestBytes > MAX_REQUEST_CAPTURE_BYTES) {
            requestOverflow = true;
            requestChunks.length = 0;
          } else {
            requestChunks.push(chunk);
          }
        }
        if (upstreamReq.destroyed || upstreamReq.writableEnded) return;
        if (!upstreamReq.write(chunk)) {
          req.pause();
          upstreamReq.once('drain', () => {
            if (!forwardingStopped && !clientGone) req.resume();
          });
        }
      } catch (error) {
        // A broken request/upstream pipe must become a 502, never an uncaught throw.
        fail(toError(error));
      }
    });

    req.on('end', () => {
      try {
        if (!requestOverflow && requestChunks.length > 0) {
          const parsed: unknown = JSON.parse(Buffer.concat(requestChunks).toString('utf8'));
          if (isRecord(parsed) && typeof parsed.model === 'string' && parsed.model.trim().length > 0) {
            state.model = parsed.model;
          }
        }
      } catch {
        // Non-JSON request bodies simply do not yield a model name.
      }
      requestChunks.length = 0;
      if (!forwardingStopped && !clientGone && !upstreamReq.destroyed) upstreamReq.end();
    });

    upstreamReq.setTimeout(UPSTREAM_RESPONSE_TIMEOUT_MS, () => {
      // Only the connect/time-to-first-byte phase can produce a clean 502; once a
      // body (especially a long generation) is streaming, the client owns timeouts.
      if (!responseStarted) {
        fail(new Error(`Upstream ${this.upstream.origin} timed out after ${UPSTREAM_RESPONSE_TIMEOUT_MS}ms`));
      }
    });

    upstreamReq.on('error', (error: unknown) => {
      fail(toError(error));
    });

    upstreamReq.on('response', (upstreamRes: IncomingMessage) => {
      if (clientGone || responseCompleted || responseStarted || res.destroyed || res.writableEnded) {
        upstreamRes.destroy();
        return;
      }
      responseStarted = true;
      upstreamReq.setTimeout(0); // Headers arrived: stop policing an in-flight body.

      const scanner = createResponseScanner(state.provider, state.collector, upstreamRes.headers);
      upstreamRes.on('error', (error: unknown) => {
        scanner.dispose();
        fail(toError(error));
      });
      upstreamRes.on('close', () => {
        if (!upstreamRes.complete) {
          scanner.dispose();
          fail(new Error('Upstream response closed before the full body was received'));
        }
      });
      upstreamRes.on('data', (chunk: Buffer) => {
        try {
          scanner.push(chunk);
        } catch {
          // Usage capture must never interfere with the passthrough.
        }
      });
      upstreamRes.on('end', () => {
        responseCompleted = true;
        scanner.end(() => {
          const usage = state.collector.toUsage();
          if (usage === undefined) return;
          this.emitUsage({ provider: state.provider, model: state.model, usage, requestId });
        });
      });

      try {
        const statusCode = upstreamRes.statusCode ?? 502;
        const responseHeaders = buildDownstreamResponseHeaders(upstreamRes.headers);
        if (upstreamRes.statusMessage !== undefined && upstreamRes.statusMessage.length > 0) {
          res.writeHead(statusCode, upstreamRes.statusMessage, responseHeaders);
        } else {
          res.writeHead(statusCode, responseHeaders);
        }
        res.flushHeaders();
      } catch (error) {
        responseStarted = false;
        scanner.dispose();
        upstreamRes.destroy();
        fail(toError(error));
        return;
      }

      // Bytes flow to the client untouched; the scanner above is a passive copy.
      upstreamRes.pipe(res);
    });
  }

  private buildUpstreamRequest(req: IncomingMessage, rawUrl: string): ClientRequest {
    const target = this.upstream;
    const secure = target.protocol === 'https:';
    const options: RequestOptions = {
      agent: secure ? this.httpsAgent : this.httpAgent,
      hostname: stripIpv6Brackets(target.hostname),
      method: req.method ?? 'GET',
      path: joinUpstreamPath(target, rawUrl),
      port: target.port.length > 0 ? Number(target.port) : secure ? 443 : 80,
      protocol: target.protocol,
      headers: buildUpstreamRequestHeaders(req.headers, target),
    };
    return secure ? httpsRequest(options) : httpRequest(options);
  }

  private respondBadGateway(res: ServerResponse, error: Error): void {
    if (res.headersSent || res.writableEnded || res.destroyed) {
      if (!res.writableEnded && !res.destroyed) res.destroy();
      return;
    }
    const payload = JSON.stringify({ error: 'loglode_proxy_upstream_error', message: error.message });
    try {
      res.writeHead(502, 'Bad Gateway', {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(payload)),
        'cache-control': 'no-store',
      });
      res.end(payload);
    } catch {
      try {
        res.destroy();
      } catch {
        // Nothing left to do for this connection.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Usage capture: provider-specific token mapping.
// ---------------------------------------------------------------------------

class UsageCollector {
  private anthropicInput?: number;
  private anthropicCacheWrite?: number;
  private anthropicCacheRead?: number;
  private anthropicOutput?: number;
  private openaiPrompt?: number;
  private openaiCompletion?: number;
  private openaiCached?: number;
  private sawUsage = false;

  constructor(private readonly provider: Provider) {}

  applyAnthropic(usage: Record<string, unknown>): void {
    this.sawUsage = true;
    this.anthropicInput = readTokenCount(usage.input_tokens) ?? this.anthropicInput;
    this.anthropicCacheWrite = readTokenCount(usage.cache_creation_input_tokens) ?? this.anthropicCacheWrite;
    this.anthropicCacheRead = readTokenCount(usage.cache_read_input_tokens) ?? this.anthropicCacheRead;
    // Streaming sends a cumulative output count in each `message_delta`; last wins.
    this.anthropicOutput = readTokenCount(usage.output_tokens) ?? this.anthropicOutput;
  }

  applyOpenAi(usage: Record<string, unknown>): void {
    this.sawUsage = true;
    // Chat Completions uses prompt_tokens/completion_tokens; the Responses API
    // uses input_tokens/output_tokens. Accept either so `/v1/responses` works.
    const prompt = readTokenCount(usage.prompt_tokens) ?? readTokenCount(usage.input_tokens);
    if (prompt !== undefined) this.openaiPrompt = prompt;
    const completion = readTokenCount(usage.completion_tokens) ?? readTokenCount(usage.output_tokens);
    if (completion !== undefined) this.openaiCompletion = completion;
    const details = isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : isRecord(usage.input_tokens_details)
        ? usage.input_tokens_details
        : undefined;
    const cached = details === undefined ? undefined : readTokenCount(details.cached_tokens);
    if (cached !== undefined) this.openaiCached = cached;
  }

  /** `undefined` when the response carried no usage at all. */
  toUsage(): TokenUsage | undefined {
    if (!this.sawUsage) return undefined;
    if (this.provider === 'anthropic') {
      return {
        inputTokens: this.anthropicInput ?? 0,
        cacheReadTokens: this.anthropicCacheRead ?? 0,
        cacheWriteTokens: this.anthropicCacheWrite ?? 0,
        outputTokens: this.anthropicOutput ?? 0,
      };
    }
    const prompt = this.openaiPrompt ?? 0;
    const cached = this.openaiCached ?? 0;
    return {
      // TokenUsage.inputTokens is the *uncached* remainder.
      inputTokens: Math.max(0, prompt - cached),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      outputTokens: this.openaiCompletion ?? 0,
    };
  }
}

/**
 * Incremental SSE line splitter. Holds at most one partial line, so usage can be
 * read from a stream of any length without buffering the stream itself.
 */
class SseLineScanner {
  private buffer = '';
  private readonly onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  push(text: string): void {
    if (text.length === 0) return;
    this.buffer += text;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      const rawLine = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.emit(rawLine);
    }
    if (this.buffer.length > MAX_SSE_LINE_LENGTH) this.buffer = '';
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const rawLine = this.buffer;
    this.buffer = '';
    this.emit(rawLine);
  }

  private emit(rawLine: string): void {
    this.onLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
  }
}

/**
 * Scans a conversation's response copy for usage without touching the bytes the
 * client receives. Three modes:
 *  - `sse`:  incremental `data:` line scan (optionally through a decompressor)
 *  - `json`: whole-document parse once the body ends (bounded by a size guard)
 *  - `none`: content type carries no usage; do nothing
 */
class ResponseScanner {
  private readonly provider: Provider;
  private readonly collector: UsageCollector;
  private readonly mode: ScanMode;
  private readonly encoding: ContentEncoding;
  private readonly lines: SseLineScanner;
  private readonly plainDecoder?: StringDecoder;
  private readonly decodedText?: StringDecoder;
  private readonly decompressor?: Transform;
  private readonly jsonChunks: Buffer[] = [];
  private jsonBytes = 0;
  private jsonOverflow = false;
  private done = false;
  private finishedHandler?: () => void;

  constructor(provider: Provider, collector: UsageCollector, mode: ScanMode, encoding: ContentEncoding) {
    this.provider = provider;
    this.collector = collector;
    this.mode = mode;
    this.encoding = encoding;
    this.lines = new SseLineScanner((line) => this.handleSseLine(line));

    if (mode !== 'sse') return;
    if (encoding === 'identity') {
      this.plainDecoder = new StringDecoder('utf8');
      return;
    }
    if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') {
      const decompressor = encoding === 'br' ? createBrotliDecompress() : createUnzip();
      const textDecoder = new StringDecoder('utf8');
      decompressor.on('data', (chunk: Buffer) => {
        if (this.done) return;
        this.lines.push(textDecoder.write(chunk));
      });
      decompressor.on('end', () => this.complete());
      decompressor.on('error', () => this.complete());
      decompressor.on('close', () => this.complete());
      this.decompressor = decompressor;
      this.decodedText = textDecoder;
    }
  }

  push(chunk: Buffer): void {
    if (this.done || chunk.length === 0) return;
    if (this.mode === 'json') {
      this.pushJson(chunk);
      return;
    }
    if (this.mode !== 'sse') return;
    if (this.plainDecoder !== undefined) {
      this.lines.push(this.plainDecoder.write(chunk));
      return;
    }
    if (this.decompressor !== undefined) this.decompressor.write(chunk);
  }

  /** Flush any buffered state and invoke `onFinished` exactly once. */
  end(onFinished: () => void): void {
    if (this.done) return;
    this.finishedHandler = onFinished;
    if (this.decompressor !== undefined) {
      this.decompressor.end();
      return;
    }
    this.complete();
  }

  /** Abandon scanning (client/upstream failure). Never invokes the finish handler. */
  dispose(): void {
    if (this.done) return;
    this.done = true;
    this.finishedHandler = undefined;
    this.jsonChunks.length = 0;
    if (this.decompressor !== undefined) {
      try {
        this.decompressor.destroy();
      } catch {
        // Destroying a torn-down decompressor is best effort.
      }
    }
  }

  private complete(): void {
    if (this.done) return;
    this.done = true;
    if (this.mode === 'sse') {
      if (this.plainDecoder !== undefined) this.lines.push(this.plainDecoder.end());
      if (this.decodedText !== undefined) this.lines.push(this.decodedText.end());
      this.lines.flush();
    } else if (this.mode === 'json') {
      this.parseJsonBody();
    }
    const handler = this.finishedHandler;
    this.finishedHandler = undefined;
    if (handler !== undefined) handler();
  }

  private pushJson(chunk: Buffer): void {
    if (this.jsonOverflow) return;
    this.jsonBytes += chunk.length;
    if (this.jsonBytes > MAX_RESPONSE_CAPTURE_BYTES) {
      this.jsonOverflow = true;
      this.jsonChunks.length = 0;
      return;
    }
    this.jsonChunks.push(chunk);
  }

  private parseJsonBody(): void {
    // Copy first: clearing the instance array must not empty the local handle.
    const chunks = this.jsonChunks.splice(0, this.jsonChunks.length);
    if (chunks.length === 0) return;
    const text = decodeBodyText(Buffer.concat(chunks), this.encoding);
    if (text === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(parsed) || !isRecord(parsed.usage)) return;
    if (this.provider === 'anthropic') this.collector.applyAnthropic(parsed.usage);
    else this.collector.applyOpenAi(parsed.usage);
  }

  private handleSseLine(line: string): void {
    if (!line.startsWith('data:')) return;
    let payload = line.slice('data:'.length).trim();
    if (payload.length === 0 || payload === '[DONE]') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // Malformed frames are ignored; streaming continues.
    }
    if (!isRecord(parsed)) return;
    applyStreamEvent(this.provider, parsed, this.collector);
  }
}

function applyStreamEvent(provider: Provider, event: Record<string, unknown>, collector: UsageCollector): void {
  if (provider === 'anthropic') {
    if (event.type === 'message_start') {
      const message = event.message;
      if (isRecord(message) && isRecord(message.usage)) {
        collector.applyAnthropic(message.usage);
        return;
      }
    }
    if (isRecord(event.usage)) collector.applyAnthropic(event.usage);
    return;
  }
  // OpenAI chat-completions streams put `usage` on the final chunk; the
  // Responses API wraps it in a `response.completed` event.
  if (isRecord(event.usage)) {
    collector.applyOpenAi(event.usage);
    return;
  }
  if (event.type === 'response.completed') {
    const response = event.response;
    if (isRecord(response) && isRecord(response.usage)) collector.applyOpenAi(response.usage);
  }
}

function createResponseScanner(
  provider: Provider,
  collector: UsageCollector,
  headers: IncomingHttpHeaders,
): ResponseScanner {
  const contentType = headerValue(headers['content-type']).toLowerCase();
  const encoding = parseContentEncoding(headers['content-encoding']);

  let mode: ScanMode;
  if (contentType.includes('text/event-stream')) mode = 'sse';
  else if (contentType.includes('json') || contentType.length === 0) mode = 'json';
  else mode = 'none';

  // Encodings we cannot decode would turn the scan into noise.
  if (mode !== 'none' && encoding === 'unsupported') mode = 'none';

  return new ResponseScanner(provider, collector, mode, encoding);
}

function decodeBodyText(buffer: Buffer, encoding: ContentEncoding): string | undefined {
  if (encoding === 'identity') return buffer.toString('utf8');
  if (encoding === 'unsupported') return undefined;
  try {
    if (encoding === 'br') return brotliDecompressSync(buffer).toString('utf8');
    // `unzipSync` detects gzip and zlib-wrapped deflate.
    return unzipSync(buffer).toString('utf8');
  } catch {
    return undefined;
  }
}

function parseContentEncoding(value: string | string[] | undefined): ContentEncoding {
  const raw = headerValue(value).trim().toLowerCase();
  if (raw.length === 0 || raw === 'identity') return 'identity';
  if (raw === 'gzip' || raw === 'x-gzip') return 'gzip';
  if (raw === 'deflate') return 'deflate';
  if (raw === 'br') return 'br';
  return 'unsupported';
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseUpstreamUrl(rawBaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new TypeError(`startTokenProxy: upstreamBaseUrl is not a valid URL: ${rawBaseUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`startTokenProxy: upstreamBaseUrl must use http or https (got ${parsed.protocol})`);
  }
  if (parsed.hostname.length === 0) {
    throw new TypeError(`startTokenProxy: upstreamBaseUrl must include a host: ${rawBaseUrl}`);
  }
  return parsed;
}

function joinUpstreamPath(base: URL, requestUrl: string): string {
  const basePath = base.pathname.replace(/\/+$/, '');
  const suffix = requestUrl.startsWith('/') ? requestUrl : `/${requestUrl}`;
  return `${basePath}${suffix}`;
}

function buildUpstreamRequestHeaders(
  incoming: IncomingHttpHeaders,
  upstream: URL,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    // `expect: 100-continue` is already satisfied by the proxy itself (Node
    // answers the client's Expect automatically), so it must not be replayed.
    if (name === 'host' || name === 'expect' || HOP_BY_HOP_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  // Route to the upstream origin, not to the proxy's own ephemeral port.
  headers.host = upstream.host;
  return headers;
}

function buildDownstreamResponseHeaders(incoming: IncomingHttpHeaders): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function classifyProvider(rawUrl: string): Provider {
  if (rawUrl.includes('/v1/messages')) return 'anthropic';
  if (rawUrl.includes('/chat/completions') || rawUrl.includes('/v1/responses')) return 'openai';
  return 'anthropic';
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : '';
  return value ?? '';
}

function readTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value < 0 ? 0 : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : `Non-error value thrown: ${String(value)}`);
}

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address !== null && typeof address === 'object') resolve(address.port);
      else reject(new Error('startTokenProxy: server did not bind to a TCP port'));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}
