# LogLode — System Architecture Specification

**Project:** LogLode  
**Type:** Local-first CLI wrapper, real-time token cost watchdog, and cross-session micro-skill miner for coding agents (Claude Code, Codex CLI)  
**Core Objective:** Log agent trajectories across sequential tasks on the same repository, mine recurring token waste deterministically, distill actionable rules into an auto-generated `micro-skills.md` injected into Task $N+1$, and fire live budget/loop alerts.  
**Primary Success Metric:** Percentage token reduction ($\Delta T_{\%}$) and cost-weighted token reduction ($T_{\text{eff}}$) on Task $N+1$ vs. baseline while maintaining `Pass@1` parity.

---

## 1. Architectural Overview & Core Trade-Off

LogLode uses a **local-first, zero-infrastructure architecture**: a single CLI wrapper (`loglode`) backed by SQLite and plain Markdown. Execution is split into two distinct loops:

1. **Online Loop (During Task $N$):** Injects validated micro-skills, captures structured tool/turn trajectories and exact API token telemetry via a loopback proxy, and enforces real-time budget and loop circuit-breakers.
2. **Offline Loop (Post-Task $N$):** Runs deterministic (zero-LLM) waste detectors across recent repo trajectories, distills recurring high-cost waste into terse imperative rules via a cheap LLM call, and updates `.loglode/micro-skills.md` for Task $N+1$.

**Central Trade-Off — Anti-Bloat ROI:**  
Every token injected into future sessions' system prompts is billed on every turn (even at cached-input rates). Therefore, the distiller **must** enforce a hard token ceiling, promotion thresholds, and git-diff staleness checks to guarantee net positive token savings.

```text
                        ┌──────────────────────────────────────────────────────┐
                        │                  USER: loglode run                   │
                        └──────────────────────────┬───────────────────────────┘
                                                   │
            ┌──────────────────────────────────────▼──────────────────────────────────────┐
            │                         1. ONLINE LOOP (Task N)                             │
            │                                                                             │
            │  ┌─────────────────┐    injects      ┌───────────────────────────────────┐  │
            │  │ Context Injector│────────────────►│  CLI Adapter (Claude Code / Codex)│  │
            │  │ (.micro-skills) │                 │  - stream-json / JSONL / hooks    │  │
            │  └─────────────────┘                 └────────┬─────────────────┬────────┘  │
            │                                               │ tool events     │ API calls │
            │                                               ▼                 ▼           │
            │                                      ┌───────────────────────────────────┐  │
            │                                      │   Normaliser + Local HTTP Proxy   │  │
            │                                      │  (exact input/cache/output tokens)│  │
            │                                      └────────┬─────────────────┬────────┘  │
            │                                               │                 │           │
            │                              ┌────────────────▼───┐     ┌───────▼────────┐  │
            │                              │  Budget Watchdog   │     │ SQLite Store   │  │
            │                              │  - spend/loop caps │     │ (trajectories) │  │
            │                              │  - alerts / SIGINT │     └───────┬────────┘  │
            │                              └────────────────────┘             │           │
            └─────────────────────────────────────────────────────────────────┼───────────┘
                                                                              │ session end
            ┌─────────────────────────────────────────────────────────────────▼───────────┐
            │                        2. OFFLINE LOOP (Post-Task)                          │
            │                                                                             │
            │  ┌────────────────────┐   waste clusters   ┌─────────────────────────────┐  │
            │  │ Deterministic Miner│───────────────────►│    Micro-Skill Distiller    │  │
            │  │ (zero-LLM rules)   │                    │  - cheap LLM synthesis      │  │
            │  └────────────────────┘                    │  - token ceiling & pruning  │  │
            │                                            └──────────────┬──────────────┘  │
            │                                                           ▼                 │
            │                                            ┌─────────────────────────────┐  │
            │                                            │   .loglode/micro-skills.md  │  │
            │                                            │  (versioned, git-checked)   │  │
            │                                            └──────────────┬──────────────┘  │
            └───────────────────────────────────────────────────────────┼─────────────────┘
                                                                        │ fed into Task N+1
            ┌───────────────────────────────────────────────────────────▼─────────────────┐
            │                       3. EVAL & TELEMETRY HARNESS                           │
            │   Baseline vs Assisted replay · Cost-weighted token delta · Pass@1 parity   │
            └─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Modules & Responsibilities

| Module | Responsibility | Implementation Choice |
| :--- | :--- | :--- |
| **CLI Entrypoint** | Exposes `run`, `report`, `skills`, `mine`, and `eval` subcommands | TypeScript (Node 20+ / Bun) or Python 3.11+ |
| **CLI Adapters** | Spawns `claude` or `codex`, injects active micro-skills, and streams structured tool/turn events | `--output-format stream-json` (Claude Code) / JSONL output (Codex CLI) + lifecycle hooks |
| **Loopback HTTP Proxy** | Intercepts `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` locally to capture exact `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `output_tokens` without breaking SSE streaming | Lightweight loopback forwarder (`127.0.0.1:0`, ephemeral port per session) |
| **Trajectory Store** | Persists normalised turns, tool calls, file paths, exit codes, waste findings, and skills per repo | SQLite (`~/.loglode/repos/{repo_hash}/state.db`) in WAL mode |
| **Budget Watchdog** | Tracks live session spend, burn rate, repeating loops, and cache-hit drops; emits alerts or aborts runaway sessions | In-process event subscriber; terminal banners, OS notifications, and soft/hard `SIGINT` circuit-breakers |
| **Deterministic Miner** | Scans finished trajectories for recurring high-cost anti-patterns without calling an LLM | Pure SQL + heuristic detectors outputting structured `WasteFinding` records |
| **Micro-Skill Distiller** | Synthesises top-ranked `WasteFinding` clusters into concise imperative repo rules under a strict token cap | Single call to a fast/cheap model (e.g., Haiku / GPT-4o-mini) with strict JSON schema output and local tokenizer verification |
| **Context Injector** | Feeds distilled skills into Task $N+1$ in a prompt-cache-friendly static position | `--append-system-prompt-file` (Claude Code) or managed fenced block in `CLAUDE.local.md` / `AGENTS.md` |
| **Eval Harness** | Measures $\Delta T_{\%}$, $T_{\text{eff}}$, and `Pass@1` parity across sequential task suites | Git worktree A/B runner replaying identical task sequences from a pinned base commit |

