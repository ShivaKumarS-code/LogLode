/**
 * Claude Code adapter: spawn specification plus a stateful `stream-json` parser.
 *
 * Two process-free responsibilities, so both can be tested without the real
 * `claude` binary:
 *
 * 1. **Spawn spec.** Architecture §2 "CLI Adapters" requires structured tool/turn
 *    events, and §2 "Context Injector" / §3 Stage 1 require distilled micro-skills
 *    to arrive in a *static* system-prompt slot so later turns hit the provider's
 *    prompt cache. So the args must force `--output-format stream-json` and
 *    `--verbose`, and injected skills must ride in via
 *    `--append-system-prompt-file`. `ANTHROPIC_BASE_URL` is pointed at the
 *    loopback proxy (architecture §3 Stage 2) while every other environment
 *    variable is passed through untouched, because losing the user's auth token
 *    would break the child.
 * 2. **Event parser.** Maps Claude Code's one-JSON-object-per-line output onto
 *    the normalized `CliEvent` union. `stream-json` carries no turn numbers, so
 *    the parser is stateful: it counts assistant messages and remembers which
 *    turn each `tool_use_id` belonged to, letting the matching `tool_result`
 *    inherit it.
 *
 * Usage frames are ignored on purpose: the loopback token proxy is the billing
 * source of truth (architecture §2 "Loopback HTTP Proxy"), and the CLI's inline
 * usage is aggregated/partial, so consuming it here would double count.
 */

import { createHash } from 'node:crypto';

import { normalizeRepoPath } from '../repo.js';
import { estimateTokens } from '../tokenize.js';
import type { CliEvent } from './types.js';

/** Flags that make Claude Code emit the structured stream this parser consumes. */
const OUTPUT_FORMAT_FLAG = '--output-format';
const OUTPUT_FORMAT_STREAM_JSON = 'stream-json';
const VERBOSE_FLAG = '--verbose';
const SYSTEM_PROMPT_FILE_FLAG = '--append-system-prompt-file';

/** A decoded JSON object; `stream-json` payloads are always objects. */
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reduce a shell command to a deduplication signature.
 *
 * Waste mining groups repeated commands across sessions, so the signature must be
 * stable while ignoring one-off arguments (test file names, commit messages).
 * Keep the binary plus every flag and drop the remaining positional tokens:
 * `pytest tests/unit -q --tb=short extra.py` becomes `pytest -q --tb=short`.
 * This is an identity key, not a faithful reproduction of the command line —
 * quoting and argument order are not preserved, which is fine for grouping.
 */
export function normalizeCommandSignature(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 0) {
    return '';
  }

  const kept: string[] = [tokens[0]];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith('-')) {
      kept.push(token);
    }
  }
  return kept.join(' ');
}

function isOutputFormatFlag(arg: string): boolean {
  return arg === OUTPUT_FORMAT_FLAG || arg.startsWith(`${OUTPUT_FORMAT_FLAG}=`);
}

function isVerboseFlag(arg: string): boolean {
  return arg === VERBOSE_FLAG || arg.startsWith(`${VERBOSE_FLAG}=`);
}

/**
 * Build the argument vector for a headless Claude Code run.
 *
 * User arguments are preserved verbatim and in order; the required flags are only
 * appended when the caller has not already supplied them, so a `--output-format`
 * override is not silently doubled. The system-prompt file is appended last so
 * that, if a caller already passed the flag, the injected micro-skills win.
 */
export function buildClaudeArgs(opts: { agentArgs: string[]; systemPromptFilePath?: string | null }): string[] {
  const args = [...opts.agentArgs];

  if (!args.some(isOutputFormatFlag)) {
    args.push(OUTPUT_FORMAT_FLAG, OUTPUT_FORMAT_STREAM_JSON);
  }
  if (!args.some(isVerboseFlag)) {
    args.push(VERBOSE_FLAG);
  }
  if (opts.systemPromptFilePath !== undefined && opts.systemPromptFilePath !== null) {
    args.push(SYSTEM_PROMPT_FILE_FLAG, opts.systemPromptFilePath);
  }

  return args;
}

