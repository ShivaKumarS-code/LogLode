/**
 * Shared contract types for LogLode.
 *
 * Every adapter, store, watchdog, miner, distiller, and eval module speaks these
 * shapes. Treat the names and field types as load-bearing: they mirror the
 * architecture specification and the SQLite schema.
 */

export type CliTool = 'claude_code' | 'codex';
export type WastePatternType = 'repeat_read' | 'fail_loop' | 'search_thrash' | 'log_flood' | 'edit_oscillation';
export type BreachKind = 'soft_alert' | 'hard_stop' | 'retry_loop' | 'read_loop' | 'single_turn_spike' | 'cache_collapse';

export interface RepoContext { repoRoot: string; repoHash: string; }

export interface TokenUsage {
  inputTokens: number;       // uncached input tokens (provider `input_tokens`, excludes cached)
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface SessionRecord extends TokenUsage {
  id: string;                // UUID
  repoHash: string;
  cliTool: CliTool;
  taskPromptHash: string | null;
  gitHeadStart: string | null;
  skillVersionId: number | null;   // NULL for baseline / --no-inject runs
  status: string;                  // 'completed' | 'aborted_budget' | 'failed'
  estimatedCostUsd: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ToolCallRecord {
  sessionId: string;
  turnIndex: number;
  toolName: string;                // 'read_file' | 'bash' | 'edit' | 'grep' | 'glob' (free-form tolerated)
  targetPath: string | null;       // normalised repo-relative path, forward slashes
  commandSignature: string | null; // normalised cmd: flags kept, ephemeral args stripped
  exitCode: number | null;
  outputTokens: number;            // tokens returned back into agent context
  errorFingerprint: string | null; // hash of first 2 normalised stderr lines
  createdAt: string | null;
}

export type CliEvent =
  | { type: 'session_start'; cliTool: CliTool; taskPromptHash: string | null }
  | { type: 'tool_call'; turnIndex: number; toolName: string; targetPath: string | null; commandSignature: string | null }
  | { type: 'tool_result'; turnIndex: number; exitCode: number | null; outputTokens: number; errorFingerprint: string | null }
  | { type: 'usage'; model: string; usage: TokenUsage }
  | { type: 'session_end'; status: 'completed' | 'aborted_budget' | 'failed' };

export interface WatchdogBreach { kind: BreachKind; message: string; hard: boolean; }
export interface WatchdogActions {
  banner(message: string): void;
  notify(message: string): void;
  requestAbort(reason: string): void;   // CLI wiring decides whether to SIGINT the child
}

export interface WasteFindingRecord {
  repoHash: string;
  sessionId: string;
  patternType: WastePatternType;
  signature: string;             // cross-session deduplication key
  occurrences: number;
  wastedTokens: number;
  evidenceJson: string;          // JSON.stringify of evidence object
}

export interface MicroSkillRecord {
  id: number | null;
  repoHash: string;
  skillKey: string;               // stable slug, e.g. 'test-runner-flags'
  ruleText: string;               // 1-3 terse imperative lines
  tokenCount: number;
  linkedPathsJson: string | null;      // JSON array of repo-relative paths
  sourceSessions: number;
  estimatedSavings: number;
  lastValidatedCommit: string | null;
  active: number;                // 1 | 0
  updatedAt: string | null;
}

export type SkillMutationOp = 'add' | 'merge' | 'tighten' | 'retire';
export interface SkillMutation {
  op: SkillMutationOp;
  skillKey: string;
  ruleText?: string;
  linkedPaths?: string[];
  mergeIntoKey?: string;   // for op 'merge': absorb skillKey into this existing key
  rationale?: string;
}
export interface DistillerResponse { mutations: SkillMutation[]; }
