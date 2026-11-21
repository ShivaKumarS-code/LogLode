#!/usr/bin/env node
/**
 * LogLode command-line entrypoint (architecture §8 "CLI Contract").
 *
 * A hand-rolled, dependency-free argument parser plus the wiring for the five
 * subcommands:
 *
 *   loglode run     — wrap an agent session with telemetry/watchdog/mining
 *   loglode report  — token breakdown, USD cost, top waste findings
 *   loglode skills  — list | edit | prune | reset the repo's micro-skills
 *   loglode mine    — run the deterministic miner (and optional distiller) on demand
 *   loglode eval    — git-worktree A/B benchmark (`src/eval/benchmark.ts`)
 *
 * Everything the commands touch (stdout/stderr, environment, cwd, config paths)
 * is injected through `CliIo`, so `runCli` is fully testable without a terminal.
 * The `main()` auto-run guard compares `import.meta.url` with
 * `pathToFileURL(process.argv[1])`: importing this module never runs the CLI.
 *
 * Exit codes (documented contract):
 *   0  success
 *   1  runtime failure (not a repo, git failure on the critical path, failed session,
 *      a task command that could not determine Pass@1, unreadable report state)
 *   2  usage error (bad flags, missing required arguments, unparseable task suite)
 *
 * Deliberate extensions (see the piece report):
 * - `LOGLODE_HOME` relocates the `~/.loglode` state root. The committed store's
 *   `openStateDb({ basePath })` already supports it; the env var is how tests and
 *   relocated installs reach it without changing the store.
 * - `--budget` maps to `hardStopUsd`, with `softAlertUsd = budget * 0.5`
 *   (documented in `runSession`).
 * - `loglode eval` picks the agent from `[adapter] default_cli` (the §8 contract
 *   has no `--cli` flag for eval) and runs the agent's chatter on stderr so the
 *   Markdown report on stdout stays clean.
 */

