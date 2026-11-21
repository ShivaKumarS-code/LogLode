/**
 * Deterministic waste miners for LogLode's zero-LLM layer.
 *
 * Architecture: §5 "Deterministic Waste Mining Heuristics (Zero-LLM Layer)" and
 * §3 "Stage 4: Deterministic Waste Mining". Five detectors run over the ordered
 * tool calls of one session — `repeat_read`, `fail_loop`, `search_thrash`,
 * `log_flood`, `edit_oscillation` — and {@link mineWindow} adds the
 * cross-session `repeat_read` rule over the last `windowSize` sessions of a
 * repository. Nothing here calls an LLM, reads the clock, or uses randomness, so
 * the same input always produces byte-identical findings and signatures (which
 * is what makes cross-session deduplication stable).
 *
 * ## Interpretation decisions
 *
 * The architecture leaves several details loose; each choice below is
 * conservative so the miner under-reports rather than inventing waste.
 *
 * - **Order.** The caller's array order is authoritative: the store's
 *   {@link getToolCallsForSessions} already returns `turn_index` then row-id
 *   order. `turnIndex` values are treated as labels, not re-sorted, so an
 *   unsorted or duplicated turn sequence means exactly the order it arrives in.
 * - **Malformed rows.** `outputTokens` is clamped to a finite, non-negative
 *   integer. Non-string tool names become `''`, blank paths/signatures become
 *   `null`, non-finite exit codes become `null`, and calls that cannot be
 *   classified are skipped. No detector throws on an odd row.
 * - **`repeat_read`.** Every non-edit-class call carrying a `targetPath` counts
 *   as a read (§5 says "read", not "read_file"). An edit-class call on the path
 *   closes the current cluster; every cluster of >= 3 reads yields its own
 *   finding, so a path read, edited, then read again can produce two findings
 *   with the same signature — the first cluster's waste is still real.
 * - **`fail_loop`.** Failures are grouped by `commandSignature` when present and
 *   by `errorFingerprint` otherwise, so one failed call is never counted in two
 *   groups. A "succeeding variant" must occur after the group's last failure and
 *   share the group key with exit code 0; when no such call exists yet, >= 2
 *   failures still emit the finding with `succeedingCommand: null` (§5 treats
 *   the unresolved repeat as recurring waste too).
 * - **`search_thrash`.** A run is a maximal contiguous block of search-class
 *   calls whose `outputTokens` is <= 40. The store has no "empty results" flag,
 *   so "returned little" is proxied by the returned output size (the documented
 *   gap in §5); any non-search call or any search above the threshold ends the
 *   run rather than being skipped over.
 * - **`log_flood`.** Exactly 4000 tokens is not a flood (the rule is strict
 *   `>`). Floods sharing a signature aggregate; the evidence reports the first
 *   flooding call's identity with the summed token count.
 * - **`edit_oscillation`.** The failures counted are tool results strictly
 *   between the first and last edit of the path ("interleaved"), where a failed
 *   result has a non-null `errorFingerprint` or a non-zero `exitCode`. Failures
 *   outside that span and failures on unrelated paths inside it are not counted,
 *   because the detector cannot attribute them further.
 * - **Cross-session `repeat_read`.** A path read in >= 3 distinct sessions of the
 *   window yields one finding on the newest session that read it, unless that
 *   session already produced a per-session `repeat_read` finding for the same
 *   path (no double-emit). The earliest session's reads are baseline context;
 *   only later sessions' reads count as waste. Evidence lists sessions
 *   oldest-first so "all but the earliest" is unambiguous.
 * - **Ranking.** Findings sort by `wastedTokens` descending, then the §5 pattern
 *   order, then signature, so equal-waste findings still have one stable order.
 */

import type {
  SessionRecord,
  ToolCallRecord,
  WasteFindingRecord,
  WastePatternType,
} from '../adapters/types.js';
import type { LoglodeDb } from '../store/db.js';
import { getRecentSessions, getToolCallsForSessions } from '../store/queries.js';

/* -------------------------------------------------------------------------- */
/* Evidence payload shapes                                                     */
/* -------------------------------------------------------------------------- */

