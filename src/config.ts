/**
 * Minimal TOML-subset parser and typed config loader.
 *
 * LogLode keeps zero runtime dependencies, so this module implements only the
 * subset of TOML used by `.loglode/config.toml`: `[table]` headers, scalar
 * `key = value` lines (strings, integers/floats, booleans), `#` comments, and
 * blank lines. Arrays, inline tables, and multi-line strings are intentionally
 * unsupported and rejected with a line-numbered error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliTool } from './adapters/types.js';

type TomlScalar = string | number | boolean;
type TomlTable = Record<string, TomlScalar>;
type TomlDocument = Record<string, TomlTable>;

const TABLE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Remove a trailing `#` comment, ignoring `#` characters inside quoted strings. */
function stripComment(line: string): string {
  let inBasicString = false;
  let inLiteralString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inBasicString) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '"') {
        inBasicString = false;
      }
      continue;
    }
    if (inLiteralString) {
      if (char === "'") {
        inLiteralString = false;
      }
      continue;
    }
    if (char === '"') {
      inBasicString = true;
      continue;
    }
    if (char === "'") {
      inLiteralString = true;
      continue;
    }
    if (char === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseBasicString(text: string, lineNumber: number): string {
  let value = '';
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (index !== text.length - 1) {
        throw new Error(`Invalid TOML at line ${lineNumber}: unexpected characters after closing quote in '${text}'.`);
      }
      return value;
    }
    if (char === '\\') {
      const escaped = text[index + 1];
      switch (escaped) {
        case '"':
          value += '"';
          break;
        case '\\':
          value += '\\';
          break;
        case 'n':
          value += '\n';
          break;
        case 't':
          value += '\t';
          break;
        case 'r':
          value += '\r';
          break;
        default:
          throw new Error(`Invalid TOML at line ${lineNumber}: unsupported escape sequence '\\${escaped ?? ''}' in '${text}'.`);
      }
      index += 1;
      continue;
    }
    value += char;
  }
  throw new Error(`Invalid TOML at line ${lineNumber}: unterminated string '${text}'.`);
}

function parseLiteralString(text: string, lineNumber: number): string {
  const closing = text.indexOf("'", 1);
  if (closing === -1) {
    throw new Error(`Invalid TOML at line ${lineNumber}: unterminated string '${text}'.`);
  }
  if (closing !== text.length - 1) {
    throw new Error(`Invalid TOML at line ${lineNumber}: unexpected characters after closing quote in '${text}'.`);
  }
  return text.slice(1, -1);
}

function parseValue(text: string, lineNumber: number): TomlScalar {
  if (text.startsWith('"')) {
    return parseBasicString(text, lineNumber);
  }
  if (text.startsWith("'")) {
    return parseLiteralString(text, lineNumber);
  }
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  if (NUMBER_PATTERN.test(text)) {
    const value = Number(text);
    if (Number.isFinite(value)) {
      return value;
    }
    throw new Error(`Invalid TOML at line ${lineNumber}: number '${text}' is not finite.`);
  }
  throw new Error(`Invalid TOML at line ${lineNumber}: unsupported value '${text}' (expected a string, number, or boolean).`);
}

/**
 * Parse the supported TOML subset into a table map. Keys appearing before the
 * first `[table]` header are collected under the empty-string table so that a
 * stray root key does not abort loading; config consumers read named tables only.
 */
