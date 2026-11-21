# LogLode

Local-first telemetry and micro-skill mining for coding agents.

LogLode wraps a [`claude`](https://docs.anthropic.com/en/docs/claude-code) or [`codex`](https://github.com/openai/codex) CLI session, measures the *exact* tokens the agent burns (input, cache read, cache write, output), watches the session against a budget in real time, and — after the run — mines the trajectory for recurring waste. Recurring waste is distilled into a small, versioned file of repo-specific rules (`.loglode/micro-skills.md`) that is injected into the next session.

Everything is stored locally in SQLite. Nothing leaves your machine except the agent's own provider calls and one optional, explicitly enabled distillation call.

```
  agent CLI ──► loopback proxy ──► provider
      │                │
      └── stream-json / JSONL events
                       │
             ┌─────────▼──────────┐
             │  SQLite trajectory │  sessions · tool_calls · waste_findings · micro_skills
             └─────────┬──────────┘
                       │  deterministic miner (no LLM)
             ┌─────────▼──────────┐
             │ micro-skills.md    │  injected into the next session
             └────────────────────┘
```

## Why

Coding agents waste a large share of their context on the same mistakes: re-reading the same file, retrying an identical failing command, grepping blindly, dumping a lockfile into context. Those habits repeat *per repository* and are invisible in aggregate token dashboards.

LogLode turns them into a measured, repo-specific loop: capture exact usage → detect recurring waste → distil a terse rule → inject it next time — without sending your code or prompts to another service.

## Features

- **Exact token accounting** through a loopback HTTP proxy (`127.0.0.1:0`) that tees provider SSE/JSON without altering it — uncached input, cache-read, cache-write and output tokens are read off the wire, not estimated from the CLI stream.
- **Live budget watchdog** — soft/hard USD caps, repeated-error and re-read loop circuit breakers, single-turn output spikes, prompt-cache collapse; a hard stop sends `SIGINT` unless `--no-kill`.
- **Five deterministic waste detectors** (`repeat_read`, `fail_loop`, `search_thrash`, `log_flood`, `edit_oscillation`) that run purely on SQLite data, cross-session, with stable deduplication signatures.
- **Cheap-model distillation** behind a promotion gate (≥ 2 sessions or > 8,000 wasted tokens in one session), with a hard token ceiling and ROI-based eviction — entirely optional and off unless `ANTHROPIC_API_KEY` is set.
- **Git-diff staleness checks**: rules that point at deleted or renamed files are auto-retired before they are injected again.
- **Convergent re-mining**: findings are re-detected from scratch for the rolling window and replaced, so repeated runs never duplicate the store.
- **Transparent passthrough**: the agent's stdout/stderr are streamed to your terminal exactly as the CLI produced them.
- **A/B eval harness**: baseline (`--no-inject`) vs assisted runs in isolated git worktrees, reporting ΔT%, cost-weighted ΔT_eff%, and Pass@1 parity.
- **Zero runtime dependencies**. The store uses Node's built-in `node:sqlite`; the only dev dependencies are TypeScript, `tsx`, and `@types/node`.

## Requirements

- **Node.js 24+** (`engines: >= 24`) — the store uses the built-in `node:sqlite` module.
- **git** on `PATH` (repo identity, staleness checks, eval worktrees).
- A supported agent CLI on `PATH` for real sessions: `claude` (Claude Code) or `codex` (Codex CLI). The test suite needs neither — it drives fixture agents.

## Install (from source)

```bash
git clone https://github.com/ShivaKumarS-code/LogLode.git
cd LogLode
npm install
npm run build
```

Run it directly:

```bash
node dist/cli.js --help
```

or put `loglode` on your `PATH`:

```bash
npm link          # exposes the bin entry (./dist/cli.js)
loglode --version
```

## Quick start

```bash
# Wrap an agent session in the current repo (arguments after `--` go to the agent)
loglode run -- -p "fix the failing test in src/app.test.ts"

# What did this repo's sessions cost?
loglode report

# Mine the last 10 sessions without persisting anything
loglode mine --dry-run

# Inspect / hand-edit the generated rules file
loglode skills list
loglode skills edit
```

The first run also creates the local state directory (`~/.loglode/repos/<repo-hash>/state.db`, WAL mode).

## Commands

```
loglode run [--cli claude|codex] [--no-inject] [--no-kill] [--budget <usd>] -- <agent args...>
loglode report [--last <n>] [--session <id>]
loglode skills [list | edit | prune | reset]
loglode mine [--window <n>] [--dry-run]
loglode eval --suite <tasks.yaml> [--base-commit <sha>] [--csv <path>] [--test-cmd <command>]
loglode --help | --version
```

Exit codes: `0` success, `1` runtime failure (not a git repo, git failure on the critical path, failed session), `2` usage error (bad flags, missing arguments, unparseable task suite).

### `loglode run`

Wraps one agent session with telemetry, watchdog, and post-run mining. Everything after `--` is passed to the agent **verbatim**; LogLode adds only what it needs for structured output:

- Claude Code: `--output-format stream-json --verbose`, plus `--append-system-prompt-file .loglode/micro-skills.md` when skills exist.
- Codex: `--json`, plus a managed block inside `AGENTS.md` when skills exist.

| Flag | Meaning |
| --- | --- |
| `--cli claude\|codex` | Which agent to launch (default: `[adapter] default_cli`, `claude_code`). |
| `--no-inject` | Baseline run: no skills are injected and `skill_version_id` is stored as `NULL`. |
| `--no-kill` | Record a hard budget breach, but never `SIGINT` the child. |
| `--budget <usd>` | Overrides `hard_stop_usd`; the soft alert becomes `budget * 0.5`. |

Examples:

```bash
# Claude Code headless, $3 hard ceiling
loglode run --budget 3 -- -p "add a regression test for the parser"

# Codex CLI
loglode run --cli codex -- exec "add a regression test for the parser"

# Measure the baseline cost first, then compare against an assisted run
loglode run --no-inject -- -p "add a regression test for the parser"
```

On completion it prints one summary line (`session <id> <status> — in <n> / out <m> tokens, $<usd>`), with distiller notes and watchdog breaches on stderr.

### `loglode report`

Prints the last sessions (default 10) as an aligned table — 8-character id, CLI, status, input/cache-read/cache-write/output tokens, estimated USD, start time — followed by the repository's top 5 waste findings by wasted tokens.

```bash
loglode report --last 20
loglode report --session 4f0c1a2e-...
```

`--session` prints one session in detail (tokens, cost, timestamps, injected skill version, git head) plus its own waste findings.

### `loglode skills`

| Subcommand | Effect |
| --- | --- |
| `list` (default) | Table of every rule: key, tokens, active, estimated savings, linked-path count. |
| `edit` | Prints the absolute path of `.loglode/micro-skills.md`, creating it from the active skills if missing, plus a hint. |
| `prune` | Runs the git-diff staleness check (retires deleted/renamed links), then enforces the token ceiling by evicting the lowest-ROI rules and re-renders the file. |
| `reset` | Deactivates every rule for the repository and rewrites the artifact empty. |

### `loglode mine`

Re-runs the deterministic detectors on demand for the last `--window` sessions (default 10) and prints per-session findings plus a total. Without `--dry-run`, the window's previous findings are replaced by the fresh detection output (idempotent re-mining). If `ANTHROPIC_API_KEY` is set, it also runs the distillation step and re-renders the skills file.

```bash
loglode mine
loglode mine --window 20
loglode mine --dry-run          # prints findings, never touches the store
```

### `loglode eval`

Runs the git-worktree A/B benchmark from a YAML task suite:

```yaml
# tasks.yaml — flat list of name/prompt items
- name: fix-login-bug
  prompt: |
    The login form rejects valid passwords. Fix it and run the tests.
- name: add-regression-test
  prompt: Add a regression test for the password validator.
```

```bash
loglode eval --suite tasks.yaml --test-cmd "npm test"
loglode eval --suite tasks.yaml --base-commit a91c4e2 --csv results.csv
```

The control arm runs `--no-inject`; the treatment arm is the normal path. Each task runs in its own worktree pinned to the base commit (defaults to `HEAD`); `--test-cmd` provides Pass@1 (exit 0 = pass, non-zero = fail, spawn error = unknown). Results are printed as Markdown and optionally written as CSV.

## How it works

### Pipeline

Each `loglode run` executes five stages:

1. **Pre-flight** — resolve `HEAD`, load active rules, verify every rule's linked paths against `git diff --name-status <last_validated_commit>..HEAD`, auto-retire rules whose paths were deleted or renamed, then render and version `.loglode/micro-skills.md`.
2. **Telemetry** — bind the loopback proxy on an ephemeral port, point the child's `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` at it, stream and persist tool calls as the structured CLI events arrive, and forward all child output unchanged.
3. **Watchdog** — after every usage frame and tool result: spend caps, identical-error repeats, repeated reads without an intervening edit, single-turn output spikes, and cache-hit collapse. A hard spend breach sends `SIGINT` (unless `--no-kill`).
4. **Mining** — on exit, run the five detectors over the rolling 10-session window; replace the window sessions' stored findings with the fresh set.
5. **Distillation** — only with an API key: promote findings above the threshold, ask a cheap model for structured `add`/`merge`/`tighten`/`retire` mutations, validate and apply them under the token ceiling (ROI eviction), and re-render the artifact for the next session.

### Waste detectors

| Pattern | Detects | Distilled rule |
| --- | --- | --- |
| `repeat_read` | The same file read ≥ 3 times without an intervening edit (or in ≥ 3 consecutive sessions). | Where the relevant code lives, so it need not be re-read. |
| `fail_loop` | The same command/error fingerprint failing ≥ 2 times. | The invocation that actually works. |
| `search_thrash` | ≥ 4 consecutive low-output greps/globs with no follow-up edit. | Repo layout / naming notes. |
| `log_flood` | A single tool result above 4,000 tokens (lockfiles, build dumps). | Scoped flags and ignore rules. |
| `edit_oscillation` | The same file edited ≥ 3 times with interleaved failures. | The invariant the code must satisfy. |

Findings carry a cross-session deduplication `signature`, and re-running mining replaces rather than appends the window's rows.

### The micro-skills artifact

`.loglode/micro-skills.md` is git-ignored by default (teams may commit it). It is a versioned, budget-capped Markdown file that is injected into a static prompt position so later turns can hit the provider's prompt cache:

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
- Run unit tests with `pytest tests/unit -q --tb=short`; bare `pytest` boots integration containers and times out.

## Codebase Navigation
- API route schemas live in `app/schemas/v2/` (ignore deprecated `app/models/legacy/`).

## Context Hygiene
- Never read `migrations/versions/*.py` or `package-lock.json` directly; check `app/db/schema.sql` for current tables.
```

Rules are keyed by slug (`cmd-*` → *Commands & Tooling*, `nav-*` → *Codebase Navigation*, everything else → *Context Hygiene*), and the whole file is held under `max_skill_file_tokens` (800 by default).

## Configuration

Defaults are built into `src/config.ts`. To override them, copy the relevant tables from [`config.default.toml`](config.default.toml) into:

- `~/.loglode/config.toml` — global, or
- `.loglode/config.toml` — per repository (wins over the global file).

```toml
[adapter]
default_cli = "claude_code"         # "claude_code" | "codex"
injection_mode = "system_prompt"    # "system_prompt" | "managed_md_block"

[budget]
soft_alert_usd = 0.75               # terminal warning (and notify line)
hard_stop_usd = 2.00                # SIGINT unless --no-kill
max_single_turn_tokens = 25000      # flags runaway tool output

[loops]
max_same_error_retries = 3          # alert on the 3rd identical stderr fingerprint
max_same_file_reads = 4             # reads of one path without an intervening edit
min_cache_hit_ratio = 0.50          # warns after turn 4 if prompt caching breaks

[distiller]
model = "claude-haiku-4-5"          # cheap synthesis model
max_skill_file_tokens = 800         # hard ceiling for .loglode/micro-skills.md
min_sessions_to_promote = 2
min_single_session_waste = 8000
```

`config.default.toml` is a reference copy; it is not loaded automatically.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables post-run distillation (one call to the configured cheap model). Without it, mining and injection still work and the distiller is skipped with a note. |
| `LOGLODE_HOME` | Home directory used as the state root; state lives in `$LOGLODE_HOME/.loglode/…` (default: `~`). |
| `LOGLODE_CLAUDE_BIN` | Launch command for Claude Code (default: `claude`). |
| `LOGLODE_CODEX_BIN` | Launch command for Codex (default: `codex`). |

## Repository layout

```
src/
├── cli.ts                  # entrypoint: run / report / skills / mine / eval
├── config.ts               # TOML-subset loader + typed defaults
├── repo.ts                 # repo root + stable repo_hash
├── cost.ts                 # USD estimates + T_eff (cost-weighted tokens)
├── tokenize.ts             # deterministic local token estimate
├── adapters/
│   ├── types.ts            # shared record/event contracts
│   ├── claudeCode.ts       # stream-json parser + spawn spec
│   └── codexCli.ts         # JSONL parser + managed AGENTS.md block
├── proxy/tokenProxy.ts     # loopback HTTP/SSE forwarder with usage capture
├── store/                  # SQLite (WAL) connection + typed queries
├── watchdog/monitor.ts     # live budget / loop / spike / cache rules
├── miner/detectors.ts      # five zero-LLM waste detectors
├── distiller/              # promotion gate, LLM synthesis, staleness, ROI eviction
├── skills/render.ts        # micro-skills.md renderer + version bump
├── run/pipeline.ts         # five-stage session wiring
├── eval/benchmark.ts       # git-worktree A/B benchmark + reports
└── testing/                # temp-dir helpers and fixture agents
docs/architecture.md        # system design and rationale (canonical spec)
config.default.toml         # reference configuration
```

State: `~/.loglode/repos/<repo_hash>/state.db` — `repo_hash` is an 8-hex SHA-256 prefix of the normalised `origin` URL (falling back to the absolute repo path), so the same repository keeps one trajectory store across clones.

## Development

```bash
npm run build       # tsc -p tsconfig.json -> dist/
npm run typecheck   # tsc --noEmit
npm test            # node --import tsx --test "src/**/*.test.ts"
```

Tests are hermetic: temp git repos, temp state directories, and fixture agents (`src/testing/fixtures/fake-claude.mjs`, `fake-codex.mjs`) that emit realistic `stream-json`/JSONL through a local fake provider. No network access and no real agent CLI are required.

The design and the reasoning behind each module live in [`docs/architecture.md`](docs/architecture.md).

## Platform notes & limitations

- **Windows `.cmd` shims.** npm installs `claude`/`codex` as `.cmd` wrappers, which `child_process.spawn` cannot execute without a shell (Node returns `ENOENT`/`EINVAL`). Point LogLode at a directly executable entry point instead:

  ```bat
  set LOGLODE_CLAUDE_BIN=node
  loglode run -- "C:\Users\you\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js" -p "fix the bug"
  ```

  A missing executable produces a clear error plus this hint.
- **Live agent compatibility is parser-driven.** The Claude Code and Codex adapters are tested against fixtures, not against installed CLIs; CLI output formats move between releases.
- **The eval harness is verified with fakes.** Running a real benchmark needs an agent CLI and a task suite; the committed tests inject a fake `runTask`.
- **Pricing is approximate.** USD figures come from a small default price table in `src/cost.ts` (per-model, per-million tokens) and are estimates, not invoices.