/** `evidenceJson` payload of a `repeat_read` finding. */
export interface RepeatReadEvidence {
  targetPath: string;
  reads: number;
  wastedReadTokens: number;
  /** Populated only by the cross-session rule; oldest session first. */
  sessions?: string[];
}

/** `evidenceJson` payload of a `fail_loop` finding. */
export interface FailLoopEvidence {
  /** The finding's full dedup signature (`fail_loop:<key>`). */
  signature: string;
  failures: number;
  failingCommand: string | null;
  succeedingCommand: string | null;
}

/** `evidenceJson` payload of a `search_thrash` finding. */
export interface SearchThrashEvidence {
  /** Distinct search tool names in the run, first-seen order. */
  toolNames: string[];
  runCount: number;
  wastedTokens: number;
}

/** `evidenceJson` payload of a `log_flood` finding. */
export interface LogFloodEvidence {
  toolName: string;
  targetPath: string | null;
  /** Summed output tokens of every flood sharing this signature. */
  outputTokens: number;
}

/** `evidenceJson` payload of an `edit_oscillation` finding. */
export interface EditOscillationEvidence {
  targetPath: string;
  edits: number;
  failedResults: number;
  wastedTokens: number;
}

/* -------------------------------------------------------------------------- */
/* Rules and thresholds                                                        */
/* -------------------------------------------------------------------------- */

/** §5: an edit-class tool call closes a read cluster. Mirrors the watchdog rule. */
const EDIT_TOOL_PATTERN = /edit|write|apply|patch/i;

/** §5: grep/glob/find/search are the search-class tools. */
const SEARCH_TOOL_PATTERN = /grep|glob|find|search/i;

/** §5: `repeat_read` needs >= 3 reads of the same path in one cluster. */
const REPEAT_READ_MIN = 3;

/** §5 / brief: `fail_loop` needs >= 2 non-zero exits on the same key. */
const FAIL_LOOP_MIN_FAILURES = 2;

/** §5: `search_thrash` needs >= 4 consecutive low-output searches. */
const SEARCH_THRASH_MIN_RUN = 4;

/**
 * A search is "returned little" when its output tokens are at or below this
 * budget. The store has no result-emptiness flag, so a small output is the
 * documented deterministic proxy for an empty / fruitless search.
 */
const SEARCH_LOW_OUTPUT_MAX = 40;

/** §5: a single tool result above this many tokens is a flood (strict `>`). */
const LOG_FLOOD_THRESHOLD = 4000;

/** §5: `edit_oscillation` needs >= 3 edits of the same path. */
const EDIT_OSCILLATION_MIN_EDITS = 3;

/** §5 / brief: and >= 2 failed results interleaved between the edits. */
const EDIT_OSCILLATION_MIN_FAILURES = 2;

/** Brief: the cross-session read rule needs at least this many distinct sessions. */
const CROSS_SESSION_MIN_SESSIONS = 3;

/** §3: the default rolling mining window is the last 10 sessions. */
const DEFAULT_WINDOW_SIZE = 10;

/** Stable ranking order of the five patterns when waste ties (§5 table order). */
const PATTERN_RANK: Record<WastePatternType, number> = {
  repeat_read: 0,
  fail_loop: 1,
  search_thrash: 2,
  log_flood: 3,
  edit_oscillation: 4,
};

/* -------------------------------------------------------------------------- */
/* Normalisation helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A tool-call row after defensive normalisation. Every detector works on these
 * instead of the raw record so malformed telemetry cannot throw or poison a
 * comparison.
 */
interface NormalizedCall {
  toolName: string;
  targetPath: string | null;
  commandSignature: string | null;
  errorFingerprint: string | null;
  /** `null` when the row has no usable exit code. */
  exitCode: number | null;
  /** Finite, non-negative integer (clamped). */
  outputTokens: number;
}