/**
 * Build the child environment: a shallow copy of the parent environment with
 * `ANTHROPIC_BASE_URL` repointed at the local proxy when one is given.
 *
 * The copy is essential — mutating `process.env` would leak the proxy URL into
 * later sessions — and no variable is ever removed, because `ANTHROPIC_API_KEY`
 * and friends must reach the child unchanged. A `null` base URL leaves any
 * inherited value alone.
 */
export function buildClaudeEnv(opts: { anthropicBaseUrl?: string | null; parentEnv: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...opts.parentEnv };
  if (opts.anthropicBaseUrl !== undefined && opts.anthropicBaseUrl !== null) {
    env.ANTHROPIC_BASE_URL = opts.anthropicBaseUrl;
  }
  return env;
}

/**
 * Compose the full spawn specification handed to `child_process.spawn`.
 * `command` defaults to `claude`; the CLI pipeline owns the actual spawn, stdio,
 * and signal handling.
 */
export function buildClaudeSpawn(opts: {
  command?: string;
  agentArgs: string[];
  systemPromptFilePath?: string | null;
  anthropicBaseUrl?: string | null;
  parentEnv: NodeJS.ProcessEnv;
}): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: opts.command ?? 'claude',
    args: buildClaudeArgs({ agentArgs: opts.agentArgs, systemPromptFilePath: opts.systemPromptFilePath }),
    env: buildClaudeEnv({ anthropicBaseUrl: opts.anthropicBaseUrl, parentEnv: opts.parentEnv }),
  };
}

/**
 * Incremental parser for Claude Code `--output-format stream-json` output.
 *
 * The parser is stateful because the wire format is not self-describing: a
 * `tool_result` block names its `tool_use_id` but not its turn, so the adapter
 * counts assistant messages (turns start at 1) and remembers the turn of each
 * tool call it has seen.
 */
export interface ClaudeEventParser {
  /** Feed one raw output line; returns the events it produced (possibly none). */
  write(line: string): CliEvent[];
  /**
   * Flush the stream. Emits a synthetic `session_end` when the CLI never printed a
   * `result` frame; the CLI pipeline is expected to override that status when it
   * aborts a run itself.
   */
  end(): CliEvent[];
  /**
   * Diagnostics: `lines` counts non-empty lines seen, `parseErrors` counts lines
   * that were not JSON objects, and `skippedEvents` counts well-formed frames the
   * adapter deliberately ignored (unknown event types, duplicate endings).
   */
  stats(): { lines: number; parseErrors: number; skippedEvents: number };
}

/** The textual payload of a tool result: a bare string, or the text blocks of an array. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  let text = '';
  for (const block of content) {
    if (isRecord(block) && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

/**
 * Normalize error text for fingerprinting: first two lines, trimmed, internal
 * whitespace runs collapsed, lowercased. Whitespace and case are noise between
 * otherwise identical failures, and two lines is enough to identify a failure
 * without hashing an entire stack trace.
 */
function normalizeErrorText(text: string): string {
  return text
    .split(/\r?\n/)
    .slice(0, 2)
    .map((line) => line.trim().replace(/\s+/g, ' ').toLowerCase())
    .join('\n');
}

/** Stable 16-hex fingerprint of a normalized failure; the loop detector's key. */
function errorFingerprint(text: string): string {
  return createHash('sha256').update(normalizeErrorText(text), 'utf8').digest('hex').slice(0, 16);
}

/** Repo-relative path of a tool call, from whichever path field the tool uses. */
function targetPathFrom(input: JsonRecord): string | null {
  const candidate = input.file_path ?? input.path ?? input.notebook_path;
  return typeof candidate === 'string' ? normalizeRepoPath(candidate) : null;
}

/** Deduplication signature of a shell command; null when the tool ran no command. */
function commandSignatureFrom(input: JsonRecord): string | null {
  const raw = input.command;
  if (raw === undefined || raw === null) {
    return null;
  }
  const signature = normalizeCommandSignature(typeof raw === 'string' ? raw : String(raw));
  return signature === '' ? null : signature;
}

