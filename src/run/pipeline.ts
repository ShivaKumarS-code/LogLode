/**
 * LogLode session pipeline: the five-stage wiring of `docs/architecture.md` §3
 * behind one `runSession` call. The CLI (`src/cli.ts`) owns argument parsing and
 * user-facing formatting; everything that touches a child process, the loopback
 * proxy, the SQLite store, the miner, and the distiller lives here so it can be
 * driven end-to-end by tests with fixture agents.
 *
 * Stage flow:
 *  1. **Pre-flight** — resolve HEAD, load active micro-skills, git-diff stale
 *     linked paths, auto-retire deleted/renamed skills, render
 *     `.loglode/micro-skills.md` from the survivors.
 *  2. **Telemetry** — bind the loopback token proxy on `127.0.0.1:0`, point the
 *     child's `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` at it, parse the child's
 *     structured stdout line by line while echoing every raw line through, and
 *     persist tool calls as they stream.
 *  3. **Watchdog** — feed the same telemetry into `BudgetWatchdog`; a hard breach
 *     sends `SIGINT` (unless `--no-kill`) and latches `aborted`.
 *  4. **Mining** — on exit, run the deterministic detectors over the rolling
 *     10-session window and persist the findings.
 *  5. **Distillation** — only when an API key is supplied: promote, call the
 *     cheap model, apply the mutations, and re-render the skill file.
 *
 * Deliberate interpretation calls (mirrored in the piece report):
 * - The proxy is the only billing source of truth, so `usage` events emitted by
 *   the CLI parsers are ignored. Both fixtures therefore make a real HTTP call
 *   through the proxy.
 * - A tool call is persisted as ONE row when its result arrives (`targetPath`
 *   relativized), because the schema and miner need invocation and result fields
 *   together; rows whose result never arrives are flushed at exit with a null
 *   exit code.
 * - If the child dies before emitting `session_start` (missing binary), the
 *   provisional session row is inserted at finish time so `finalizeSession` never
 *   updates zero rows.
 * - `--budget` sets `hardStopUsd = budget` and `softAlertUsd = budget * 0.5`
 *   (documented behavior of the CLI contract); `--no-kill` still records the hard
 *   breach but never signals the child.
 * - Codex's managed `AGENTS.md` block is written before the run and deliberately
 *   NOT removed afterwards: the next pre-flight rewrites it. When injection is
 *   enabled but there is nothing to inject, a leftover block is removed instead
 *   so stale rules cannot leak into a session.
 * - After distillation the skill file is re-rendered with the post-apply active
 *   skills and a bumped version. `skillVersionId` in the result still describes
 *   the version that was injected into THIS session (what the session row
 *   records), not the version left on disk for the next one.
 * - "OS notification" is out of scope here: `notify` writes a short line to the
 *   injected stderr. The banner writes the highlighted `=== LogLode: ... ===`
 *   form from §3 Stage 3.
 * - A short grace period after child exit lets the proxy finish scanning an
 *   in-flight response before the totals are finalized; without it a fast child
 *   could exit before its own usage frame is recorded.
 */

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { buildClaudeSpawn, createClaudeEventParser } from '../adapters/claudeCode.js';
import {
  buildCodexArgs,
  buildCodexEnv,
  createCodexEventParser,
  injectManagedBlock,
  removeManagedBlock,
} from '../adapters/codexCli.js';
import type {
  CliEvent,
  CliTool,
  MicroSkillRecord,
  SessionRecord,
  TokenUsage,
  ToolCallRecord,
  WatchdogActions,
  WatchdogBreach,
} from '../adapters/types.js';
import type { LoglodeConfig } from '../config.js';
import { estimateCostUsd } from '../cost.js';
import { checkSkillStaleness, type StalenessResult } from '../distiller/staleness.js';
import { applyMutations, createAnthropicDistillerCall, distillSkills } from '../distiller/synthesize.js';
import { mineWindow } from '../miner/detectors.js';
import { startTokenProxy, type TokenProxy } from '../proxy/tokenProxy.js';
import { nextFileVersion, renderMicroSkillsMarkdown } from '../skills/render.js';
import type { LoglodeDb } from '../store/db.js';
import { openStateDb } from '../store/db.js';
import {
  countSessions,
  deactivateMicroSkill,
  deleteWasteFindingsForSession,
  finalizeSession,
  getRecentSessions,
  insertSession,
  insertToolCall,
  insertWasteFindings,
  listActiveMicroSkills,
} from '../store/queries.js';
import { BudgetWatchdog } from '../watchdog/monitor.js';