import { exec, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { CliTool, MicroSkillRecord, RepoContext, WasteFindingRecord } from './adapters/types.js';
import { loadConfig, type LoglodeConfig } from './config.js';
import { parseLinkedPaths, checkSkillStaleness } from './distiller/staleness.js';
import { applyMutations, createAnthropicDistillerCall, distillSkills, roiScore } from './distiller/synthesize.js';
import {
  parseTasksYaml,
  renderCsvReport,
  renderMarkdownReport,
  runBenchmark,
  type BenchmarkReport,
  type EvalTask,
  type TaskRunOutcome,
} from './eval/benchmark.js';
import { mineWindow } from './miner/detectors.js';
import { resolveRepoContext } from './repo.js';
import {
  MINING_WINDOW_SIZE,
  SKILLS_FILE_RELATIVE_PATH,
  runSession,
  writeSkillsArtifact,
  type RunSessionResult,
} from './run/pipeline.js';
import type { LoglodeDb } from './store/db.js';
import { openStateDb } from './store/db.js';
import {
  countSessions,
  deactivateMicroSkill,
  getRecentSessions,
  getSession,
  getWasteFindingsForRepo,
  insertWasteFindings,
  listActiveMicroSkills,
  listAllMicroSkills,
} from './store/queries.js';

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/* Parse results                                                               */
/* -------------------------------------------------------------------------- */

export interface RunParseResult {
  kind: 'run';
  cli?: 'claude' | 'codex';
  noInject: boolean;
  noKill: boolean;
  budgetUsd?: number;
  /** Everything after `--`, verbatim. Never empty for a valid `run`. */
  agentArgs: string[];
}

export type ParseResult =
  | RunParseResult
  | { kind: 'report'; last?: number; session?: string }
  | { kind: 'skills'; sub: 'list' | 'edit' | 'prune' | 'reset' }
  | { kind: 'mine'; window?: number; dryRun: boolean }
  | { kind: 'eval'; suite: string; baseCommit?: string; csvPath?: string; testCmd?: string }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

/** Internal control-flow error; `parseCliArgs` turns it into `{ kind: 'error' }`. */
class ParseFailure extends Error {}

const RUN_AGENT_ARGS_ERROR = "run requires the agent command after '--'";

/* -------------------------------------------------------------------------- */
/* Parser                                                                      */
/* -------------------------------------------------------------------------- */

function parseNumber(raw: string | undefined, flag: string): number {
  if (raw === undefined || raw.trim() === '') {
    throw new ParseFailure(`${flag} requires a numeric value`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ParseFailure(`${flag} requires a non-negative number (got '${raw}')`);
  }
  return value;
}

function parsePositiveInteger(raw: string | undefined, flag: string): number {
  if (raw === undefined || raw.trim() === '') {
    throw new ParseFailure(`${flag} requires a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ParseFailure(`${flag} requires a positive integer (got '${raw}')`);
  }
  return value;
}

function parseRequiredValue(raw: string | undefined, flag: string): string {
  if (raw === undefined || raw.trim() === '') {
    throw new ParseFailure(`${flag} requires a value`);
  }
  return raw;
}

function unknownOption(command: string, arg: string): ParseFailure {
  return new ParseFailure(`unknown option '${arg}' for '${command}'`);
}

function parseRun(rest: string[]): RunParseResult {
  const separator = rest.indexOf('--');
  const flagArgs = separator === -1 ? rest : rest.slice(0, separator);
  const agentArgs = separator === -1 ? [] : rest.slice(separator + 1);

  let cli: 'claude' | 'codex' | undefined;
  let noInject = false;
  let noKill = false;
  let budgetUsd: number | undefined;

  for (let index = 0; index < flagArgs.length; index += 1) {
    const arg = flagArgs[index];
    switch (arg) {
      case '--cli': {
        const value = parseRequiredValue(flagArgs[index + 1], '--cli');
        index += 1;
        if (value !== 'claude' && value !== 'codex') {
          throw new ParseFailure(`--cli must be 'claude' or 'codex' (got '${value}')`);
        }
        cli = value;
        break;
      }
      case '--no-inject':
        noInject = true;
        break;
      case '--no-kill':
        noKill = true;
        break;
      case '--budget': {
        const value = flagArgs[index + 1];
        index += 1;
        budgetUsd = parseNumber(value, '--budget');
        break;
      }
      default:
        throw unknownOption('run', arg);
    }
  }

  if (separator === -1 || agentArgs.length === 0) {
    throw new ParseFailure(RUN_AGENT_ARGS_ERROR);
  }

  const result: RunParseResult = { kind: 'run', noInject, noKill, agentArgs };
  if (cli !== undefined) {
    result.cli = cli;
  }
  if (budgetUsd !== undefined) {
    result.budgetUsd = budgetUsd;
  }
  return result;
}

function parseReport(rest: string[]): ParseResult {
  let last: number | undefined;
  let session: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case '--last':
        last = parsePositiveInteger(rest[index + 1], '--last');
        index += 1;
        break;
      case '--session':
        session = parseRequiredValue(rest[index + 1], '--session');
        index += 1;
        break;
      default:
        throw arg.startsWith('-') ? unknownOption('report', arg) : new ParseFailure(`unexpected argument '${arg}' for 'report'`);
    }
  }

  const result: Extract<ParseResult, { kind: 'report' }> = { kind: 'report' };
  if (last !== undefined) {
    result.last = last;
  }
  if (session !== undefined) {
    result.session = session;
  }
  return result;
}

const SKILLS_SUBCOMMANDS = ['list', 'edit', 'prune', 'reset'] as const;
type SkillsSubcommand = (typeof SKILLS_SUBCOMMANDS)[number];

/**
 * Optional launch-binary override per adapter.
 *
 * Windows cannot `spawn` an npm `.cmd`/`.bat` shim without a shell (Node refuses
 * with EINVAL, and libuv never finds the bare name), so a Windows user running
 * `loglode run` needs a way to point LogLode at a directly executable entry
 * point — typically `node` plus the CLI's `.js` file as the first agent arg.
 * Unset (the default) keeps the adapter's own `claude` / `codex` default.
 */
function commandOverride(io: CliIo, cliTool: CliTool): string | undefined {
  const raw = cliTool === 'codex' ? envOf(io).LOGLODE_CODEX_BIN : envOf(io).LOGLODE_CLAUDE_BIN;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isSkillsSubcommand(value: string): value is SkillsSubcommand {
  return (SKILLS_SUBCOMMANDS as readonly string[]).includes(value);
}

function parseSkills(rest: string[]): ParseResult {
  if (rest.length === 0) {
    // Bare `loglode skills` is documented as `list`.
    return { kind: 'skills', sub: 'list' };
  }
  if (rest.length > 1) {
    throw new ParseFailure(`skills accepts at most one subcommand (${SKILLS_SUBCOMMANDS.join(' | ')}), got '${rest.join(' ')}'`);
  }
  const sub = rest[0];
  if (!isSkillsSubcommand(sub)) {
    throw rest[0].startsWith('-')
      ? unknownOption('skills', rest[0])
      : new ParseFailure(`unknown skills subcommand '${sub}'; expected ${SKILLS_SUBCOMMANDS.join(', ')}`);
  }
  return { kind: 'skills', sub };
}

function parseMine(rest: string[]): ParseResult {
  let window: number | undefined;
  let dryRun = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case '--window':
        window = parsePositiveInteger(rest[index + 1], '--window');
        index += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        throw arg.startsWith('-') ? unknownOption('mine', arg) : new ParseFailure(`unexpected argument '${arg}' for 'mine'`);
    }
  }

  const result: Extract<ParseResult, { kind: 'mine' }> = { kind: 'mine', dryRun };
  if (window !== undefined) {
    result.window = window;
  }
  return result;
}

function parseEval(rest: string[]): ParseResult {
  let suite: string | undefined;
  let baseCommit: string | undefined;
  let csvPath: string | undefined;
  let testCmd: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case '--suite':
        suite = parseRequiredValue(rest[index + 1], '--suite');
        index += 1;
        break;
      case '--base-commit':
        baseCommit = parseRequiredValue(rest[index + 1], '--base-commit');
        index += 1;
        break;
      case '--csv':
        csvPath = parseRequiredValue(rest[index + 1], '--csv');
        index += 1;
        break;
      case '--test-cmd':
        testCmd = parseRequiredValue(rest[index + 1], '--test-cmd');
        index += 1;
        break;
      default:
        throw arg.startsWith('-') ? unknownOption('eval', arg) : new ParseFailure(`unexpected argument '${arg}' for 'eval'`);
    }
  }

  if (suite === undefined) {
    throw new ParseFailure('eval requires --suite <path>');
  }

  const result: Extract<ParseResult, { kind: 'eval' }> = { kind: 'eval', suite };
  if (baseCommit !== undefined) {
    result.baseCommit = baseCommit;
  }
  if (csvPath !== undefined) {
    result.csvPath = csvPath;
  }
  if (testCmd !== undefined) {
    result.testCmd = testCmd;
  }
  return result;
}

function parseOrThrow(argv: string[]): ParseResult {
  // `--help`/`--version` win anywhere before the `--` terminator; after it the
  // tokens are the agent's own arguments and must stay verbatim.
  const terminator = argv.indexOf('--');
  const head = terminator === -1 ? argv : argv.slice(0, terminator);
  if (head.includes('--help') || head.includes('-h')) {
    return { kind: 'help' };
  }
  if (head.includes('--version')) {
    return { kind: 'version' };
  }

  if (argv.length === 0) {
    return { kind: 'help' };
  }

  const [command, ...rest] = argv;
  switch (command) {
    case 'run':
      return parseRun(rest);
    case 'report':
      return parseReport(rest);
    case 'skills':
      return parseSkills(rest);
    case 'mine':
      return parseMine(rest);
    case 'eval':
      return parseEval(rest);
    default:
      throw command.startsWith('-') ? unknownOption('loglode', command) : new ParseFailure(`unknown command '${command}'`);
  }
}

/**
 * Parse `argv` (the tokens after `node cli.js`) into a discriminated union.
 * Never throws: malformed input comes back as `{ kind: 'error' }`.
 */
export function parseCliArgs(argv: string[]): ParseResult {
  try {
    return parseOrThrow(argv);
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* IO plumbing                                                                 */
/* -------------------------------------------------------------------------- */

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configPaths?: { globalConfigPath?: string; repoConfigPath?: string };
}

function writeTo(stream: NodeJS.WritableStream, text: string): void {
  try {
    stream.write(text);
  } catch {
    // A closed pipe must not turn a completed command into a crash.
  }
}

function out(io: CliIo, text: string): void {
  writeTo(io.stdout, text);
}

function err(io: CliIo, text: string): void {
  writeTo(io.stderr, text);
}

function envOf(io: CliIo): NodeJS.ProcessEnv {
  return io.env ?? process.env;
}

function cwdOf(io: CliIo): string {
  return io.cwd ?? process.cwd();
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * State-root override. Mirrors `openStateDb({ basePath })`; empty values are
 * ignored so `LOGLODE_HOME=` behaves like an unset variable.
 */
function stateBasePath(io: CliIo): string | undefined {
  const raw = envOf(io).LOGLODE_HOME;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readApiKey(io: CliIo): string | null {
  const raw = envOf(io).ANTHROPIC_API_KEY;
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function openDb(io: CliIo, repoHash: string): LoglodeDb {
  return openStateDb(repoHash, { basePath: stateBasePath(io) });
}

async function resolveContextOrFail(io: CliIo): Promise<RepoContext | null> {
  try {
    return await resolveRepoContext(cwdOf(io));
  } catch (error) {
    err(io, `LogLode: ${toError(error).message}\n`);
    return null;
  }
}

function loadConfigOrFail(io: CliIo, repoRoot: string): LoglodeConfig | null {
  try {
    return loadConfig({ repoRoot, ...(io.configPaths ?? {}) });
  } catch (error) {
    err(io, `LogLode: ${toError(error).message}\n`);
    return null;
  }
}

async function resolveHeadCommit(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    const head = String(stdout).trim();
    return head === '' ? null : head;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                          */
/* -------------------------------------------------------------------------- */

const SHORT_SESSION_ID_LENGTH = 8;

function shortId(sessionId: string): string {
  return sessionId.slice(0, SHORT_SESSION_ID_LENGTH);
}

/** Render a left-aligned table; the last column is never padded. */
function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const formatRow = (row: string[]): string =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join('  ')
      .replace(/\s+$/, '');
  return [formatRow(header), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(formatRow)].join('\n');
}

function startedLabel(session: { startedAt: string | null }): string {
  return session.startedAt === null ? '-' : session.startedAt;
}

function skillsFilePathFor(repoRoot: string): string {
  return join(repoRoot, ...SKILLS_FILE_RELATIVE_PATH.split('/'));
}

function writeArtifactForRepo(
  db: LoglodeDb,
  context: RepoContext,
  config: LoglodeConfig,
  skills: MicroSkillRecord[],
  headCommit: string | null,
): { filePath: string; version: number } {
  const written = writeSkillsArtifact({
    repoRoot: context.repoRoot,
    repoHash: context.repoHash,
    skills,
    config,
    headCommit,
    sessionCount: countSessions(db, context.repoHash),
  });
  return { filePath: written.filePath, version: written.version };
}

/* -------------------------------------------------------------------------- */
/* run                                                                         */
/* -------------------------------------------------------------------------- */

async function runCommand(args: RunParseResult, io: CliIo): Promise<number> {
  const context = await resolveContextOrFail(io);
  if (context === null) {
    return 1;
  }
  const config = loadConfigOrFail(io, context.repoRoot);
  if (config === null) {
    return 1;
  }

  const cliTool: CliTool =
    args.cli === 'codex' ? 'codex' : args.cli === 'claude' ? 'claude_code' : config.adapter.defaultCli;

  let result: RunSessionResult;
  try {
    result = await runSession({
      cli: cliTool,
      agentArgs: args.agentArgs,
      repoRoot: context.repoRoot,
      repoHash: context.repoHash,
      noInject: args.noInject,
      noKill: args.noKill,
      budgetUsd: args.budgetUsd ?? null,
      config,
      basePath: stateBasePath(io),
      parentEnv: envOf(io),
      command: commandOverride(io, cliTool),
      distillerApiKey: readApiKey(io),
      io: { stdout: io.stdout, stderr: io.stderr },
    });
  } catch (error) {
    err(io, `LogLode: session failed: ${toError(error).message}\n`);
    return 1;
  }

  const totalInput =
    result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens;
  out(
    io,
    `session ${result.sessionId} ${result.status} — in ${totalInput} / out ${result.usage.outputTokens} tokens, $${result.spendUsd.toFixed(4)}\n`,
  );
  for (const note of result.distillNotes) {
    err(io, `LogLode: ${note}\n`);
  }
  for (const breach of result.breaches) {
    err(io, `LogLode: ${breach.hard ? 'hard' : 'soft'} breach ${breach.kind}: ${breach.message}\n`);
  }

  return result.status === 'failed' ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* report                                                                      */
/* -------------------------------------------------------------------------- */

function printWasteFindings(io: CliIo, findings: WasteFindingRecord[], limit: number): void {
  if (findings.length === 0) {
    out(io, 'Top waste findings: none\n');
    return;
  }
  out(io, 'Top waste findings:\n');
  for (const finding of findings.slice(0, limit)) {
    out(
      io,
      `  ${finding.patternType.padEnd(16)} ${finding.signature}  occurrences=${finding.occurrences}  wasted=${finding.wastedTokens}\n`,
    );
  }
}

async function reportCommand(args: Extract<ParseResult, { kind: 'report' }>, io: CliIo): Promise<number> {
  const context = await resolveContextOrFail(io);
  if (context === null) {
    return 1;
  }

  const db = openDb(io, context.repoHash);
  try {
    if (args.session !== undefined) {
      const session = getSession(db, args.session);
      if (session === null) {
        err(io, `LogLode: session '${args.session}' not found for repo ${context.repoHash}\n`);
        return 1;
      }
      out(io, `session ${session.id}\n`);
      out(io, `  repo:          ${session.repoHash}\n`);
      out(io, `  cli:           ${session.cliTool}\n`);
      out(io, `  status:        ${session.status}\n`);
      out(
        io,
        `  tokens:        in=${session.inputTokens} cacheR=${session.cacheReadTokens} cacheW=${session.cacheWriteTokens} out=${session.outputTokens}\n`,
      );
      out(io, `  cost:          $${session.estimatedCostUsd.toFixed(4)}\n`);
      out(io, `  started:       ${session.startedAt ?? '-'}\n`);
      out(io, `  ended:         ${session.endedAt ?? '-'}\n`);
      out(io, `  skill_version: ${session.skillVersionId === null ? '-' : session.skillVersionId}\n`);
      out(io, `  git_head:      ${session.gitHeadStart ?? '-'}\n`);

      const findings = getWasteFindingsForRepo(db, context.repoHash).filter(
        (finding) => finding.sessionId === session.id,
      );
      out(io, `\nwaste findings for ${session.id}:\n`);
      if (findings.length === 0) {
        out(io, '  none\n');
      } else {
        for (const finding of findings) {
          out(
            io,
            `  ${finding.patternType.padEnd(16)} ${finding.signature}  occurrences=${finding.occurrences}  wasted=${finding.wastedTokens}\n`,
          );
        }
      }
      return 0;
    }

    const limit = args.last ?? 10;
    const sessions = getRecentSessions(db, context.repoHash, limit);
    out(io, `repo ${context.repoHash} — last ${limit} session(s)\n`);
    if (sessions.length === 0) {
      out(io, 'no sessions recorded yet\n');
      return 0;
    }

    const header = ['id', 'cli', 'status', 'in', 'cacheR', 'cacheW', 'out', '$cost', 'started'];
    const rows = sessions.map((session) => [
      shortId(session.id),
      session.cliTool,
      session.status,
      String(session.inputTokens),
      String(session.cacheReadTokens),
      String(session.cacheWriteTokens),
      String(session.outputTokens),
      `$${session.estimatedCostUsd.toFixed(4)}`,
      startedLabel(session),
    ]);
    out(io, `${renderTable(header, rows)}\n`);

    out(io, '\n');
    printWasteFindings(io, getWasteFindingsForRepo(db, context.repoHash, { limit: 5 }), 5);
    return 0;
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* skills                                                                      */
/* -------------------------------------------------------------------------- */

async function skillsList(db: LoglodeDb, context: RepoContext, io: CliIo): Promise<number> {
  const skills = listAllMicroSkills(db, context.repoHash);
  out(io, `repo ${context.repoHash} — ${skills.length} micro-skill(s)\n`);
  if (skills.length === 0) {
    out(io, 'no micro-skills recorded yet\n');
    return 0;
  }

  const header = ['key', 'tokens', 'active', 'savings', 'links'];
  const rows = skills.map((skill) => [
    skill.skillKey,
    String(skill.tokenCount),
    skill.active === 1 ? 'yes' : 'no',
    String(skill.estimatedSavings),
    String(parseLinkedPaths(skill.linkedPathsJson).length),
  ]);
  out(io, `${renderTable(header, rows)}\n`);
  return 0;
}

async function skillsEdit(db: LoglodeDb, context: RepoContext, config: LoglodeConfig, io: CliIo): Promise<number> {
  const filePath = skillsFilePathFor(context.repoRoot);
  if (!existsSync(filePath)) {
    const headCommit = await resolveHeadCommit(context.repoRoot);
    const active = listActiveMicroSkills(db, context.repoHash);
    const written = writeArtifactForRepo(db, context, config, active, headCommit);
    out(io, `created ${written.filePath} (version ${written.version})\n`);
  }
  out(io, `${filePath}\n`);
  out(
    io,
    'hint: this file is injected into the next session; LogLode re-renders it from the store on the next pre-flight,\n' +
      '      so long-term edits belong in the distiller (or the store), not only in this file.\n',
  );
  return 0;
}

interface RetiredSkill {
  skillKey: string;
  detail: string;
}

/** Auto-retire deleted/renamed linked paths (mirrors the pipeline's pre-flight). */
async function retireStaleForRepo(
  db: LoglodeDb,
  context: RepoContext,
  headCommit: string | null,
): Promise<{ retired: RetiredSkill[]; flagged: number; unchecked: number }> {
  const groups = new Map<string, MicroSkillRecord[]>();
  for (const skill of listActiveMicroSkills(db, context.repoHash)) {
    const base = skill.lastValidatedCommit ?? '';
    const bucket = groups.get(base);
    if (bucket === undefined) {
      groups.set(base, [skill]);
    } else {
      bucket.push(skill);
    }
  }

  const retired: RetiredSkill[] = [];
  let flagged = 0;
  let unchecked = 0;
  for (const [baseCommit, skills] of groups) {
    const result = await checkSkillStaleness({
      repoRoot: context.repoRoot,
      skills,
      baseCommit: baseCommit === '' ? null : baseCommit,
      headCommit,
    });
    unchecked += result.unchecked.length;
    for (const entry of result.stale) {
      if (entry.reason === 'deleted' || entry.reason === 'renamed') {
        deactivateMicroSkill(db, context.repoHash, entry.skill.skillKey);
        retired.push({
          skillKey: entry.skill.skillKey,
          detail: `${entry.reason}: ${entry.changedPaths.join(', ')}`,
        });
      } else {
        flagged += 1;
      }
    }
  }
  return { retired, flagged, unchecked };
}

async function skillsPrune(db: LoglodeDb, context: RepoContext, config: LoglodeConfig, io: CliIo): Promise<number> {
  const headCommit = await resolveHeadCommit(context.repoRoot);
  const stale = await retireStaleForRepo(db, context, headCommit);

  for (const entry of stale.retired) {
    out(io, `retired ${entry.skillKey} (${entry.detail})\n`);
  }
  if (stale.flagged > 0) {
    out(io, `${stale.flagged} skill(s) reference changed (not deleted) paths; kept for review\n`);
  }
  if (stale.unchecked > 0) {
    out(io, `${stale.unchecked} skill(s) could not be staleness-checked (no validated commit or git failure)\n`);
  }

  // §6 safeguard 1: enforce the hard ceiling by evicting the lowest-ROI skills.
  let remaining = listActiveMicroSkills(db, context.repoHash);
  const cap = config.distiller.maxSkillFileTokens;
  const now = new Date();
  let evicted = 0;
  const totalTokens = (skills: MicroSkillRecord[]): number =>
    skills.reduce((sum, skill) => sum + (Number.isFinite(skill.tokenCount) ? skill.tokenCount : 0), 0);

  while (remaining.length > 0 && totalTokens(remaining) > cap) {
    let victim = remaining[0];
    let lowest = Number.POSITIVE_INFINITY;
    for (const skill of remaining) {
      const score = roiScore(skill, now);
      if (score < lowest) {
        lowest = score;
        victim = skill;
      }
    }
    if (victim === undefined) {
      break;
    }
    deactivateMicroSkill(db, context.repoHash, victim.skillKey);
    remaining = remaining.filter((skill) => skill.skillKey !== victim.skillKey);
    evicted += 1;
    out(
      io,
      `retired ${victim.skillKey} (token ceiling ${cap}: ${victim.tokenCount} tokens, ROI ${lowest.toFixed(3)})\n`,
    );
  }

  const written = writeArtifactForRepo(db, context, config, remaining, headCommit);
  out(
    io,
    `pruned: ${stale.retired.length} stale + ${evicted} token-ceiling skill(s) retired; ` +
      `${SKILLS_FILE_RELATIVE_PATH} re-rendered at version ${written.version} (${totalTokens(remaining)} active tokens)\n`,
  );
  return 0;
}

async function skillsReset(db: LoglodeDb, context: RepoContext, config: LoglodeConfig, io: CliIo): Promise<number> {
  const active = listAllMicroSkills(db, context.repoHash).filter((skill) => skill.active === 1);
  for (const skill of active) {
    deactivateMicroSkill(db, context.repoHash, skill.skillKey);
  }
  const headCommit = await resolveHeadCommit(context.repoRoot);
  const written = writeArtifactForRepo(db, context, config, [], headCommit);
  out(io, `reset: deactivated ${active.length} micro-skill(s); ${SKILLS_FILE_RELATIVE_PATH} rewritten empty (version ${written.version})\n`);
  return 0;
}

async function skillsCommand(sub: SkillsSubcommand, io: CliIo): Promise<number> {
  const context = await resolveContextOrFail(io);
  if (context === null) {
    return 1;
  }

  const db = openDb(io, context.repoHash);
  try {
    if (sub === 'list') {
      return await skillsList(db, context, io);
    }

    const config = loadConfigOrFail(io, context.repoRoot);
    if (config === null) {
      return 1;
    }
    switch (sub) {
      case 'edit':
        return await skillsEdit(db, context, config, io);
      case 'prune':
        return await skillsPrune(db, context, config, io);
      case 'reset':
        return await skillsReset(db, context, config, io);
      default: {
        // Exhaustiveness guard; `parseSkills` cannot produce anything else.
        err(io, `LogLode: unknown skills subcommand '${sub}'\n`);
        return 2;
      }
    }
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* mine                                                                        */
/* -------------------------------------------------------------------------- */

function printFindings(io: CliIo, windows: ReturnType<typeof mineWindow>): void {
  for (const window of windows) {
    out(io, `session ${window.sessionId}\n`);
    for (const finding of window.findings) {
      out(
        io,
        `  ${finding.patternType.padEnd(16)} ${finding.signature}  occurrences=${finding.occurrences}  wasted=${finding.wastedTokens}\n`,
      );
    }
  }
}

async function mineCommand(args: Extract<ParseResult, { kind: 'mine' }>, io: CliIo): Promise<number> {
  const context = await resolveContextOrFail(io);
  if (context === null) {
    return 1;
  }
  const config = loadConfigOrFail(io, context.repoRoot);
  if (config === null) {
    return 1;
  }

  const db = openDb(io, context.repoHash);
  try {
    const windowSize = args.window ?? MINING_WINDOW_SIZE;
    const windows = mineWindow(db, context.repoHash, { windowSize });
    const findings = windows.flatMap((window) => window.findings);

    out(io, `repo ${context.repoHash} — mined the last ${windowSize} session(s)\n`);
    if (findings.length === 0) {
      out(io, 'no waste findings\n');
    } else {
      printFindings(io, windows);
    }

    if (!args.dryRun && findings.length > 0) {
      insertWasteFindings(db, findings);
    }
    const wasted = findings.reduce((sum, finding) => sum + finding.wastedTokens, 0);
    const persistence =
      args.dryRun ? ' (dry run: not persisted)' : findings.length > 0 ? ' (persisted)' : ' (nothing to persist)';
    out(io, `total: ${findings.length} finding(s), ${wasted} wasted tokens${persistence}\n`);

    if (args.dryRun) {
      return 0;
    }

    // Stage 5 on demand, exactly like the pipeline: only with an API key.
    const apiKey = readApiKey(io);
    if (apiKey === null) {
      out(io, 'distiller skipped: ANTHROPIC_API_KEY is not set\n');
      return 0;
    }

    try {
      const distilled = await distillSkills(
        {
          repoHash: context.repoHash,
          findings,
          activeSkills: listActiveMicroSkills(db, context.repoHash),
          config: config.distiller,
        },
        { callLlm: createAnthropicDistillerCall(config.distiller.model, apiKey) },
      );
      for (const note of distilled.notes) {
        out(io, `distiller: ${note}\n`);
      }
      if (distilled.mutations.length > 0) {
        const headCommit = await resolveHeadCommit(context.repoRoot);
        const applied = applyMutations(db, context.repoHash, distilled.mutations, {
          config: config.distiller,
          headCommit,
        });
        for (const note of applied.notes) {
          out(io, `distiller: ${note}\n`);
        }
        const written = writeArtifactForRepo(db, context, config, applied.skills, headCommit);
        out(io, `distiller: rewrote ${SKILLS_FILE_RELATIVE_PATH} at version ${written.version}\n`);
      }
    } catch (error) {
      // Distillation is an optimisation; a failure must not fail `mine`.
      out(io, `distiller failed: ${toError(error).message}; findings were still persisted\n`);
    }

    return 0;
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* eval                                                                        */
/* -------------------------------------------------------------------------- */

/** Run the task's test command; 0 -> true, non-zero -> false, spawn error -> null. */
function runTestCommand(command: string, cwd: string): Promise<boolean | null> {
  return new Promise<boolean | null>((resolvePromise) => {
    exec(command, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error) => {
      if (error === null) {
        resolvePromise(true);
        return;
      }
      const code = (error as { code?: unknown }).code;
      resolvePromise(typeof code === 'number' ? false : null);
    });
  });
}

function agentArgsFor(cliTool: CliTool, task: EvalTask): string[] {
  // Headless, non-interactive invocations: Claude Code uses `-p`, Codex uses `exec`.
  return cliTool === 'codex' ? ['exec', task.prompt] : ['-p', task.prompt];
}

async function evalCommand(args: Extract<ParseResult, { kind: 'eval' }>, io: CliIo): Promise<number> {
  const cwd = cwdOf(io);
  const suitePath = resolve(cwd, args.suite);

  let source: string;
  try {
    source = readFileSync(suitePath, 'utf8');
  } catch (error) {
    err(io, `LogLode: cannot read task suite '${suitePath}': ${toError(error).message}\n`);
    return 2;
  }

  let tasks: EvalTask[];
  try {
    tasks = parseTasksYaml(source);
  } catch (error) {
    err(io, `LogLode: invalid task suite '${suitePath}': ${toError(error).message}\n`);
    return 2;
  }
  if (tasks.length === 0) {
    err(io, `LogLode: task suite '${suitePath}' contains no tasks\n`);
    return 2;
  }

  const context = await resolveContextOrFail(io);
  if (context === null) {
    return 1;
  }
  const config = loadConfigOrFail(io, context.repoRoot);
  if (config === null) {
    return 1;
  }

  let baseCommit = args.baseCommit;
  if (baseCommit === undefined) {
    const resolved = await resolveHeadCommit(context.repoRoot);
    if (resolved === null) {
      err(io, `LogLode: could not resolve HEAD in '${context.repoRoot}'; pass --base-commit <sha>\n`);
      return 1;
    }
    baseCommit = resolved;
  }

  const cliTool: CliTool = config.adapter.defaultCli;
  const env = envOf(io);
  const apiKey = readApiKey(io);

  const runTask = async (
    arm: 'baseline' | 'assisted',
    task: EvalTask,
    worktreeDir: string,
  ): Promise<TaskRunOutcome> => {
    const armContext = await resolveRepoContext(worktreeDir);
    const session: RunSessionResult = await runSession({
      cli: cliTool,
      agentArgs: agentArgsFor(cliTool, task),
      repoRoot: armContext.repoRoot,
      repoHash: armContext.repoHash,
      // §9 protocol: the control arm runs with injection disabled.
      noInject: arm === 'baseline',
      noKill: false,
      budgetUsd: null,
      config,
      basePath: stateBasePath(io),
      parentEnv: env,
      command: commandOverride(io, cliTool),
      // The control arm must not learn: only the treatment arm distils. Otherwise a
      // baseline task could write skills into the shared repo hash mid-benchmark and
      // contaminate the assisted arm.
      distillerApiKey: arm === 'baseline' ? null : apiKey,
      // Keep the report on stdout clean; agent chatter and banners go to stderr.
      io: { stdout: io.stderr, stderr: io.stderr },
    });

    const passed = args.testCmd === undefined ? null : await runTestCommand(args.testCmd, armContext.repoRoot);
    return {
      usage: session.usage,
      costUsd: session.spendUsd,
      passed,
      error: session.status === 'failed' ? `session ${session.sessionId} failed` : undefined,
    };
  };

  let report: BenchmarkReport;
  try {
    report = await runBenchmark({
      repoRoot: context.repoRoot,
      baseCommit,
      tasks,
      runTask,
    });
  } catch (error) {
    err(io, `LogLode: benchmark failed: ${toError(error).message}\n`);
    return 1;
  }

  out(io, renderMarkdownReport(report));

  if (args.csvPath !== undefined) {
    const csvPath = resolve(cwd, args.csvPath);
    try {
      writeFileSync(csvPath, renderCsvReport(report), 'utf8');
    } catch (error) {
      err(io, `LogLode: could not write CSV report to '${csvPath}': ${toError(error).message}\n`);
      return 1;
    }
    out(io, `csv report written to ${csvPath}\n`);
  }

  return 0;
}

/* -------------------------------------------------------------------------- */
/* Help / version                                                             */
/* -------------------------------------------------------------------------- */

export const USAGE_TEXT = `LogLode — local-first token telemetry and micro-skill mining for coding agents.

Usage:
  loglode run [--cli claude|codex] [--no-inject] [--no-kill] [--budget <usd>] -- <agent args...>
  loglode report [--last <n>] [--session <id>]
  loglode skills [list | edit | prune | reset]
  loglode mine [--window <n>] [--dry-run]
  loglode eval --suite <tasks.yaml> [--base-commit <sha>] [--csv <path>] [--test-cmd <command>]
  loglode --help | --version

Environment:
  ANTHROPIC_API_KEY   enables the post-run LLM distiller (skipped when unset)
  LOGLODE_HOME        overrides the state directory (default: ~/.loglode)
  LOGLODE_CLAUDE_BIN  launch command for Claude Code (default: claude)
  LOGLODE_CODEX_BIN   launch command for Codex (default: codex)

Windows note: npm installs agent CLIs as .cmd shims, which child_process.spawn
cannot execute without a shell. Point LOGLODE_CLAUDE_BIN at node and pass the
CLI's .js entry as the first agent argument, e.g.:
  set LOGLODE_CLAUDE_BIN=node
  loglode run -- "C:\\...\\@anthropic-ai\\claude-code\\cli.js" -p "fix the bug"`;

/** Version from the nearest `package.json` (src/cli.ts and dist/cli.js both see it one level up). */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version !== '') {
        return version;
      }
    }
  } catch {
    // A missing/renamed package.json falls back to a deterministic sentinel.
  }
  return '0.0.0';
}

/* -------------------------------------------------------------------------- */
/* Entrypoint                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the process exit code for `argv`.
 *
 * All expected failures are handled inside the command implementations; the
 * outer catch is the last line of defence so a bug never escapes as an unhandled
 * rejection with an unclear exit status.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseCliArgs(argv);

  try {
    switch (parsed.kind) {
      case 'help':
        out(io, `${USAGE_TEXT}\n`);
        return 0;
      case 'version':
        out(io, `${readPackageVersion()}\n`);
        return 0;
      case 'error':
        err(io, `LogLode: ${parsed.message}\n\n${USAGE_TEXT}\n`);
        return 2;
      case 'run':
        return await runCommand(parsed, io);
      case 'report':
        return await reportCommand(parsed, io);
      case 'skills':
        return await skillsCommand(parsed.sub, io);
      case 'mine':
        return await mineCommand(parsed, io);
      case 'eval':
        return await evalCommand(parsed, io);
      default: {
        err(io, 'LogLode: unsupported command\n');
        return 2;
      }
    }
  } catch (error) {
    err(io, `LogLode: ${toError(error).message}\n`);
    return 1;
  }
}

/**
 * Auto-run only when this module is the process entrypoint. Tests import the
 * module directly, so `import.meta.url` never matches the test runner's argv[1].
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      try {
        process.stderr.write(`LogLode: fatal: ${toError(error).message}\n`);
      } catch {
        // Nothing left to report to.
      }
      process.exitCode = 1;
    });
}