export function parseToml(source: string): Record<string, Record<string, string | number | boolean>> {
  const tables: TomlDocument = {};
  const lines = source.split(/\r?\n/);
  let currentTable = '';

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (line === '') {
      continue;
    }

    if (line.startsWith('[')) {
      if (!line.endsWith(']')) {
        throw new Error(`Invalid TOML at line ${lineNumber}: unterminated table header '${line}'.`);
      }
      const name = line.slice(1, -1).trim();
      if (!TABLE_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid TOML at line ${lineNumber}: invalid table name '${name}'.`);
      }
      currentTable = name;
      tables[currentTable] ??= {};
      continue;
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) {
      throw new Error(`Invalid TOML at line ${lineNumber}: expected 'key = value', got '${line}'.`);
    }
    const key = line.slice(0, equalsIndex).trim();
    const valueText = line.slice(equalsIndex + 1).trim();
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`Invalid TOML at line ${lineNumber}: invalid key '${key}'.`);
    }
    if (valueText === '') {
      throw new Error(`Invalid TOML at line ${lineNumber}: missing value for key '${key}'.`);
    }

    const table = (tables[currentTable] ??= {});
    if (Object.prototype.hasOwnProperty.call(table, key)) {
      const scope = currentTable === '' ? '' : ` in table [${currentTable}]`;
      throw new Error(`Invalid TOML at line ${lineNumber}: duplicate key '${key}'${scope}.`);
    }
    table[key] = parseValue(valueText, lineNumber);
  }

  return tables;
}

export interface AdapterConfig {
  defaultCli: CliTool;
  injectionMode: 'system_prompt' | 'managed_md_block';
}

export interface BudgetConfig {
  softAlertUsd: number;
  hardStopUsd: number;
  maxSingleTurnTokens: number;
}

export interface LoopsConfig {
  maxSameErrorRetries: number;
  maxSameFileReads: number;
  minCacheHitRatio: number;
}

export interface DistillerConfig {
  model: string;
  maxSkillFileTokens: number;
  minSessionsToPromote: number;
  minSingleSessionWaste: number;
}

export interface LoglodeConfig {
  adapter: AdapterConfig;
  budget: BudgetConfig;
  loops: LoopsConfig;
  distiller: DistillerConfig;
}

/** Defaults from docs/architecture.md §7 ("Configuration & Watchdog Rules"). */
export const DEFAULT_CONFIG: LoglodeConfig = {
  adapter: {
    defaultCli: 'claude_code',
    injectionMode: 'system_prompt',
  },
  budget: {
    softAlertUsd: 0.75,
    hardStopUsd: 2.0,
    maxSingleTurnTokens: 25000,
  },
  loops: {
    maxSameErrorRetries: 3,
    maxSameFileReads: 4,
    minCacheHitRatio: 0.5,
  },
  distiller: {
    model: 'claude-haiku-4-5',
    maxSkillFileTokens: 800,
    minSessionsToPromote: 2,
    minSingleSessionWaste: 8000,
  },
};

function cloneDefaultConfig(): LoglodeConfig {
  return {
    adapter: { ...DEFAULT_CONFIG.adapter },
    budget: { ...DEFAULT_CONFIG.budget },
    loops: { ...DEFAULT_CONFIG.loops },
    distiller: { ...DEFAULT_CONFIG.distiller },
  };
}

function readString(table: TomlTable, key: string, sourcePath: string, tableName: string): string | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid config in ${sourcePath}: [${tableName}] ${key} must be a string.`);
  }
  return value;
}

function readNumber(table: TomlTable, key: string, sourcePath: string, tableName: string): number | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number') {
    throw new Error(`Invalid config in ${sourcePath}: [${tableName}] ${key} must be a number.`);
  }
  return value;
}

function isCliTool(value: string): value is CliTool {
  return value === 'claude_code' || value === 'codex';
}