const execFileAsync = promisify(execFile);

/** Relative path of the rendered artifact inside the repository (§6). */
export const SKILLS_FILE_RELATIVE_PATH = '.loglode/micro-skills.md';

/** Managed-block host file for Codex injection (§2 "Context Injector"). */
export const AGENTS_FILE_NAME = 'AGENTS.md';

/** Rolling mining window for Stage 4 (§3: the last 5–10 sessions). */
export const MINING_WINDOW_SIZE = 10;

/**
 * Quiet period between child exit and finalization. The proxy emits usage when
 * the *upstream response* ends, which can be microseconds after the child's own
 * socket closes; this grace guarantees the last frame is counted without making
 * the pipeline meaningfully slower.
 */
const PROXY_SETTLE_GRACE_MS = 150;

export interface RunSessionOptions {
  cli: CliTool;
  /** Arguments passed after the adapter's own flags (e.g. `['-p', 'fix the bug']`). */
  agentArgs: string[];
  /** Already resolved by the CLI (or injected by tests). */
  repoRoot: string;
  repoHash: string;
  /** `--no-inject`: baseline run, no skills, `skillVersionId` null. */
  noInject: boolean;
  noKill: boolean;
  /** `--budget`: overrides `hardStopUsd`; `softAlertUsd` becomes `budgetUsd * 0.5`. */
  budgetUsd?: number | null;
  /** Loaded by the caller (cli) — injected here for testability. */
  config: LoglodeConfig;
  /** Home-dir override for the state DB (tests pass a temp dir). */
  basePath?: string;
  /** Default: `process.env`. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Child binary; default `'claude'` for `claude_code`, `'codex'` for codex. */
  command?: string;
  /** `ANTHROPIC_API_KEY` for post-run distillation; null/undefined → skip LLM. */
  distillerApiKey?: string | null;
  /** Child passthrough targets. Default: the process streams. */
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  now?: () => Date;
  /** Default: `execFile git`, trimmed stdout. */
  runGit?: (args: string[], cwd: string) => Promise<string>;
}

export interface RunSessionResult {
  sessionId: string;
  status: 'completed' | 'failed' | 'aborted_budget';
  usage: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number };
  spendUsd: number;
  breaches: WatchdogBreach[];
  /** `.loglode/micro-skills.md` path when injected, else null. */
  skillsFilePath: string | null;
  skillVersionId: number | null;
  /** Count of waste findings persisted this run. */
  minedFindings: number;
  distillNotes: string[];
  childExitCode: number | null;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function writeTo(stream: NodeJS.WritableStream | undefined, text: string): void {
  if (stream === undefined) {
    return;
  }
  try {
    stream.write(text);
  } catch {
    // A closed terminal must never break telemetry.
  }
}

function readTextFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
  target.outputTokens += usage.outputTokens;
}

/** Default git runner: `git` in `cwd`, trimmed stdout, prompts disabled. */
async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;

  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return String(stdout).trim();
}

/**
 * Convert an absolute tool-call path into a repo-relative, forward-slash path.
 *
 * Tool calls name files the way the agent saw them (absolute), while the store
 * keys on repo-relative paths so mining works across checkouts and platforms.
 * Both the root and the candidate are normalised to forward slashes first, which
 * also tolerates a backslash-spelled `repoRoot`; on Windows the comparison is
 * case-insensitive because drive-letter casing varies between tools.
 * Paths outside the repository (e.g. `/tmp/...`) are returned normalised but
 * absolute — they are still useful telemetry, just not repo-scoped.
 */
export function relativizeTargetPath(targetPath: string | null, repoRoot: string): string | null {
  if (targetPath === null) {
    return null;
  }
  const path = targetPath.replace(/\\/g, '/');
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root === '') {
    return path;
  }
  const prefix = `${root}/`;
  if (path.startsWith(prefix)) {
    return path.slice(prefix.length);
  }
  if (process.platform === 'win32' && path.toLowerCase().startsWith(prefix.toLowerCase())) {
    return path.slice(prefix.length);
  }
  return path;
}

/* -------------------------------------------------------------------------- */
/* Stage 1 helper — staleness + rendering                                      */
/* -------------------------------------------------------------------------- */

