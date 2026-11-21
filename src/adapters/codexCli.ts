/**
 * Codex CLI adapter: JSONL event parsing, managed `AGENTS.md` injection, and
 * spawn-spec builders.
 *
 * Codex is the second agent CLI LogLode wraps. Unlike Claude Code it exposes no
 * `--append-system-prompt-file`, so the architecture chooses
 * `injection_mode = "managed_md_block"`: micro-skills are written into a fenced
 * block inside the repository's `AGENTS.md`. That file is hand-written by humans,
 * which is why the writer is surgical — only the bytes between the two HTML
 * comment markers may ever change — and idempotent, because it runs before every
 * task and must never accumulate duplicate blocks.
 *
 * The event parser is deliberately lenient. `codex exec --json` emits one JSON
 * object per line whose shape moves between releases (`usage` vs
 * `total_token_usage`, several `item.*` variants, new event types). A single
 * unfamiliar event must not abort a telemetry session, so unknown shapes are
 * counted and skipped rather than thrown. This parser is also *not* the source of
 * truth for billing: the loopback proxy captures provider-reported usage, so the
 * usage frames mapped here are best-effort convenience data.
 *
 * Nothing here spawns a process or touches the network. Process spawning belongs
 * to the orchestrating CLI, which consumes `buildCodexArgs` / `buildCodexEnv`.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { estimateTokens } from '../tokenize.js';
import type { CliEvent, TokenUsage } from './types.js';

// ---------------------------------------------------------------------------
// Managed AGENTS.md block
// ---------------------------------------------------------------------------

/** Opening marker of the LogLode-managed block inside `AGENTS.md`. */
export const MANAGED_BLOCK_BEGIN = '<!-- loglode:micro-skills begin -->';
/** Closing marker of the LogLode-managed block inside `AGENTS.md`. */
export const MANAGED_BLOCK_END = '<!-- loglode:micro-skills end -->';

interface ManagedRange {
  /** Index of the begin marker. */
  start: number;
  /** Index just past the end marker. */
  end: number;
}

/**
 * Locate a complete managed block. A lone begin or end marker is treated as
 * unmanaged text: we cannot know what a human meant by half a fence, so the
 * caller appends a fresh block instead of deleting prose.
 */
function findManagedRange(text: string): ManagedRange | null {
  const start = text.indexOf(MANAGED_BLOCK_BEGIN);
  if (start === -1) return null;
  const endMarkerStart = text.indexOf(MANAGED_BLOCK_END, start + MANAGED_BLOCK_BEGIN.length);
  if (endMarkerStart === -1) return null;
  return { start, end: endMarkerStart + MANAGED_BLOCK_END.length };
}

/**
 * Canonical on-disk block. `content` goes in verbatim, so a caller that renders
 * markdown (which always ends with a newline) gets the end marker on its own
 * line; a caller that passes text without a trailing newline gets it appended to
 * the last content line, which is still valid HTML-comment syntax. Callers that
 * want a readable file should end `content` with `\n`.
 */