function applyConfigTable(config: LoglodeConfig, doc: TomlDocument, sourcePath: string): void {
  const adapter = doc.adapter;
  if (adapter !== undefined) {
    const defaultCli = readString(adapter, 'default_cli', sourcePath, 'adapter');
    if (defaultCli !== undefined) {
      if (!isCliTool(defaultCli)) {
        throw new Error(`Invalid config in ${sourcePath}: [adapter] default_cli must be "claude_code" or "codex" (got "${defaultCli}").`);
      }
      config.adapter.defaultCli = defaultCli;
    }

    const injectionMode = readString(adapter, 'injection_mode', sourcePath, 'adapter');
    if (injectionMode !== undefined) {
      if (injectionMode !== 'system_prompt' && injectionMode !== 'managed_md_block') {
        throw new Error(
          `Invalid config in ${sourcePath}: [adapter] injection_mode must be "system_prompt" or "managed_md_block" (got "${injectionMode}").`,
        );
      }
      config.adapter.injectionMode = injectionMode;
    }
  }

  const budget = doc.budget;
  if (budget !== undefined) {
    const softAlertUsd = readNumber(budget, 'soft_alert_usd', sourcePath, 'budget');
    if (softAlertUsd !== undefined) config.budget.softAlertUsd = softAlertUsd;
    const hardStopUsd = readNumber(budget, 'hard_stop_usd', sourcePath, 'budget');
    if (hardStopUsd !== undefined) config.budget.hardStopUsd = hardStopUsd;
    const maxSingleTurnTokens = readNumber(budget, 'max_single_turn_tokens', sourcePath, 'budget');
    if (maxSingleTurnTokens !== undefined) config.budget.maxSingleTurnTokens = maxSingleTurnTokens;
  }

  const loops = doc.loops;
  if (loops !== undefined) {
    const maxSameErrorRetries = readNumber(loops, 'max_same_error_retries', sourcePath, 'loops');
    if (maxSameErrorRetries !== undefined) config.loops.maxSameErrorRetries = maxSameErrorRetries;
    const maxSameFileReads = readNumber(loops, 'max_same_file_reads', sourcePath, 'loops');
    if (maxSameFileReads !== undefined) config.loops.maxSameFileReads = maxSameFileReads;
    const minCacheHitRatio = readNumber(loops, 'min_cache_hit_ratio', sourcePath, 'loops');
    if (minCacheHitRatio !== undefined) config.loops.minCacheHitRatio = minCacheHitRatio;
  }

  const distiller = doc.distiller;
  if (distiller !== undefined) {
    const model = readString(distiller, 'model', sourcePath, 'distiller');
    if (model !== undefined) config.distiller.model = model;
    const maxSkillFileTokens = readNumber(distiller, 'max_skill_file_tokens', sourcePath, 'distiller');
    if (maxSkillFileTokens !== undefined) config.distiller.maxSkillFileTokens = maxSkillFileTokens;
    const minSessionsToPromote = readNumber(distiller, 'min_sessions_to_promote', sourcePath, 'distiller');
    if (minSessionsToPromote !== undefined) config.distiller.minSessionsToPromote = minSessionsToPromote;
    const minSingleSessionWaste = readNumber(distiller, 'min_single_session_waste', sourcePath, 'distiller');
    if (minSingleSessionWaste !== undefined) config.distiller.minSingleSessionWaste = minSingleSessionWaste;
  }
}

function readConfigDocument(path: string): TomlDocument | null {
  if (!existsSync(path)) {
    return null;
  }
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read LogLode config at ${path}: ${(error as Error).message}`);
  }
  try {
    return parseToml(source);
  } catch (error) {
    throw new Error(`Failed to parse LogLode config at ${path}: ${(error as Error).message}`);
  }
}

export interface LoadConfigOptions {
  /** Repository root; used to locate `{repoRoot}/.loglode/config.toml`. Defaults to `process.cwd()`. */
  repoRoot?: string;
  /** Explicit global config path; replaces `~/.loglode/config.toml`. */
  globalConfigPath?: string;
  /** Explicit repo config path; takes precedence over `repoRoot`. */
  repoConfigPath?: string;
}

/**
 * Load the effective config.
 *
 * Merge order (later wins): DEFAULT_CONFIG -> global (`~/.loglode/config.toml`) ->
 * repo (`{repoRoot}/.loglode/config.toml`). Missing files are skipped silently and
 * unknown keys are ignored. Callers that need determinism (tests, `--config`) pass
 * explicit paths instead of relying on the home directory.
 */
export function loadConfig(opts: LoadConfigOptions = {}): LoglodeConfig {
  const globalPath = opts.globalConfigPath ?? join(homedir(), '.loglode', 'config.toml');
  const repoPath = opts.repoConfigPath ?? join(opts.repoRoot ?? process.cwd(), '.loglode', 'config.toml');

  const config = cloneDefaultConfig();

  const globalDocument = readConfigDocument(globalPath);
  if (globalDocument !== null) {
    applyConfigTable(config, globalDocument, globalPath);
  }

  const repoDocument = readConfigDocument(repoPath);
  if (repoDocument !== null) {
    applyConfigTable(config, repoDocument, repoPath);
  }

  return config;
}