interface PreflightOptions {
  db: LoglodeDb;
  repoHash: string;
  repoRoot: string;
  headCommit: string | null;
  runGit: (args: string[], cwd: string) => Promise<string>;
  stderr: NodeJS.WritableStream | undefined;
}

/**
 * Group active skills by `last_validated_commit`, git-diff each group, deactivate
 * the ones whose linked paths were deleted or renamed, and return the surviving
 * active skills (re-read from the store so the returned list matches the DB).
 *
 * A skill whose paths only changed (`M`/`A`) is kept and noted: §6 safeguard 3
 * only auto-retires deleted or moved files. Any unexpected failure is reported
 * as a note and leaves the skill list untouched — a broken checkout or git
 * hiccup must never silently retire every rule.
 */
async function applyStalenessAndRetire(input: PreflightOptions): Promise<MicroSkillRecord[]> {
  const groups = new Map<string, MicroSkillRecord[]>();
  for (const skill of listActiveMicroSkills(input.db, input.repoHash)) {
    const base = skill.lastValidatedCommit ?? '';
    const bucket = groups.get(base);
    if (bucket === undefined) {
      groups.set(base, [skill]);
    } else {
      bucket.push(skill);
    }
  }

  for (const [baseCommit, skills] of groups) {
    let stale: StalenessResult;
    try {
      stale = await checkSkillStaleness({
        repoRoot: input.repoRoot,
        skills,
        baseCommit: baseCommit === '' ? null : baseCommit,
        headCommit: input.headCommit,
        runGit: input.runGit,
      });
    } catch (error) {
      writeTo(
        input.stderr,
        `LogLode: staleness check failed for ${skills.length} skill(s) at base '${baseCommit || '(none)'}': ${toError(error).message}\n`,
      );
      continue;
    }

    for (const entry of stale.stale) {
      if (entry.reason === 'deleted' || entry.reason === 'renamed') {
        deactivateMicroSkill(input.db, input.repoHash, entry.skill.skillKey);
        writeTo(
          input.stderr,
          `LogLode: retired stale micro-skill '${entry.skill.skillKey}' (${entry.reason}: ${entry.changedPaths.join(', ')})\n`,
        );
      } else {
        writeTo(
          input.stderr,
          `LogLode: micro-skill '${entry.skill.skillKey}' references changed path(s) ${entry.changedPaths.join(', ')}; injecting it anyway\n`,
        );
      }
    }
  }

  // Re-read from the store: `deactivateMicroSkill` above changed what is active,
  // and returning the caller's in-memory list would keep retired rules injectable.
  return listActiveMicroSkills(input.db, input.repoHash);
}

/**
 * Render and persist the skill artifact; returns the path and the version written.
 *
 * Exported so `loglode skills edit|prune|reset` and `loglode mine` regenerate the
 * identical artifact the pipeline injects (one renderer path, no drift).
 */
export function writeSkillsArtifact(input: {
  repoRoot: string;
  repoHash: string;
  skills: MicroSkillRecord[];
  config: LoglodeConfig;
  headCommit: string | null;
  sessionCount: number;
}): { filePath: string; version: number; content: string } {
  const directory = join(input.repoRoot, '.loglode');
  mkdirSync(directory, { recursive: true });
  const filePath = join(input.repoRoot, ...SKILLS_FILE_RELATIVE_PATH.split('/'));
  const version = nextFileVersion(readTextFileOrNull(filePath));
  const content = renderMicroSkillsMarkdown({
    repoHash: input.repoHash,
    version,
    skills: input.skills,
    budgetCap: input.config.distiller.maxSkillFileTokens,
    lastCommit: input.headCommit,
    sessionCount: input.sessionCount,
  });
  writeFileSync(filePath, content, 'utf8');
  return { filePath, version, content };
}

/* -------------------------------------------------------------------------- */
/* Event parser contract (both adapter parsers satisfy it structurally)         */
/* -------------------------------------------------------------------------- */

interface SessionEventParser {
  write(line: string): CliEvent[];
  end(): CliEvent[];
}

/* -------------------------------------------------------------------------- */
/* runSession                                                                  */
/* -------------------------------------------------------------------------- */