---

## 3. Runtime Execution Pipeline

### Stage 1: Pre-Flight Validation & Injection (Before Task $N$)
1. Resolve the git repository root and compute `repo_hash` (SHA-256 prefix of normalised remote URL, falling back to absolute path).
2. Open `~/.loglode/repos/{repo_hash}/state.db` and load active rows from `micro_skills`.
3. Run `git diff --name-only <last_validated_commit>..HEAD` against each skill's `linked_paths_json`. Auto-retire or flag stale any skill referencing deleted or renamed paths.
4. Render `.loglode/micro-skills.md` and pass it into the CLI adapter in a static system-prompt slot so subsequent turns hit the provider's prompt cache.

### Stage 2: Dual-Layer Telemetry Capture (During Task $N$)
1. Bind the loopback HTTP proxy on `127.0.0.1:0` and inject `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` into the spawned child process environment.
2. Parse structured CLI events (`stream-json` / JSONL) and proxy SSE usage frames into provider-agnostic records (`Session`, `ToolCall`, `ApiUsage`).
3. Persist records to SQLite in real time while forwarding all child stdout/stderr transparently to the user.

### Stage 3: Live Watchdog Evaluation (Per Turn & Tool Result)
After every tool call or API response frame, evaluate sliding-window rules:
- **Spend Caps:** Compare cumulative estimated USD cost against `soft_alert_usd` and `hard_stop_usd`.
- **Loop Circuit-Breaker:** Fire when the same `error_fingerprint` repeats $\ge 3$ times or the same `target_path` is read $\ge 4$ times without an intervening edit.
- **Single-Turn Spike:** Flag any single tool output exceeding `max_single_turn_tokens` (e.g., accidental lockfile read or verbose test dump).
- **Cache-Hit Collapse:** Warn after turn 4 if $\frac{T_{\text{cache\_read}}}{T_{\text{in,total}}} < 0.50$.

On soft breaches, print a highlighted banner and emit an OS notification. On hard breaches, pause for confirmation or send `SIGINT` (unless `--no-kill` is set).

### Stage 4: Deterministic Waste Mining (On Session Exit)
1. Run the 5 zero-LLM detectors over the completed session and a rolling window of the last 5–10 sessions for the same `repo_hash`.
2. Attribute recoverable tokens to each cluster (injected tool output tokens plus wasted retry turns).
3. Store deduplicated `waste_findings` ranked by recoverable token cost.