/** Clamp a token count to a finite, non-negative integer. */
function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Clamp an occurrence count to a finite, non-negative integer. */
function toInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Identity key for paths / signatures: null for anything not a non-blank string. */
function identityKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Normalise one raw tool-call row, or `null` when it is not a usable object. */
function normalizeCall(raw: ToolCallRecord): NormalizedCall | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const exitCodeRaw: unknown = raw.exitCode;
  const exitCode =
    typeof exitCodeRaw === 'number' && Number.isFinite(exitCodeRaw) ? Math.trunc(exitCodeRaw) : null;
  return {
    toolName: typeof raw.toolName === 'string' ? raw.toolName : '',
    targetPath: identityKey(raw.targetPath),
    commandSignature: identityKey(raw.commandSignature),
    errorFingerprint: identityKey(raw.errorFingerprint),
    exitCode,
    outputTokens: toCount(raw.outputTokens),
  };
}

/** Normalise a whole list, dropping rows that are not usable objects. */
function normalizeCalls(toolCalls: ToolCallRecord[]): NormalizedCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const normalized: NormalizedCall[] = [];
  for (const raw of toolCalls) {
    const call = normalizeCall(raw);
    if (call !== null) {
      normalized.push(call);
    }
  }
  return normalized;
}

/** A failure for `edit_oscillation`: stderr fingerprint or a non-zero exit code. */
function isFailedResult(call: NormalizedCall): boolean {
  return call.errorFingerprint !== null || (call.exitCode !== null && call.exitCode !== 0);
}

/** Fallback label for signatures when a row has no path, command, or tool name. */
const UNKNOWN_LABEL = 'unknown';

/** First non-null label of `targetPath`, `commandSignature`, `toolName`. */
function signatureLabel(call: NormalizedCall): string {
  if (call.targetPath !== null) return call.targetPath;
  if (call.commandSignature !== null) return call.commandSignature;
  if (call.toolName !== '') return call.toolName;
  return UNKNOWN_LABEL;
}

/** Build one finding, serialising the evidence with the documented shape. */
function makeFinding(
  repoHash: string,
  sessionId: string,
  patternType: WastePatternType,
  signature: string,
  occurrences: number,
  wastedTokens: number,
  evidence: RepeatReadEvidence | FailLoopEvidence | SearchThrashEvidence | LogFloodEvidence | EditOscillationEvidence,
): WasteFindingRecord {
  return {
    repoHash,
    sessionId,
    patternType,
    signature,
    occurrences: toInt(occurrences),
    wastedTokens: toInt(wastedTokens),
    evidenceJson: JSON.stringify(evidence),
  };
}

/* -------------------------------------------------------------------------- */
/* Detector 1 — repeat_read                                                    */
/* -------------------------------------------------------------------------- */

/**
 * §5 `repeat_read`: the same non-null `targetPath` read >= 3 times in a session
 * with no intervening edit-class call on that path. Wasted tokens are the
 * re-reads only (every read after the first in its cluster); `occurrences` is the
 * cluster's read count.
 *
 * An edit-class call on the path closes the current cluster: a qualifying cluster
 * is emitted immediately, and subsequent reads start a fresh cluster that can
 * yield a second finding with the same signature. Edits on other paths do not
 * interrupt a cluster.
 */
