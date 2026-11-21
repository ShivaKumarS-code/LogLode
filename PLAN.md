# LogLode — Build Plan

Spec: `docs/architecture.md` (read in full by the orchestrator before writing this plan).
This plan splits the build into independent pieces delegated to subagents per the protocol in
`AGENTS.md`. The orchestrator reviews every diff, runs the full build/tests itself, and is the
only one who commits.

## Toolchain decisions (binding for all pieces)

- **Runtime:** Node.js 24 (v24.21.0 verified), TypeScript, ESM (`"type": "module"`).
- **Zero runtime npm dependencies.** Dev deps only: `typescript`, `tsx`, `@types/node`.
  No piece may add a dependency; request one via `DONE_WITH_CONCERNS` instead.
- **SQLite:** built-in `node:sqlite` (`DatabaseSync`), WAL mode via PRAGMA. No native modules.
- **Build:** `npm run build` → `tsc -p tsconfig.json` → `dist/`.
- **Per-piece proof while other pieces are in flight** (avoid typechecking half-written files
  owned by other subagents):
  - Typecheck: `npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck --types node <your .ts files>`
  - Tests: `node --import tsx --test <your .test.ts files>`
- **Full build + full test suite is run by the orchestrator between waves only.**
- **Imports:** relative imports use explicit `.js` extensions (NodeNext convention).
- **Git:** shell out to the `git` CLI. **LLM/network calls:** never in unit tests — inject them.
- **Environment:** Windows + PowerShell. Use `node:path`; repo-relative paths are normalized
  to forward slashes; global state dir = `os.homedir()/.loglode`.
- **Shared types:** `src/adapters/types.ts` is owned by Piece A in wave 1 and by the
  orchestrator afterwards. No other piece edits it; report needed changes as
  `DONE_WITH_CONCERNS` and work around the gap locally.
- **Only the orchestrator commits.** Subagents leave the working tree dirty.
- Every subagent report ends with a status line `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT |
  BLOCKED` plus the real output of the commands it ran.

## Pieces, waves, and architecture sections touched

| Piece | Wave | Files owned (exclusive) | Architecture sections (headings) |
|---|---|---|---|
| A Scaffold | 1 | `package.json`, `tsconfig.json`, `.gitignore`, `config.default.toml`, `src/adapters/types.ts`, `src/config.ts`, `src/repo.ts`, `src/cost.ts`, `src/tokenize.ts`, `src/testing/tmp.ts`, `src/types/node-sqlite.d.ts` (only if needed), own `*.test.ts` | "Core Modules & Responsibilities" (§2), "Configuration & Watchdog Rules" (§7), "CLI Contract" (§8), "Repository Structure & Phased Build Plan" (§10) |
| B Store | 2 | `src/store/db.ts`, `src/store/queries.ts`, own `*.test.ts` | "Data Schema (SQLite — WAL Mode)" (§4) verbatim |
| C Token proxy | 2 | `src/proxy/tokenProxy.ts`, own `*.test.ts` | §2 "Loopback HTTP Proxy" row, "Stage 2: Dual-Layer Telemetry Capture" |
| D Claude adapter | 2 | `src/adapters/claudeCode.ts`, own `*.test.ts` | §2 "CLI Adapters" + "Context Injector" rows, "Stage 1: Pre-Flight Validation & Injection" |
| E Watchdog | 2 | `src/watchdog/monitor.ts`, own `*.test.ts` | "Stage 3: Live Watchdog Evaluation", "Configuration & Watchdog Rules" (§7 `[budget]`/`[loops]`) |
| H Codex adapter | 2 | `src/adapters/codexCli.ts`, own `*.test.ts` | §2 "CLI Adapters" + "Context Injector" rows (managed `AGENTS.md` block) |
| F Miner | 3 | `src/miner/detectors.ts`, own `*.test.ts` | "Deterministic Waste Mining Heuristics (Zero-LLM Layer)" (§5), "Stage 4: Deterministic Waste Mining" |
| G Distiller | 3 | `src/distiller/synthesize.ts`, `src/distiller/staleness.ts`, `src/skills/render.ts`, own `*.test.ts` | "Stage 5: Micro-Skill Distillation & Pruning", "Micro-Skill Artifact Format & Anti-Bloat Controls" (§6), §6 safeguard 3 (staleness), Stage 1 step 3 |
| I Eval harness | 3 | `src/eval/benchmark.ts`, own `*.test.ts` | "Evaluation Harness & Success Metrics" (§9), §8 `loglode eval` row |
| J CLI + pipeline | 4 | `src/cli.ts`, `src/run/pipeline.ts`, test fixtures, own `*.test.ts` | "Runtime Execution Pipeline" (§3 all stages), "CLI Contract" (§8) |

## Wave structure and dependency protocol

- **Wave 1:** A alone — every later piece compiles against its types/config/helpers.
  Gate: orchestrator runs full `npm run build` + `npm test` green, then commits.
- **Wave 2 (parallel):** B, C, D, E, H — depend only on Piece A output. No two pieces share a
  file. Each proves its own scope with the per-piece commands above.
- **Wave 3 (parallel):** F, G, I — depend on A + B (store API). G also uses A's
  `estimateTokens`/cost helpers.
- **Wave 4:** J — integration wiring of every module behind the §8 CLI contract, with an
  end-to-end test using a fixture agent script (no real Claude/Codex CLI required).
- **After each wave:** the orchestrator reads the actual diff of each piece, runs the full
  build and test suite itself, fixes via new briefs to the owning piece on failure (one-line
  fixes excepted), and commits.
- Failure briefs quote the exact compiler/test error and name the owning piece only.

## Accepted extensions beyond the spec's file tree

- `src/repo.ts` (repo root + `repo_hash`), `src/cost.ts` (USD estimate + `T_eff`),
  `src/tokenize.ts` (deterministic local token estimate proxy), `src/skills/render.ts`
  (micro-skills.md rendering), `src/run/pipeline.ts` (session wiring), `src/testing/tmp.ts`
  (test helpers), `scripts/run-tests.mjs` (fallback test discovery, only if needed).
- Optional `[metrics]` config table for `T_eff` multipliers (§9 notes they are configurable).
- Root `ARCHITECTURE.md` from the spec tree is intentionally omitted;
  `docs/architecture.md` stays canonical (AGENTS.md links it).

## Known-unverifiable at completion (report honestly)

- A live §9 benchmark (real 50–300 file repo, 6–8 tasks, measured ΔT%) — harness built and
  tested against fakes only.
- Live Claude Code / Codex CLI compatibility — adapters are parser-driven and tested with
  fixtures; those CLIs are not installed here.