### Stage 5: Micro-Skill Distillation & Pruning (Threshold-Gated)
1. Trigger distillation **only** if newly mined recoverable waste exceeds the promotion threshold (appeared in $\ge 2$ sessions OR wasted $> 8{,}000$ tokens in a single session).
2. Send the top-ranked `WasteFinding` records plus the current active `micro_skills` list to a cheap distiller LLM requesting structured JSON mutations (`add`, `merge`, `tighten`, `retire`).
3. Count tokens locally, enforce the hard token ceiling (default: 800 tokens) by evicting the lowest-ROI skills, persist the new skill version in SQLite, and regenerate `.loglode/micro-skills.md` for Task $N+1$.

---

## 4. Data Schema (SQLite — WAL Mode)

File location: `~/.loglode/repos/{repo_hash}/state.db`

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  repo_hash           TEXT NOT NULL,
  cli_tool            TEXT NOT NULL,          -- 'claude_code' | 'codex'
  task_prompt_hash    TEXT,
  git_head_start      TEXT,
  skill_version_id    INTEGER,                -- NULL for baseline / --no-inject runs
  status              TEXT,                   -- 'completed' | 'aborted_budget' | 'failed'
  input_tokens        INTEGER DEFAULT 0,
  cache_read_tokens   INTEGER DEFAULT 0,
  cache_write_tokens  INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  estimated_cost_usd  REAL DEFAULT 0.0,
  started_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at            DATETIME
);

CREATE TABLE tool_calls (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  turn_index          INTEGER NOT NULL,
  tool_name           TEXT NOT NULL,          -- 'read_file' | 'bash' | 'edit' | 'grep' | 'glob'
  target_path         TEXT,                   -- normalised repo-relative path
  command_signature   TEXT,                   -- normalised cmd (flags kept, ephemeral args stripped)
  exit_code           INTEGER,
  output_tokens       INTEGER DEFAULT 0,      -- tokens returned back into agent context
  error_fingerprint   TEXT,                   -- hash of first 2 normalised stderr lines
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE waste_findings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_hash           TEXT NOT NULL,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  pattern_type        TEXT NOT NULL,          -- 'repeat_read' | 'fail_loop' | 'search_thrash' | 'log_flood' | 'edit_oscillation'
  signature           TEXT NOT NULL,          -- cross-session deduplication key
  occurrences         INTEGER NOT NULL,
  wasted_tokens       INTEGER NOT NULL,
  evidence_json       TEXT NOT NULL,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE micro_skills (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_hash             TEXT NOT NULL,
  skill_key             TEXT NOT NULL,        -- stable slug, e.g. 'test-runner-flags'
  rule_text             TEXT NOT NULL,        -- 1-3 terse imperative lines
  token_count           INTEGER NOT NULL,
  linked_paths_json     TEXT,                 -- JSON array of repo-relative paths for staleness check
  source_sessions       INTEGER DEFAULT 1,
  estimated_savings     INTEGER DEFAULT 0,
  last_validated_commit TEXT,
  active                INTEGER DEFAULT 1,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_hash, skill_key)
);

CREATE INDEX idx_tool_calls_session ON tool_calls(session_id, turn_index);
CREATE INDEX idx_tool_calls_path ON tool_calls(target_path);
CREATE INDEX idx_waste_repo_sig ON waste_findings(repo_hash, signature);
CREATE INDEX idx_skills_repo_active ON micro_skills(repo_hash, active);
```

---

## 5. Deterministic Waste Mining Heuristics (Zero-LLM Layer)

All detectors run purely on SQLite data before invoking any LLM.

| Pattern Type (`pattern_type`) | Detection Rule | Distilled Micro-Skill Output |
| :--- | :--- | :--- |
| **`repeat_read`** | Same `target_path` read $\ge 3$ times within one session with no intervening `edit`, or read across $\ge 3$ consecutive sessions | One-line map of key exports/entry points (e.g., *"Auth middleware lives in `src/auth/guard.ts:40-95`; avoid re-reading index barrels."*) |
| **`fail_loop`** | Identical `command_signature` or `error_fingerprint` exiting non-zero $\ge 2$ times, followed by a succeeding variant | Exact working command invocation (e.g., *"Run unit tests via `pnpm --filter api test -- --run`; bare `vitest` hangs in watch mode."*) |
| **`search_thrash`** | $\ge 4$ consecutive `grep`/`glob` calls returning empty results or producing zero subsequent edits | Repo directory layout and naming note (e.g., *"Shared types live in `packages/contracts/src`, not `src/types`."*) |
| **`log_flood`** | Single `bash` or `read_file` tool response with `output_tokens` $> 4{,}000$ (lockfiles, build dumps, raw stack traces) | Scoped flags and ignore rules (e.g., *"Never read `pnpm-lock.yaml`; invoke pytest with `-q --tb=short`."*) |
| **`edit_oscillation`** | Same `target_path` edited $\ge 3$ times across consecutive turns interleaved with recurring lint/typecheck failures | Project invariant or strict compiler constraint learned from the final passing diff |

---

## 6. Micro-Skill Artifact Format & Anti-Bloat Controls

Generated file path: `.loglode/micro-skills.md` (git-ignored by default; teams may optionally commit it).

```markdown
---
repo_hash: 8f3a1c9d
version: 4
token_count: 142
budget_cap: 800
last_commit: a91c4e2
---