/** JSON array -> object blocks; anything else yields no blocks. */
function contentBlocks(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

class StatefulClaudeEventParser implements ClaudeEventParser {
  private lines = 0;
  private parseErrors = 0;
  private skippedEvents = 0;
  private turns = 0;
  private ended = false;
  private readonly toolUseTurns = new Map<string, number>();

  write(line: string): CliEvent[] {
    if (typeof line !== 'string') {
      this.lines += 1;
      this.parseErrors += 1;
      return [];
    }
    if (line.trim() === '') {
      return [];
    }
    this.lines += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.parseErrors += 1;
      return [];
    }
    if (!isRecord(parsed)) {
      this.parseErrors += 1;
      return [];
    }
    return this.dispatch(parsed);
  }

  end(): CliEvent[] {
    if (this.ended) {
      return [];
    }
    this.ended = true;
    return [{ type: 'session_end', status: 'completed' }];
  }

  stats(): { lines: number; parseErrors: number; skippedEvents: number } {
    return { lines: this.lines, parseErrors: this.parseErrors, skippedEvents: this.skippedEvents };
  }

  private dispatch(event: JsonRecord): CliEvent[] {
    switch (event.type) {
      case 'system':
        return this.handleSystem(event);
      case 'assistant':
        return this.handleAssistant(event);
      case 'user':
        return this.handleUser(event);
      case 'result':
        return this.handleResult(event);
      default:
        this.skippedEvents += 1;
        return [];
    }
  }

  private handleSystem(event: JsonRecord): CliEvent[] {
    if (event.subtype !== 'init') {
      this.skippedEvents += 1;
      return [];
    }
    // The task prompt hash is the caller's to supply; the CLI does not report it.
    return [{ type: 'session_start', cliTool: 'claude_code', taskPromptHash: null }];
  }

  private handleAssistant(event: JsonRecord): CliEvent[] {
    // Every assistant message is a new turn, even when it contains only text.
    this.turns += 1;
    const turnIndex = this.turns;
    const message = isRecord(event.message) ? event.message : {};
    const events: CliEvent[] = [];

    for (const block of contentBlocks(message.content)) {
      if (block.type !== 'tool_use') {
        continue;
      }
      if (typeof block.id === 'string' && block.id !== '') {
        this.toolUseTurns.set(block.id, turnIndex);
      }

      const input = isRecord(block.input) ? block.input : {};
      events.push({
        type: 'tool_call',
        turnIndex,
        toolName: typeof block.name === 'string' ? block.name : '',
        targetPath: targetPathFrom(input),
        commandSignature: commandSignatureFrom(input),
      });
    }
    return events;
  }

  private handleUser(event: JsonRecord): CliEvent[] {
    const message = isRecord(event.message) ? event.message : {};
    const events: CliEvent[] = [];

    for (const block of contentBlocks(message.content)) {
      if (block.type !== 'tool_result') {
        continue;
      }
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
      const mappedTurn = toolUseId === null ? undefined : this.toolUseTurns.get(toolUseId);
      const text = toolResultText(block.content);

      events.push({
        type: 'tool_result',
        // An unmapped id (e.g. a result for a tool call we never saw) falls back
        // to the turn currently in flight.
        turnIndex: mappedTurn ?? this.turns,
        // stream-json reports success/failure, never numeric exit codes.
        exitCode: null,
        outputTokens: estimateTokens(text),
        errorFingerprint: block.is_error === true ? errorFingerprint(text) : null,
      });
    }
    return events;
  }

  private handleResult(event: JsonRecord): CliEvent[] {
    if (this.ended) {
      this.skippedEvents += 1;
      return [];
    }
    this.ended = true;
    return [{ type: 'session_end', status: event.subtype === 'success' ? 'completed' : 'failed' }];
  }
}

/** Create an empty parser; one instance per session. */
export function createClaudeEventParser(): ClaudeEventParser {
  return new StatefulClaudeEventParser();
}

/** Parse a complete captured stream in one call (convenience for tests and replays). */
export function collectClaudeEvents(lines: string[]): CliEvent[] {
  const parser = createClaudeEventParser();
  const events: CliEvent[] = [];
  for (const line of lines) {
    for (const event of parser.write(line)) {
      events.push(event);
    }
  }
  for (const event of parser.end()) {
    events.push(event);
  }
  return events;
}