export async function runSession(opts: RunSessionOptions): Promise<RunSessionResult> {
  const now = opts.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();
  const parentEnv = opts.parentEnv ?? process.env;
  const io = opts.io ?? { stdout: process.stdout, stderr: process.stderr };
  const runGit = opts.runGit ?? defaultRunGit;

  const sessionId = randomUUID();
  const startedAt = nowIso();

  const db = openStateDb(opts.repoHash, { basePath: opts.basePath });
  let proxy: TokenProxy | null = null;

  const totals: TokenUsage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  let spendUsd = 0;
  const distillNotes: string[] = [];

  try {
    /* ---------------------------------------------------------------------- */
    /* Stage 1 — pre-flight                                                    */
    /* ---------------------------------------------------------------------- */

    let headCommit: string | null = null;
    try {
      const resolved = (await runGit(['rev-parse', 'HEAD'], opts.repoRoot)).trim();
      headCommit = resolved === '' ? null : resolved;
    } catch {
      headCommit = null;
    }

    let skillsFilePath: string | null = null;
    let skillVersionId: number | null = null;
    let injectedSkillsContent: string | null = null;

    if (!opts.noInject) {
      const activeSkills = await applyStalenessAndRetire({
        db,
        repoHash: opts.repoHash,
        repoRoot: opts.repoRoot,
        headCommit,
        runGit,
        stderr: io.stderr,
      });

      if (activeSkills.length > 0) {
        const written = writeSkillsArtifact({
          repoRoot: opts.repoRoot,
          repoHash: opts.repoHash,
          skills: activeSkills,
          config: opts.config,
          headCommit,
          sessionCount: countSessions(db, opts.repoHash),
        });
        skillsFilePath = written.filePath;
        skillVersionId = written.version;
        injectedSkillsContent = written.content;
      }
      // No active skills -> nothing is written or injected. A leftover artifact
      // from an earlier run is never passed to the child, so it cannot leak in.
    }

    /* ---------------------------------------------------------------------- */
    /* Stage 2/3 — proxy, watchdog, child                                      */
    /* ---------------------------------------------------------------------- */

    const upstreamBaseUrl =
      opts.cli === 'codex'
        ? (parentEnv.OPENAI_BASE_URL ?? 'https://api.openai.com/v1')
        : (parentEnv.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com');

    let child: ReturnType<typeof spawn> | null = null;
    let aborted = false;

    const actions: WatchdogActions = {
      banner: (message: string): void => {
        writeTo(io.stderr, `\n=== LogLode: ${message} ===\n`);
      },
      notify: (message: string): void => {
        // A real desktop notification is out of scope for the CLI; the terminal
        // line is the documented stand-in (§3 Stage 3).
        writeTo(io.stderr, `LogLode: ${message}\n`);
      },
      requestAbort: (reason: string): void => {
        aborted = true;
        const live = child;
        if (live !== null && live.exitCode === null && live.signalCode === null) {
          writeTo(io.stderr, `LogLode: sending SIGINT to the agent process (${reason})\n`);
          try {
            live.kill('SIGINT');
          } catch (error) {
            writeTo(io.stderr, `LogLode: could not signal the agent process: ${toError(error).message}\n`);
          }
        } else {
          writeTo(io.stderr, `LogLode: abort requested after the agent process exited (${reason})\n`);
        }
      },
    };

    const watchdog = new BudgetWatchdog(
      {
        budget: {
          ...opts.config.budget,
          hardStopUsd: opts.budgetUsd ?? opts.config.budget.hardStopUsd,
          softAlertUsd: opts.budgetUsd != null ? opts.budgetUsd * 0.5 : opts.config.budget.softAlertUsd,
        },
        loops: opts.config.loops,
        noKill: opts.noKill,
      },
      actions,
    );

    proxy = await startTokenProxy({
      upstreamBaseUrl,
      onUsage: (frame) => {
        addUsage(totals, frame.usage);
        const cost = estimateCostUsd(frame.usage, frame.model);
        if (Number.isFinite(cost) && cost > 0) {
          spendUsd += cost;
        }
        watchdog.onUsage(frame.model, frame.usage);
      },
      onError: (error) => {
        // Telemetry capture is best effort: a proxy error must never fail the run.
        writeTo(io.stderr, `LogLode: token proxy error: ${error.message}\n`);
      },
    });

    const spawnSpec = await buildSpawnSpec({
      opts,
      parentEnv,
      proxy,
      skillsFilePath,
      injectedSkillsContent,
    });

    let spawnError: Error | null = null;
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: opts.repoRoot,
        env: spawnSpec.env,
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      spawnError = toError(error);
      writeTo(io.stderr, `LogLode: failed to start '${spawnSpec.command}': ${spawnError.message}\n`);
    }

    /* ---------------------------------------------------------------------- */
    /* Event wiring                                                            */
    /* ---------------------------------------------------------------------- */

    const parser: SessionEventParser =
      opts.cli === 'codex' ? createCodexEventParser() : createClaudeEventParser();

    let sessionInserted = false;
    let parserStatus: 'completed' | 'aborted_budget' | 'failed' = 'completed';

    const provisionalRecord = (): SessionRecord => ({
      id: sessionId,
      repoHash: opts.repoHash,
      cliTool: opts.cli,
      taskPromptHash: null,
      gitHeadStart: headCommit,
      skillVersionId,
      // Provisional: finalizeSession writes the terminal status at the end.
      status: 'completed',
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      startedAt,
      endedAt: null,
    });

    const ensureSessionRow = (): void => {
      if (sessionInserted) {
        return;
      }
      insertSession(db, provisionalRecord());
      sessionInserted = true;
    };

    const persistToolCall = (record: ToolCallRecord): void => {
      insertToolCall(db, {
        ...record,
        targetPath: relativizeTargetPath(record.targetPath, opts.repoRoot),
        createdAt: record.createdAt ?? nowIso(),
      });
    };

    /** Tool calls seen but not yet completed by a `tool_result`. */
    const pendingCalls = new Map<number, ToolCallRecord[]>();

    const handleEvent = (event: CliEvent): void => {
      switch (event.type) {
        case 'session_start': {
          ensureSessionRow();
          return;
        }
        case 'tool_call': {
          // The session row must exist first: tool_calls.session_id is a FK.
          ensureSessionRow();
          watchdog.onToolCall({
            turnIndex: event.turnIndex,
            toolName: event.toolName,
            targetPath: event.targetPath,
          });
          const queue = pendingCalls.get(event.turnIndex) ?? [];
          queue.push({
            sessionId,
            turnIndex: event.turnIndex,
            toolName: event.toolName,
            targetPath: event.targetPath,
            commandSignature: event.commandSignature,
            exitCode: null,
            outputTokens: 0,
            errorFingerprint: null,
            createdAt: nowIso(),
          });
          pendingCalls.set(event.turnIndex, queue);
          return;
        }
        case 'tool_result': {
          ensureSessionRow();
          watchdog.onToolResult({
            turnIndex: event.turnIndex,
            exitCode: event.exitCode,
            outputTokens: event.outputTokens,
            errorFingerprint: event.errorFingerprint,
          });
          const queue = pendingCalls.get(event.turnIndex);
          const invocation = queue !== undefined ? queue.shift() : undefined;
          if (queue !== undefined && queue.length === 0) {
            pendingCalls.delete(event.turnIndex);
          }
          persistToolCall(
            invocation === undefined
              ? {
                  // A result without a matching invocation (e.g. a resumed
                  // stream): keep the telemetry instead of dropping it.
                  sessionId,
                  turnIndex: event.turnIndex,
                  toolName: 'unknown',
                  targetPath: null,
                  commandSignature: null,
                  exitCode: event.exitCode,
                  outputTokens: event.outputTokens,
                  errorFingerprint: event.errorFingerprint,
                  createdAt: nowIso(),
                }
              : {
                  ...invocation,
                  exitCode: event.exitCode,
                  outputTokens: event.outputTokens,
                  errorFingerprint: event.errorFingerprint,
                },
          );
          return;
        }
        case 'usage': {
          // The loopback proxy is the billing source of truth (§2). CLI-reported
          // usage is aggregated/partial, so consuming it here would double count.
          return;
        }
        case 'session_end': {
          parserStatus = event.status;
          return;
        }
        default: {
          return;
        }
      }
    };

    const feedLine = (line: string): void => {
      // Transparent passthrough first: the user sees exactly what the agent said,
      // even if a frame fails to parse or persist.
      writeTo(io.stdout, `${line}\n`);
      let events: CliEvent[];
      try {
        events = parser.write(line);
      } catch (error) {
        writeTo(io.stderr, `LogLode: failed to parse an agent output line: ${toError(error).message}\n`);
        return;
      }
      for (const event of events) {
        try {
          handleEvent(event);
        } catch (error) {
          writeTo(io.stderr, `LogLode: failed to persist telemetry: ${toError(error).message}\n`);
        }
      }
    };

    let stdoutDrained: Promise<void> = Promise.resolve();
    if (child !== null) {
      const live = child;
      if (live.stdout !== null) {
        const reader = createInterface({ input: live.stdout, crlfDelay: Infinity });
        stdoutDrained = new Promise<void>((resolve) => {
          reader.on('line', feedLine);
          reader.once('close', () => resolve());
        });
      }
      if (live.stderr !== null) {
        live.stderr.on('data', (chunk: Buffer) => {
          writeTo(io.stderr, chunk.toString());
        });
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Finish — wait for exit, flush, close the proxy                          */
    /* ---------------------------------------------------------------------- */

    const exit = await waitForChildExit(child, spawnError);
    await stdoutDrained;

    try {
      for (const event of parser.end()) {
        handleEvent(event);
      }
    } catch (error) {
      writeTo(io.stderr, `LogLode: failed to flush the event parser: ${toError(error).message}\n`);
    }

    // Tool calls whose result never arrived (child killed mid-flight) are still
    // real context cost, so flush them with a null exit code.
    for (const queue of pendingCalls.values()) {
      for (const invocation of queue) {
        try {
          persistToolCall(invocation);
        } catch (error) {
          writeTo(io.stderr, `LogLode: failed to persist a tool call: ${toError(error).message}\n`);
        }
      }
    }
    pendingCalls.clear();

    // Let the proxy finish scanning any response that was still in flight.
    await delay(PROXY_SETTLE_GRACE_MS);
    await proxy.close();

    if (exit.error !== null) {
      // A missing binary is the common setup failure; on Windows the npm-installed
      // agents are `.cmd` shims that child_process.spawn cannot launch directly, so
      // name that explicitly instead of leaving a bare ENOENT.
      const failure = exit.error as NodeJS.ErrnoException;
      const windowsHint =
        process.platform === 'win32' && failure.code === 'ENOENT'
          ? ' (hint: on Windows the agent CLI is usually a .cmd shim that spawn cannot execute directly; provide a directly executable wrapper via the `command` option)'
          : '';
      writeTo(io.stderr, `LogLode: the agent process could not run: ${exit.error.message}${windowsHint}\n`);
    }

    const status: RunSessionResult['status'] = aborted
      ? 'aborted_budget'
      : exit.error !== null || (parserStatus as RunSessionResult['status']) === 'failed'
        ? 'failed'
        : 'completed';

    // A child that dies before `session_start` still gets a row, so the store
    // records the failed attempt instead of finalizing a missing id.
    ensureSessionRow();
    finalizeSession(db, sessionId, {
      inputTokens: totals.inputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      outputTokens: totals.outputTokens,
      estimatedCostUsd: spendUsd,
      status,
      endedAt: nowIso(),
    });

    /* ---------------------------------------------------------------------- */
    /* Stage 4 — deterministic mining                                          */
    /* ---------------------------------------------------------------------- */

    const findings = mineWindow(db, opts.repoHash, { windowSize: MINING_WINDOW_SIZE }).flatMap(
      (entry) => entry.findings,
    );
    // Convergent re-mining (§3 Stage 4 stores *deduplicated* findings): the window
    // is re-detected from scratch on every run, so the window sessions' stored rows
    // are cleared before the fresh set is inserted. Without this, findings for an
    // earlier session would be duplicated on every `run`/`mine`.
    for (const windowSession of getRecentSessions(db, opts.repoHash, MINING_WINDOW_SIZE)) {
      deleteWasteFindingsForSession(db, opts.repoHash, windowSession.id);
    }
    if (findings.length > 0) {
      insertWasteFindings(db, findings);
    }
    const minedFindings = findings.length;

    /* ---------------------------------------------------------------------- */
    /* Stage 5 — gated distillation                                            */
    /* ---------------------------------------------------------------------- */

    const apiKey =
      typeof opts.distillerApiKey === 'string' && opts.distillerApiKey.trim() !== ''
        ? opts.distillerApiKey.trim()
        : null;

    if (apiKey === null) {
      distillNotes.push('distiller skipped: no ANTHROPIC_API_KEY was provided (LLM distillation disabled)');
    } else {
      // Distillation is an optimisation: every failure becomes a note, never a
      // failed session.
      try {
        const distilled = await distillSkills(
          {
            repoHash: opts.repoHash,
            findings,
            activeSkills: listActiveMicroSkills(db, opts.repoHash),
            config: opts.config.distiller,
          },
          { callLlm: createAnthropicDistillerCall(opts.config.distiller.model, apiKey) },
        );
        distillNotes.push(...distilled.notes);

        if (distilled.mutations.length > 0) {
          const applied = applyMutations(db, opts.repoHash, distilled.mutations, {
            config: opts.config.distiller,
            headCommit,
            now,
          });
          distillNotes.push(...applied.notes);

          // Baseline runs must not touch the artifact; the store still learned.
          if (!opts.noInject) {
            const rewritten = writeSkillsArtifact({
              repoRoot: opts.repoRoot,
              repoHash: opts.repoHash,
              skills: applied.skills,
              config: opts.config,
              headCommit,
              sessionCount: countSessions(db, opts.repoHash),
            });
            skillsFilePath = rewritten.filePath;
            distillNotes.push(
              `rewrote ${SKILLS_FILE_RELATIVE_PATH} at version ${rewritten.version} for the next session`,
            );
          }
        }
      } catch (error) {
        distillNotes.push(`distillation failed: ${toError(error).message}; the session is unaffected`);
      }
    }

    return {
      sessionId,
      status,
      usage: { ...totals },
      spendUsd,
      breaches: watchdog.getSummary().breaches,
      skillsFilePath,
      skillVersionId,
      minedFindings,
      distillNotes,
      childExitCode: exit.code,
    };
  } finally {
    // `close()` is idempotent, so the Stage-2 success path and this cleanup path
    // share it; cleanup must never mask the session's own result or error.
    if (proxy !== null) {
      try {
        await proxy.close();
      } catch {
        // Best effort: the port is released when the process exits.
      }
    }
    try {
      db.close();
    } catch {
      // Closing an already-closed handle is harmless.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Spawn-spec composition                                                      */
/* -------------------------------------------------------------------------- */

interface SpawnSpecInput {
  opts: RunSessionOptions;
  parentEnv: NodeJS.ProcessEnv;
  proxy: TokenProxy;
  skillsFilePath: string | null;
  injectedSkillsContent: string | null;
}

/**
 * Build the child command, argv and environment.
 *
 * Claude uses the adapter's `--append-system-prompt-file` spawn spec. Codex has
 * no such flag, so the rendered artifact is written into the managed block of
 * `AGENTS.md` and the child is pointed at the proxy via `OPENAI_BASE_URL`. The
 * argv is composed with the adapter's own `buildCodexArgs` so `--json` (the flag
 * that enables the JSONL stream this pipeline parses) is always present exactly
 * once.
 */
async function buildSpawnSpec(input: SpawnSpecInput): Promise<{
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}> {
  const { opts, parentEnv, proxy } = input;

  if (opts.cli === 'codex') {
    const agentsPath = join(opts.repoRoot, AGENTS_FILE_NAME);
    if (!opts.noInject) {
      if (input.injectedSkillsContent !== null) {
        await injectManagedBlock(agentsPath, input.injectedSkillsContent);
      } else {
        // Injection enabled but nothing to say: drop a previous block rather
        // than leaving stale rules in the agent's context.
        await removeManagedBlock(agentsPath);
      }
    }
    return {
      command: opts.command ?? 'codex',
      args: buildCodexArgs({ agentArgs: opts.agentArgs }),
      env: buildCodexEnv({ openaiBaseUrl: proxy.baseUrl, parentEnv }),
    };
  }

  return buildClaudeSpawn({
    command: opts.command,
    agentArgs: opts.agentArgs,
    systemPromptFilePath: input.skillsFilePath,
    anthropicBaseUrl: proxy.baseUrl,
    parentEnv,
  });
}

/* -------------------------------------------------------------------------- */
/* Child exit                                                                  */
/* -------------------------------------------------------------------------- */

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

/**
 * Resolve once the child is gone. A spawn failure (ENOENT, EACCES) arrives as an
 * `error` event instead of a `close` event, so both are handled and only the
 * first one wins; the error is surfaced to the caller as a failed session.
 */
function waitForChildExit(child: ReturnType<typeof spawn> | null, spawnError: Error | null): Promise<ChildExit> {
  if (child === null) {
    return Promise.resolve({ code: null, signal: null, error: spawnError ?? new Error('the child was not spawned') });
  }

  return new Promise<ChildExit>((resolve) => {
    let settled = false;
    const finish = (value: ChildExit): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    child.once('error', (error: Error) => finish({ code: null, signal: null, error }));
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) =>
      finish({ code, signal, error: null }),
    );
  });
}