# LogLode Repo Micro-Skills (Auto-mined from 6 sessions)

## Commands & Tooling
- Run unit tests with `pytest tests/unit -q --tb=short`; invoking bare `pytest` boots integration containers and times out.
- Use `uv run ruff check --fix` instead of `flake8` (not installed in venv).

## Codebase Navigation
- API route schemas live in `app/schemas/v2/` (ignore deprecated `app/models/legacy/`).
- Database session fixture is defined in `tests/conftest.py:18-45`; do not instantiate raw SQLAlchemy engines in tests.

## Context Hygiene
- Never read `migrations/versions/*.py` or `package-lock.json` directly; check `app/db/schema.sql` for current tables.
```

### Mandatory Anti-Bloat Safeguards
1. **Hard Token Ceiling:** Cap the entire injected file at 600–1,000 tokens (default `800`). When adding a new skill exceeds the cap, evict the lowest-value active skill ranked by:
   $$\text{ROI Score} = \frac{\text{wasted\_tokens\_saved} \times \text{recency\_decay}}{\text{rule\_tokens}}$$
2. **Promotion Threshold:** Promote a `WasteFinding` to a persistent skill only if it occurred across $\ge 2$ sessions **OR** wasted $> 8{,}000$ tokens in a single session.
3. **Git-Diff Staleness Check:** Before every session, verify every path in `linked_paths_json` against `git diff --name-only <last_validated_commit>..HEAD`. Auto-retire skills referencing deleted or moved files.

---

## 7. Configuration & Watchdog Rules

Configuration file: `.loglode/config.toml` (overrides global `~/.loglode/config.toml`).

```toml
[adapter]
default_cli = "claude_code"         # "claude_code" | "codex"
injection_mode = "system_prompt"    # "system_prompt" | "managed_md_block"

[budget]
soft_alert_usd = 0.75               # terminal warning + desktop notification
hard_stop_usd = 2.00                # pauses or sends SIGINT unless --no-kill
max_single_turn_tokens = 25000      # flags runaway tool output immediately

[loops]
max_same_error_retries = 3          # fires alert on 3rd identical stderr fingerprint
max_same_file_reads = 4             # flags context amnesia / re-read loops
min_cache_hit_ratio = 0.50          # warns after turn 4 if prompt caching breaks

[distiller]
model = "claude-haiku-4-5"          # cheap synthesis model
max_skill_file_tokens = 800         # hard ceiling for .loglode/micro-skills.md
min_sessions_to_promote = 2
min_single_session_waste = 8000
```

---

## 8. CLI Contract

```text
loglode run [--cli claude|codex] [--no-inject] [--no-kill] [--budget <usd>] -- <agent args...>
    Wraps an interactive or headless agent session with telemetry, watchdog, and post-run mining.

loglode report [--last <n>] [--session <id>]
    Prints token breakdown (uncached, cache read/write, output), USD cost, and top waste findings.

loglode skills [list | edit | prune | reset]
    Inspects, validates git staleness, or resets .loglode/micro-skills.md for the current repo.

loglode mine [--window <n>] [--dry-run]
    Runs the deterministic waste miner and optional distiller on demand.

loglode eval --suite <tasks.yaml> --base-commit <sha>
    Runs the git worktree A/B benchmark comparing Baseline (--no-inject) vs Assisted runs.