function detectRepeatRead(
  calls: NormalizedCall[],
  repoHash: string,
  sessionId: string,
): WasteFindingRecord[] {
  const findings: WasteFindingRecord[] = [];
  const clusters = new Map<string, NormalizedCall[]>();

  const closeCluster = (path: string): void => {
    const reads = clusters.get(path);
    clusters.delete(path);
    if (reads === undefined || reads.length < REPEAT_READ_MIN) {
      return;
    }
    let wasted = 0;
    for (let index = 1; index < reads.length; index += 1) {
      const call = reads[index];
      if (call !== undefined) {
        wasted += call.outputTokens;
      }
    }
    const evidence: RepeatReadEvidence = {
      targetPath: path,
      reads: reads.length,
      wastedReadTokens: wasted,
    };
    findings.push(
      makeFinding(repoHash, sessionId, 'repeat_read', `repeat_read:${path}`, reads.length, wasted, evidence),
    );
  };

  for (const call of calls) {
    const path = call.targetPath;
    if (path === null) {
      continue;
    }
    if (EDIT_TOOL_PATTERN.test(call.toolName)) {
      closeCluster(path);
      continue;
    }
    const reads = clusters.get(path);
    if (reads === undefined) {
      clusters.set(path, [call]);
    } else {
      reads.push(call);
    }
  }

  // End of session: every still-open cluster is closed and possibly emitted.
  // Copy the keys because `closeCluster` mutates the map while iterating.
  for (const path of [...clusters.keys()]) {
    closeCluster(path);
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Detector 2 — fail_loop                                                      */
/* -------------------------------------------------------------------------- */

/** One group of non-zero exits sharing a command signature or error fingerprint. */
interface FailureGroup {
  /** Group key: `cmd:<signature>` or `fp:<fingerprint>`. */
  key: string;
  /** Raw key value used in the finding signature. */
  label: string;
  /** Command signature, when the group is command-keyed. */
  command: string | null;
  failures: NormalizedCall[];
}

/**
 * §5 `fail_loop`: the same `commandSignature` or `errorFingerprint` exiting
 * non-zero >= 2 times. Wasted tokens are the failed calls' output; `occurrences`
 * is the failure count.
 *
 * A succeeding variant (same group key, exit code 0) is looked up after the
 * group's last failure and carried in the evidence so the distiller can emit the
 * working invocation. It is optional: an unresolved repeat is still waste.
 */
function detectFailLoop(
  calls: NormalizedCall[],
  repoHash: string,
  sessionId: string,
): WasteFindingRecord[] {
  const groups = new Map<string, FailureGroup>();

  for (const call of calls) {
    if (call.exitCode === null || call.exitCode === 0) {
      continue;
    }
    let key: string;
    let label: string;
    let command: string | null;
    if (call.commandSignature !== null) {
      key = `cmd:${call.commandSignature}`;
      label = call.commandSignature;
      command = call.commandSignature;
    } else if (call.errorFingerprint !== null) {
      key = `fp:${call.errorFingerprint}`;
      label = call.errorFingerprint;
      command = null;
    } else {
      // No command and no fingerprint: the failure cannot be attributed.
      continue;
    }
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { key, label, command, failures: [call] });
    } else {
      existing.failures.push(call);
    }
  }

  const findings: WasteFindingRecord[] = [];
  for (const group of groups.values()) {
    if (group.failures.length < FAIL_LOOP_MIN_FAILURES) {
      continue;
    }

    const lastFailure = group.failures[group.failures.length - 1];
    const lastFailureIndex = lastFailure === undefined ? -1 : calls.indexOf(lastFailure);
    let succeedingCommand: string | null = null;
    for (let index = lastFailureIndex + 1; index < calls.length; index += 1) {
      const candidate = calls[index];
      if (candidate === undefined || candidate.exitCode !== 0) {
        continue;
      }
      const matches =
        group.command !== null
          ? candidate.commandSignature === group.command
          : candidate.errorFingerprint === group.label;
      if (matches) {
        succeedingCommand = candidate.commandSignature;
        break;
      }
    }

    let wasted = 0;
    for (const failure of group.failures) {
      wasted += failure.outputTokens;
    }
    const signature = `fail_loop:${group.label}`;
    const evidence: FailLoopEvidence = {
      signature,
      failures: group.failures.length,
      failingCommand: group.command,
      succeedingCommand,
    };
    findings.push(
      makeFinding(repoHash, sessionId, 'fail_loop', signature, group.failures.length, wasted, evidence),
    );
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Detector 3 — search_thrash                                                  */
/* -------------------------------------------------------------------------- */

/**
 * §5 `search_thrash`: >= 4 consecutive search-class calls that each returned
 * little (`outputTokens` <= 40; the store has no emptiness flag, so output size
 * is the deterministic proxy). Wasted tokens are the run's output; `occurrences`
 * is the run length.
 *
 * Any non-search call — including an edit-class call — or any search above the
 * threshold ends the run. Each qualifying run is reported separately, with the
 * first call's `commandSignature` (else tool name) as the signature key.
 */
function detectSearchThrash(
  calls: NormalizedCall[],
  repoHash: string,
  sessionId: string,
): WasteFindingRecord[] {
  const findings: WasteFindingRecord[] = [];
  let run: NormalizedCall[] = [];

  const closeRun = (): void => {
    const finished = run;
    run = [];
    if (finished.length < SEARCH_THRASH_MIN_RUN) {
      return;
    }
    const first = finished[0];
    if (first === undefined) {
      return;
    }
    const label = first.commandSignature ?? (first.toolName !== '' ? first.toolName : UNKNOWN_LABEL);
    const signature = `search_thrash:${label}`;
    let wasted = 0;
    const toolNames: string[] = [];
    for (const call of finished) {
      wasted += call.outputTokens;
      const name = call.toolName !== '' ? call.toolName : UNKNOWN_LABEL;
      if (!toolNames.includes(name)) {
        toolNames.push(name);
      }
    }
    const evidence: SearchThrashEvidence = {
      toolNames,
      runCount: finished.length,
      wastedTokens: wasted,
    };
    findings.push(
      makeFinding(repoHash, sessionId, 'search_thrash', signature, finished.length, wasted, evidence),
    );
  };

  for (const call of calls) {
    const isLowSearch =
      SEARCH_TOOL_PATTERN.test(call.toolName) && call.outputTokens <= SEARCH_LOW_OUTPUT_MAX;
    if (!isLowSearch) {
      closeRun();
      continue;
    }
    run.push(call);
  }
  closeRun();
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Detector 4 — log_flood                                                      */
/* -------------------------------------------------------------------------- */

/** One aggregated flooding signature inside a session. */
interface FloodGroup {
  first: NormalizedCall;
  count: number;
  wasted: number;
}

/**
 * §5 `log_flood`: any single tool result with `outputTokens` > 4000. Wasted
 * tokens are the flooding output; `occurrences` counts the floods. Floods that
 * share the `targetPath`/`commandSignature`/`toolName` signature aggregate into
 * one finding so a session's repeated lockfile or build dump is a single record.
 */
function detectLogFlood(
  calls: NormalizedCall[],
  repoHash: string,
  sessionId: string,
): WasteFindingRecord[] {
  const groups = new Map<string, FloodGroup>();
  for (const call of calls) {
    if (call.outputTokens <= LOG_FLOOD_THRESHOLD) {
      continue;
    }
    const signature = `log_flood:${signatureLabel(call)}`;
    const existing = groups.get(signature);
    if (existing === undefined) {
      groups.set(signature, { first: call, count: 1, wasted: call.outputTokens });
    } else {
      existing.count += 1;
      existing.wasted += call.outputTokens;
    }
  }

  const findings: WasteFindingRecord[] = [];
  for (const [signature, group] of groups) {
    const evidence: LogFloodEvidence = {
      toolName: group.first.toolName !== '' ? group.first.toolName : UNKNOWN_LABEL,
      targetPath: group.first.targetPath,
      outputTokens: group.wasted,
    };
    findings.push(
      makeFinding(repoHash, sessionId, 'log_flood', signature, group.count, group.wasted, evidence),
    );
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Detector 5 — edit_oscillation                                               */
/* -------------------------------------------------------------------------- */

/**
 * §5 `edit_oscillation`: the same non-null `targetPath` edited >= 3 times while
 * >= 2 failed results occur strictly between the first and last edit (the
 * interleaved retry turns). Wasted tokens are those failed results' output;
 * `occurrences` is the edit count.
 *
 * "Interleaved" is read literally: the failures must sit between the edits, so
 * failures on the edit calls themselves are not counted (that shape is closer to
 * `fail_loop` and is left to it).
 */
function detectEditOscillation(
  calls: NormalizedCall[],
  repoHash: string,
  sessionId: string,
): WasteFindingRecord[] {
  const editsByPath = new Map<string, number[]>();
  calls.forEach((call, position) => {
    if (call.targetPath === null || !EDIT_TOOL_PATTERN.test(call.toolName)) {
      return;
    }
    const positions = editsByPath.get(call.targetPath);
    if (positions === undefined) {
      editsByPath.set(call.targetPath, [position]);
    } else {
      positions.push(position);
    }
  });

  const findings: WasteFindingRecord[] = [];
  for (const [path, positions] of editsByPath) {
    if (positions.length < EDIT_OSCILLATION_MIN_EDITS) {
      continue;
    }
    const firstEdit = positions[0];
    const lastEdit = positions[positions.length - 1];
    if (firstEdit === undefined || lastEdit === undefined) {
      continue;
    }
    let failedResults = 0;
    let wasted = 0;
    for (let position = firstEdit + 1; position < lastEdit; position += 1) {
      const call = calls[position];
      if (call !== undefined && isFailedResult(call)) {
        failedResults += 1;
        wasted += call.outputTokens;
      }
    }
    if (failedResults < EDIT_OSCILLATION_MIN_FAILURES) {
      continue;
    }
    const evidence: EditOscillationEvidence = {
      targetPath: path,
      edits: positions.length,
      failedResults,
      wastedTokens: wasted,
    };
    findings.push(
      makeFinding(
        repoHash,
        sessionId,
        'edit_oscillation',
        `edit_oscillation:${path}`,
        positions.length,
        wasted,
        evidence,
      ),
    );
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

/** Deterministic string ordering (locale-independent, unlike `localeCompare`). */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Rank findings by recoverable tokens, largest first, with stable tie-breakers:
 * §5 pattern order, then signature. The array-order fallback keeps two
 * same-signature clusters deterministic.
 */
function rankFindings(findings: WasteFindingRecord[]): WasteFindingRecord[] {
  return findings
    .map((finding, insertionOrder) => ({ finding, insertionOrder }))
    .sort(
      (left, right) =>
        right.finding.wastedTokens - left.finding.wastedTokens ||
        PATTERN_RANK[left.finding.patternType] - PATTERN_RANK[right.finding.patternType] ||
        compareStrings(left.finding.signature, right.finding.signature) ||
        left.insertionOrder - right.insertionOrder,
    )
    .map((entry) => entry.finding);
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run all five deterministic detectors over one session's tool calls.
 *
 * The input is expected in chronological order (the store's turn/row order) and
 * is processed as given; unsorted `turnIndex` labels do not reorder it. Returns
 * findings ranked by `wastedTokens` descending (ties broken by pattern order,
 * then signature) and never throws on malformed rows.
 */
export function detectSessionWaste(
  repoHash: string,
  sessionId: string,
  toolCalls: ToolCallRecord[],
): WasteFindingRecord[] {
  const calls = normalizeCalls(toolCalls);
  return rankFindings([
    ...detectRepeatRead(calls, repoHash, sessionId),
    ...detectFailLoop(calls, repoHash, sessionId),
    ...detectSearchThrash(calls, repoHash, sessionId),
    ...detectLogFlood(calls, repoHash, sessionId),
    ...detectEditOscillation(calls, repoHash, sessionId),
  ]);
}

/** Findings for one session of a mining window. */
export interface SessionFindings {
  sessionId: string;
  findings: WasteFindingRecord[];
}

/** One path's read activity in one session of the window. */
interface PathSessionReads {
  sessionId: string;
  reads: number;
  tokens: number;
}

/** Normalise the optional window size: default 10, non-positive means empty. */
function normalizeWindowSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_WINDOW_SIZE;
  }
  return value > 0 ? Math.trunc(value) : 0;
}

/**
 * Add the cross-session `repeat_read` rule on top of the per-session findings.
 *
 * A path read at least once in >= 3 distinct sessions of the window produces one
 * finding on the newest session that read it: `occurrences` is the total read
 * count across those sessions and waste is every session's reads except the
 * earliest one's (the first session is baseline context). Evidence lists the
 * session ids oldest-first. The finding is skipped when the newest reading
 * session already emitted a per-session `repeat_read` for that path, so a path
 * cannot be double-reported.
 *
 * Sessions are iterated newest-first, so each path's list is newest-first and
 * `[0]` / the tail are the newest / oldest reading sessions.
 */
function addCrossSessionRepeatReads(
  repoHash: string,
  sessionsNewestFirst: SessionRecord[],
  callsBySession: Map<string, ToolCallRecord[]>,
  findingsBySession: Map<string, WasteFindingRecord[]>,
): void {
  const pathSessions = new Map<string, PathSessionReads[]>();

  for (const session of sessionsNewestFirst) {
    const readsByPath = new Map<string, { reads: number; tokens: number }>();
    for (const raw of callsBySession.get(session.id) ?? []) {
      const call = normalizeCall(raw);
      if (call === null || call.targetPath === null || EDIT_TOOL_PATTERN.test(call.toolName)) {
        continue;
      }
      const entry = readsByPath.get(call.targetPath);
      if (entry === undefined) {
        readsByPath.set(call.targetPath, { reads: 1, tokens: call.outputTokens });
      } else {
        entry.reads += 1;
        entry.tokens += call.outputTokens;
      }
    }
    for (const [path, entry] of readsByPath) {
      const list = pathSessions.get(path);
      const record: PathSessionReads = { sessionId: session.id, reads: entry.reads, tokens: entry.tokens };
      if (list === undefined) {
        pathSessions.set(path, [record]);
      } else {
        list.push(record);
      }
    }
  }

  // Lexicographic path order makes the emission order deterministic; the final
  // per-session ranking still dominates the returned order.
  for (const path of [...pathSessions.keys()].sort(compareStrings)) {
    const pathReads = pathSessions.get(path);
    if (pathReads === undefined || pathReads.length < CROSS_SESSION_MIN_SESSIONS) {
      continue;
    }
    const newest = pathReads[0];
    const oldest = pathReads[pathReads.length - 1];
    if (newest === undefined || oldest === undefined) {
      continue;
    }

    const signature = `repeat_read:${path}`;
    const targetFindings = findingsBySession.get(newest.sessionId) ?? [];
    const alreadyReported = targetFindings.some(
      (finding) => finding.patternType === 'repeat_read' && finding.signature === signature,
    );
    if (alreadyReported) {
      continue;
    }

    let totalReads = 0;
    let wasted = 0;
    for (const entry of pathReads) {
      totalReads += entry.reads;
      // The earliest session's reads are baseline, not waste.
      if (entry !== oldest) {
        wasted += entry.tokens;
      }
    }

    const evidence: RepeatReadEvidence = {
      targetPath: path,
      reads: totalReads,
      wastedReadTokens: wasted,
      sessions: pathReads.map((entry) => entry.sessionId).reverse(),
    };
    targetFindings.push(
      makeFinding(
        repoHash,
        newest.sessionId,
        'repeat_read',
        signature,
        totalReads,
        wasted,
        evidence,
      ),
    );
    findingsBySession.set(newest.sessionId, rankFindings(targetFindings));
  }
}

/**
 * Mine the last `windowSize` sessions (default 10) of one repository.
 *
 * Runs {@link detectSessionWaste} per session, then the cross-session
 * `repeat_read` rule across the whole window, and returns one entry per session
 * that has findings — newest first, empty sessions omitted, and each session's
 * findings ranked by `wastedTokens` descending. `windowSize` is the number of
 * most-recent sessions considered; `<= 0` (or an empty window) returns `[]`.
 */
export function mineWindow(
  db: LoglodeDb,
  repoHash: string,
  opts: { windowSize?: number } = {},
): SessionFindings[] {
  const windowSize = normalizeWindowSize(opts.windowSize);
  if (windowSize === 0) {
    return [];
  }

  const sessions = getRecentSessions(db, repoHash, windowSize);
  if (sessions.length === 0) {
    return [];
  }

  const sessionIds = sessions.map((session) => session.id);
  const callsBySession = new Map<string, ToolCallRecord[]>();
  for (const sessionId of sessionIds) {
    callsBySession.set(sessionId, []);
  }
  for (const call of getToolCallsForSessions(db, sessionIds)) {
    callsBySession.get(call.sessionId)?.push(call);
  }

  const findingsBySession = new Map<string, WasteFindingRecord[]>();
  for (const session of sessions) {
    findingsBySession.set(
      session.id,
      detectSessionWaste(repoHash, session.id, callsBySession.get(session.id) ?? []),
    );
  }

  addCrossSessionRepeatReads(repoHash, sessions, callsBySession, findingsBySession);

  const result: SessionFindings[] = [];
  for (const session of sessions) {
    const findings = findingsBySession.get(session.id) ?? [];
    if (findings.length > 0) {
      result.push({ sessionId: session.id, findings });
    }
  }
  return result;
}