function renderManagedBlock(content: string): string {
  return `${MANAGED_BLOCK_BEGIN}\n${content}${MANAGED_BLOCK_END}\n`;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write (or refresh) the managed block in `agentsMdPath`.
 *
 * - Missing file: created containing marker + content + marker.
 * - Block already present: only the region between the markers is rewritten; all
 *   bytes outside the markers are preserved exactly.
 * - File without markers: the block is appended after exactly one blank line.
 *
 * Callers (the pipeline's pre-flight step) may run this before every task, so it
 * must be idempotent and must never reorder a human's instructions.
 */
export async function injectManagedBlock(agentsMdPath: string, content: string): Promise<void> {
  const existing = await readFileOrNull(agentsMdPath);
  if (existing === null) {
    await fs.writeFile(agentsMdPath, renderManagedBlock(content), 'utf8');
    return;
  }

  const range = findManagedRange(existing);
  if (range === null) {
    // Append at end of file, normalising trailing blank lines so the block is
    // separated from hand-written content by exactly one empty line.
    const trimmed = existing.replace(/(?:\r\n|\n)+$/, '');
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
    await fs.writeFile(agentsMdPath, prefix + renderManagedBlock(content), 'utf8');
    return;
  }

  const before = existing.slice(0, range.start);
  const after = existing.slice(range.end);
  const blockBody = `${MANAGED_BLOCK_BEGIN}\n${content}${MANAGED_BLOCK_END}`;
  // `after` normally starts with the newline that terminates the end-marker line,
  // and is preserved byte-for-byte. Only when the block ended the file do we add
  // the guaranteed trailing newline ourselves.
  const merged = after.length === 0 ? `${before}${blockBody}\n` : `${before}${blockBody}${after}`;
  await fs.writeFile(agentsMdPath, merged, 'utf8');
}

/**
 * Remove the managed block, plus any blank lines that immediately followed it.
 * A file that contained only the block becomes empty. A file without markers is
 * left untouched, and a missing file is not created.
 */
export async function removeManagedBlock(agentsMdPath: string): Promise<void> {
  const existing = await readFileOrNull(agentsMdPath);
  if (existing === null) return;

  const range = findManagedRange(existing);
  if (range === null) return;

  const before = existing.slice(0, range.start);
  const after = existing.slice(range.end).replace(/^(?:[ \t]*(?:\r\n|\n))+/, '');
  await fs.writeFile(agentsMdPath, before + after, 'utf8');
}

/**
 * Read the content between the markers, verbatim. Returns `null` when the file is
 * missing or has no complete block, so callers can distinguish "nothing was
 * injected" from "an empty block was injected".
 */
export async function readManagedBlock(agentsMdPath: string): Promise<string | null> {
  const existing = await readFileOrNull(agentsMdPath);
  if (existing === null) return null;

  const range = findManagedRange(existing);
  if (range === null) return null;

  let bodyStart = range.start + MANAGED_BLOCK_BEGIN.length;
  // Tolerate CRLF files: the marker line may end in either convention.
  if (existing.startsWith('\r\n', bodyStart)) bodyStart += 2;
  else if (existing.startsWith('\n', bodyStart)) bodyStart += 1;

  const bodyEnd = range.end - MANAGED_BLOCK_END.length;
  return existing.slice(bodyStart, Math.max(bodyStart, bodyEnd));
}

// ---------------------------------------------------------------------------
// Spawn spec
// ---------------------------------------------------------------------------

/**
 * Build the argv passed to `codex`. `--json` is what makes the child emit the
 * JSONL stream this module parses, so it is required; a user-supplied `--json`
 * (or `--json=…`) is respected and never duplicated. Everything else is passed
 * through untouched and in order, because agent args are user intent.
 */
export function buildCodexArgs(opts: { agentArgs: string[] }): string[] {
  const args = [...opts.agentArgs];
  const hasJsonFlag = args.some((arg) => arg === '--json' || arg.startsWith('--json='));
  return hasJsonFlag ? args : [...args, '--json'];
}

/**
 * Build the child environment. The loopback proxy's base URL is injected as
 * `OPENAI_BASE_URL`; every other variable is inherited untouched and the parent
 * object is never mutated (the pipeline reuses it across sessions).
 */
export function buildCodexEnv(opts: { openaiBaseUrl?: string | null; parentEnv: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...opts.parentEnv };
  if (opts.openaiBaseUrl !== undefined && opts.openaiBaseUrl !== null) {
    env.OPENAI_BASE_URL = opts.openaiBaseUrl;
  }
  return env;
}

// ---------------------------------------------------------------------------
// JSONL event parser
// ---------------------------------------------------------------------------

/** Minimal shape of one decoded JSON object on the stream. */
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Local re-implementation of the Claude adapter's command normaliser.
 *
 * Deliberate duplication: Pieces D and H are built in parallel and must not
 * import from each other's files, so each carries this six-line helper. The
 * orchestrator may unify them later; until then the rule is identical — keep the
 * executable (first token) plus every flag, drop ephemeral positional arguments.
 */
function normalizeCommandSignature(command: string): string {
  const tokens = command.split(/\s+/).filter((token) => token.length > 0);
  return tokens.filter((token, index) => index === 0 || token.startsWith('-')).join(' ');
}

/** Codex can report Windows paths; the store keys on forward slashes. */
function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Stable fingerprint of a failing tool result: the first two lines of output,
 * each trimmed, whitespace-collapsed and lower-cased, hashed with SHA-256 and
 * truncated to 16 hex chars. Truncation keeps rows compact; 64 bits is ample for
 * detecting the same error repeating inside one repo.
 */
function errorFingerprint(aggregatedOutput: string): string {
  const normalized = aggregatedOutput
    .split(/\r?\n/)
    .slice(0, 2)
    .map((line) => line.trim().replace(/\s+/g, ' ').toLowerCase())
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Map a provider usage frame onto `TokenUsage`.
 *
 * Two shapes appear in the wild:
 * - codex-style: `input_tokens` / `cached_input_tokens` / `output_tokens`, where
 *   `input_tokens` is already the uncached count (per the architecture's
 *   `TokenUsage` contract, so it maps straight across).
 * - OpenAI-style: `prompt_tokens` / `completion_tokens`, where `prompt_tokens`
 *   includes cached reads, so the cached subset must be subtracted.
 *
 * `cacheWriteTokens` is always 0: neither CLI reports prompt-cache writes for
 * OpenAI-family calls.
 */
function mapTokenUsage(raw: JsonObject): TokenUsage | null {
  const codexInput = asNumber(raw.input_tokens);
  const codexCached = asNumber(raw.cached_input_tokens);
  const codexOutput = asNumber(raw.output_tokens);
  if (codexInput !== null || codexCached !== null || codexOutput !== null) {
    return {
      inputTokens: Math.max(0, codexInput ?? 0),
      cacheReadTokens: Math.max(0, codexCached ?? 0),
      cacheWriteTokens: 0,
      outputTokens: Math.max(0, codexOutput ?? 0),
    };
  }

  const prompt = asNumber(raw.prompt_tokens);
  const completion = asNumber(raw.completion_tokens);
  const details = isJsonObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details : null;
  const cached = details === null ? null : asNumber(details.cached_tokens);
  if (prompt === null && completion === null && cached === null) return null;

  const cacheRead = Math.max(0, cached ?? 0);
  return {
    inputTokens: Math.max(0, Math.max(0, prompt ?? 0) - cacheRead),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    outputTokens: Math.max(0, completion ?? 0),
  };
}

/**
 * Streaming parser for `codex exec --json`.
 *
 * `write()` takes one line and returns the zero or more events it produced, so a
 * caller can persist telemetry as the child streams. Counters are exposed for
 * diagnostics: `lines` counts non-blank lines offered, `parseErrors` counts lines
 * that were not JSON, and `skippedEvents` counts well-formed JSON that carried no
 * mappable telemetry.
 */
export interface CodexEventParser {
  write(line: string): CliEvent[];
  /** Flush a terminal `session_end` if the stream did not already report one. */
  end(): CliEvent[];
  stats(): { lines: number; parseErrors: number; skippedEvents: number };
}

class StreamParser implements CodexEventParser {
  private lineCount = 0;
  private parseErrorCount = 0;
  private skippedEventCount = 0;
  /** 0 until the first turn opens; tool events inherit the open turn. */
  private currentTurn = 0;
  private turnOpen = false;
  private sessionEnded = false;

  write(line: string): CliEvent[] {
    // Codex output arrives as UTF-8 lines; trim also strips a stray `\r` from
    // CRLF pipes so Windows users get the same parse as POSIX ones.
    const text = line.trim();
    if (text.length === 0) return [];
    this.lineCount += 1;

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      this.parseErrorCount += 1;
      return [];
    }
    if (!isJsonObject(decoded)) {
      // Valid JSON, but not an event object (e.g. `null` or a bare array).
      this.parseErrorCount += 1;
      return [];
    }

    return this.dispatch(decoded);
  }

  end(): CliEvent[] {
    if (this.sessionEnded) return [];
    this.sessionEnded = true;
    return [{ type: 'session_end', status: 'completed' }];
  }

  stats(): { lines: number; parseErrors: number; skippedEvents: number } {
    return {
      lines: this.lineCount,
      parseErrors: this.parseErrorCount,
      skippedEvents: this.skippedEventCount,
    };
  }

  private dispatch(event: JsonObject): CliEvent[] {
    switch (asString(event.type) ?? '') {
      case 'thread.started':
        return [{ type: 'session_start', cliTool: 'codex', taskPromptHash: null }];
      case 'turn.started':
        this.openTurn();
        return [];
      case 'item.completed':
        return this.mapItemCompleted(event);
      case 'turn.completed':
        return this.mapTurnCompleted(event);
      case 'error':
        return this.mapError();
      default:
        this.skippedEventCount += 1;
        return [];
    }
  }

  /**
   * A well-formed stream announces every turn, but some Codex builds omit
   * `turn.started` or emit items first. Opening on demand keeps `turnIndex`
   * starting at 1 either way; a late `turn.started` for the already-open turn is
   * then treated as a duplicate instead of silently shifting later events.
   */
  private openTurn(): void {
    if (this.turnOpen) return;
    this.currentTurn += 1;
    this.turnOpen = true;
  }

  private ensureTurn(): number {
    if (!this.turnOpen) this.openTurn();
    return this.currentTurn;
  }

  private mapItemCompleted(event: JsonObject): CliEvent[] {
    const item = event.item;
    if (!isJsonObject(item)) {
      this.skippedEventCount += 1;
      return [];
    }
    const itemType = asString(item.type) ?? '';
    if (itemType === 'command_execution') return this.mapCommandExecution(item);
    if (itemType === 'file_change') return this.mapFileChange(item);
    // `agent_message`, `reasoning`, and future item kinds carry no telemetry.
    this.skippedEventCount += 1;
    return [];
  }

  private mapCommandExecution(item: JsonObject): CliEvent[] {
    const turnIndex = this.ensureTurn();
    const command = asString(item.command) ?? '';
    const output = asString(item.aggregated_output) ?? '';
    const exitCode = asNumber(item.exit_code);
    return [
      {
        type: 'tool_call',
        turnIndex,
        toolName: 'bash',
        targetPath: null,
        commandSignature: normalizeCommandSignature(command),
      },
      {
        type: 'tool_result',
        turnIndex,
        exitCode,
        outputTokens: estimateTokens(output),
        // Only failures are worth fingerprinting; success output never recurs as
        // a loop and hashing it would just add noise to the store.
        errorFingerprint: exitCode !== null && exitCode !== 0 ? errorFingerprint(output) : null,
      },
    ];
  }

  private mapFileChange(item: JsonObject): CliEvent[] {
    const turnIndex = this.ensureTurn();
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const events: CliEvent[] = [];
    for (const change of changes) {
      if (!isJsonObject(change)) continue;
      const path = asString(change.path);
      if (path === null || path.length === 0) continue;
      events.push({
        type: 'tool_call',
        turnIndex,
        toolName: 'edit',
        targetPath: normalizeRepoPath(path),
        commandSignature: null,
      });
    }
    // A recognised event with nothing to record yields no events; it is handled,
    // not skipped, so the counters stay quiet.
    return events;
  }

  private mapTurnCompleted(event: JsonObject): CliEvent[] {
    this.ensureTurn();
    this.turnOpen = false;
    // Older builds nest the totals under `usage`, newer ones under
    // `total_token_usage`; try both and keep the first that maps.
    for (const candidate of [event.usage, event.total_token_usage]) {
      if (!isJsonObject(candidate)) continue;
      const usage = mapTokenUsage(candidate);
      if (usage === null) continue;
      return [{ type: 'usage', model: 'codex-cli', usage }];
    }
    this.skippedEventCount += 1;
    return [];
  }

  private mapError(): CliEvent[] {
    // An `error` frame is Codex's terminal signal; `end()` must not append a
    // second, contradictory `completed` status afterwards.
    if (this.sessionEnded) {
      this.skippedEventCount += 1;
      return [];
    }
    this.sessionEnded = true;
    return [{ type: 'session_end', status: 'failed' }];
  }
}

/** Create a fresh streaming parser. Each observed session gets its own. */
export function createCodexEventParser(): CodexEventParser {
  return new StreamParser();
}

/**
 * Convenience wrapper for tests, fixtures, and post-hoc parsing of a captured
 * buffer: feed every line, then flush. Lines may themselves contain newlines
 * (e.g. a whole stdout blob passed as one element) because JSONL never embeds raw
 * newlines inside a value.
 */
export function collectCodexEvents(lines: string[]): CliEvent[] {
  const parser = createCodexEventParser();
  const events: CliEvent[] = [];
  for (const line of lines) {
    for (const part of line.split(/\r?\n/)) {
      events.push(...parser.write(part));
    }
  }
  events.push(...parser.end());
  return events;
}