```

---

## 9. Evaluation Harness & Success Metrics

### Primary Metric — Raw Token Reduction (Task $N+1$ vs. Baseline)
$$\Delta T_{\%} = \frac{T_{\text{baseline}} - T_{\text{assisted}}}{T_{\text{baseline}}} \times 100$$

### Secondary Metric — Cost-Weighted Effective Tokens
Accounts for prompt caching economics so injected context overhead is measured honestly:
$$T_{\text{eff}} = 1.0 \cdot T_{\text{in,uncached}} + 1.25 \cdot T_{\text{cache\_write}} + 0.10 \cdot T_{\text{cache\_read}} + 5.0 \cdot T_{\text{out}}$$
*(Multipliers are configurable per model in `config.toml`.)*

### Benchmark Protocol
1. Select a real mid-sized repository (50–300 files) and define a chronological sequence of 6–8 real tasks (bug fixes, small features, test additions) pinned to base commit `C0`.
2. **Control Arm (Baseline):** Run Tasks 1–8 in isolated git worktrees with `loglode run --no-inject`. Record $T_{\text{total}}$, $T_{\text{eff}}$, USD spend, wall-clock duration, and test suite pass/fail (`Pass@1`).
3. **Treatment Arm (Assisted):** Reset to `C0` and run Tasks 1–8 with mining + injection enabled. Task 1 runs cold (warm-up); Tasks 2–8 receive the evolving `.loglode/micro-skills.md`.
4. **Acceptance Gate:** Report $\Delta T_{\%}$ and $\Delta T_{\text{eff},\%}$ across Tasks 2–8 **only where `Pass@1` parity holds** against the control arm.

---

## 10. Repository Structure & Phased Build Plan

```text
loglode/
├── src/
│   ├── cli.ts                  # CLI entrypoint (`run`, `report`, `skills`, `mine`, `eval`)
│   ├── config.ts               # TOML config loader + defaults
│   ├── adapters/
│   │   ├── types.ts            # Unified Turn, ToolCall, ApiUsage interfaces
│   │   ├── claudeCode.ts       # stream-json parser + --append-system-prompt-file
│   │   └── codexCli.ts         # JSONL parser + managed AGENTS.md block
│   ├── proxy/
│   │   └── tokenProxy.ts       # Loopback HTTP/SSE proxy for exact token & cache usage
│   ├── store/
│   │   ├── db.ts               # SQLite connection, WAL setup, migrations
│   │   └── queries.ts          # Typed inserts & cross-session mining queries
│   ├── watchdog/
│   │   └── monitor.ts          # Live spend, loop, spike, and cache-drop circuit-breakers
│   ├── miner/
│   │   └── detectors.ts        # 5 deterministic waste detectors
│   ├── distiller/
│   │   ├── synthesize.ts       # Cheap LLM distiller prompt + JSON schema validator + ROI pruner
│   │   └── staleness.ts        # git-diff linked_paths invalidator
│   └── eval/
│       └── benchmark.ts        # Git worktree A/B runner + Markdown/CSV results table
├── config.default.toml
├── package.json
├── tsconfig.json
└── ARCHITECTURE.md
```

### Build Milestones (For Orchestrator Task Breakdown)

- **Milestone 1 — Telemetry & Watchdog MVP**
  - [ ] Scaffold TypeScript project, CLI parser, and TOML config loader.
  - [ ] Implement SQLite WAL store and schema migrations (`sessions`, `tool_calls`, `waste_findings`, `micro_skills`).
  - [ ] Build loopback HTTP/SSE proxy (`tokenProxy.ts`) capturing exact input/cache/output tokens without buffering streaming chunks.
  - [ ] Build Claude Code adapter (`claudeCode.ts`) parsing `stream-json` into normalised `ToolCall` rows.
  - [ ] Implement live `BudgetWatchdog` (soft USD alert, hard USD stop, retry loop detector, single-turn spike alert).
  - [ ] Implement `loglode report` CLI summary view.
- **Milestone 2 — Waste Mining & Micro-Skill Distillation**
  - [ ] Implement all 5 deterministic waste detectors (`repeat_read`, `fail_loop`, `search_thrash`, `log_flood`, `edit_oscillation`).
  - [ ] Implement git-diff staleness checker (`staleness.ts`).
  - [ ] Implement LLM distiller (`synthesize.ts`) with promotion thresholds, local token counting, and ROI eviction under the 800-token cap.
  - [ ] Wire `.loglode/micro-skills.md` rendering and pre-flight injection (`--append-system-prompt-file`).
- **Milestone 3 — Codex Adapter & Evaluation Proof**
  - [ ] Add Codex CLI adapter (`codexCli.ts`) with managed `AGENTS.md` block injection.
  - [ ] Implement `loglode eval` git-worktree A/B benchmark runner computing $\Delta T_{\%}$, $\Delta T_{\text{eff},\%}$, and `Pass@1` parity.
  - [ ] Run initial 6–8 task benchmark on a target repo and verify measurable token reduction on Tasks $N+1$.