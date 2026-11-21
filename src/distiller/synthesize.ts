/**
 * Threshold-gated micro-skill distillation and store application.
 *
 * Architecture: `docs/architecture.md` §3 Stage 5 and §6 "Micro-Skill Artifact
 * Format & Anti-Bloat Controls". Three steps, deliberately separated so the
 * expensive/uncertain ones can be faked in tests:
 *
 * 1. {@link promotionGate} — the zero-LLM promotion threshold
 *    (§6 safeguard 2): a signature cluster earns a skill only when it spans
 *    `minSessionsToPromote` sessions **or** wasted more than
 *    `minSingleSessionWaste` tokens in a single session.
 * 2. {@link distillSkills} — one cheap-model call turning the promoted findings
 *    plus the current skill list into structured `SkillMutation`s. Every
 *    failure mode (no response, throw, malformed JSON, invalid mutation) is
 *    reported as a note and yields an empty mutation list, never an exception.
 * 3. {@link applyMutations} — deterministic, LLM-free validation/persistence
 *    under the hard token ceiling (§6 safeguard 1), evicting the lowest-ROI
 *    active skill until the file fits.
 *
 * `createAnthropicDistillerCall` is the production client; it is the only
 * network-touching code in the module and is intentionally untested here.
 */

import type { DistillerResponse, MicroSkillRecord, SkillMutation, SkillMutationOp, WasteFindingRecord } from '../adapters/types.js';
import type { DistillerConfig } from '../config.js';
import type { LoglodeDb } from '../store/db.js';
import {
  deactivateMicroSkill,
  insertMicroSkill,
  listActiveMicroSkills,
  listAllMicroSkills,
  updateMicroSkill,
} from '../store/queries.js';
import { estimateTokens } from '../tokenize.js';
import { parseLinkedPaths } from './staleness.js';

/** A deterministic local token estimate; injectable so tests can pin counts. */
export type TokenEstimator = (text: string) => number;

/** Skill keys are stable lowercase slugs (`test-runner-flags`, `cmd-pytest-flags`). */
const SKILL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const MUTATION_OPS: readonly SkillMutationOp[] = ['add', 'merge', 'tighten', 'retire'];

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Promotion gate (§6 safeguard 2)                                             */
/* -------------------------------------------------------------------------- */

export interface PromotionInput {
  findings: WasteFindingRecord[];
  config: DistillerConfig;
}

export interface PromotionResult {
  passed: WasteFindingRecord[];
  blocked: WasteFindingRecord[];
}

/**
 * Split findings into promoted and blocked signature clusters.
 *
 * A cluster (all findings sharing `signature`, regardless of pattern type)
 * passes when it appeared in at least `config.minSessionsToPromote` distinct
 * sessions OR when any single finding wasted more than
 * `config.minSingleSessionWaste` tokens on its own (strictly greater: exactly
 * 8,000 with the default 8,000 threshold is not enough).
 *
 * `passed` is ordered by the cluster's summed wasted tokens, descending, with
 * findings inside a cluster kept in input order; `blocked` keeps input order.
 */
export function promotionGate(input: PromotionInput): PromotionResult {
  const clusters = new Map<string, WasteFindingRecord[]>();
  for (const finding of input.findings) {
    const cluster = clusters.get(finding.signature);
    if (cluster === undefined) {
      clusters.set(finding.signature, [finding]);
    } else {
      cluster.push(finding);
    }
  }

  const promoted: { findings: WasteFindingRecord[]; wastedTokens: number }[] = [];
  const promotedSignatures = new Set<string>();

  for (const findings of clusters.values()) {
    const sessions = new Set(findings.map((finding) => finding.sessionId));
    const wastedTokens = findings.reduce((sum, finding) => sum + finding.wastedTokens, 0);
    const maxSingleSessionWaste = findings.reduce((max, finding) => Math.max(max, finding.wastedTokens), 0);
    const passes =
      sessions.size >= input.config.minSessionsToPromote ||
      maxSingleSessionWaste > input.config.minSingleSessionWaste;
    if (passes) {
      promoted.push({ findings, wastedTokens });
      promotedSignatures.add(findings[0]?.signature ?? '');
    }
  }

  // Sort is stable, so equal-waste clusters keep their first-seen order.
  promoted.sort((left, right) => right.wastedTokens - left.wastedTokens);

  return {
    passed: promoted.flatMap((cluster) => cluster.findings),
    blocked: input.findings.filter((finding) => !promotedSignatures.has(finding.signature)),
  };
}

/* -------------------------------------------------------------------------- */
/* Mutation validation (shared by the LLM path and the apply path)             */
/* -------------------------------------------------------------------------- */

type MutationValidation = { ok: true; mutation: SkillMutation } | { ok: false; reason: string };

function fail(reason: string): MutationValidation {
  return { ok: false, reason };
}

function isMutationOp(value: string): value is SkillMutationOp {
  return (MUTATION_OPS as readonly string[]).includes(value);
}

function singleLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * Normalize an LLM-supplied `linkedPaths` value into repo-relative forward-slash
 * paths, or `null` when the field is absent/unusable. Non-string members are
 * dropped rather than failing the whole mutation: a stray null must not throw
 * away an otherwise useful rule.
 */
function sanitizeLinkedPaths(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
    if (normalized !== '' && !paths.includes(normalized)) {
      paths.push(normalized);
    }
  }
  return paths;
}

/**
 * Validate one candidate mutation.
 *
 * Contract: `op` must be one of the four known values, `skillKey` a non-empty
 * lowercase slug, `add`/`tighten` need a non-empty `ruleText`, and `merge`
 * needs a `mergeIntoKey` that is a different slug. Anything else is rejected
 * with a human-readable reason so the caller can record a note.
 */
function validateMutation(entry: unknown): MutationValidation {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return fail('entry is not an object');
  }
  const record = entry as Record<string, unknown>;

  const op = record.op;
  if (typeof op !== 'string' || !isMutationOp(op)) {
    return fail(`unknown op ${JSON.stringify(op)}`);
  }

  const skillKey = typeof record.skillKey === 'string' ? record.skillKey.trim() : '';
  if (skillKey === '') {
    return fail('missing skillKey');
  }
  if (!SKILL_KEY_PATTERN.test(skillKey)) {
    return fail(`skillKey "${skillKey}" is not a lowercase slug`);
  }

  const mutation: SkillMutation = { op, skillKey };

  const ruleText = typeof record.ruleText === 'string' ? record.ruleText.trim() : '';
  if (op === 'add' || op === 'tighten') {
    if (ruleText === '') {
      return fail(`op "${op}" requires a non-empty ruleText`);
    }
    mutation.ruleText = ruleText;
  } else if (ruleText !== '') {
    // Allowed but ignored by the merge/retire paths; kept for logging.
    mutation.ruleText = ruleText;
  }

  if (op === 'merge') {
    const mergeIntoKey = typeof record.mergeIntoKey === 'string' ? record.mergeIntoKey.trim() : '';
    if (mergeIntoKey === '') {
      return fail('op "merge" requires mergeIntoKey');
    }
    if (!SKILL_KEY_PATTERN.test(mergeIntoKey)) {
      return fail(`mergeIntoKey "${mergeIntoKey}" is not a lowercase slug`);
    }
    if (mergeIntoKey === skillKey) {
      return fail('op "merge" cannot merge a skill into itself');
    }
    mutation.mergeIntoKey = mergeIntoKey;
  }

  const linkedPaths = sanitizeLinkedPaths(record.linkedPaths);
  if (linkedPaths !== null) {
    mutation.linkedPaths = linkedPaths;
  }

  if (typeof record.rationale === 'string' && record.rationale.trim() !== '') {
    mutation.rationale = record.rationale.trim();
  }

  return { ok: true, mutation };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function truncateForPrompt(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= maxChars ? single : `${single.slice(0, maxChars)}...`;
}

/* -------------------------------------------------------------------------- */
/* Distillation (single cheap-model call)                                      */
/* -------------------------------------------------------------------------- */

export interface DistillDeps {
  /** Injectable synthesis call. Return null (or throw) → distillation is skipped gracefully. */
  callLlm: (prompt: string) => Promise<DistillerResponse | null>;
  estimateTokens?: TokenEstimator;
  /**
   * Accepted for API symmetry with {@link applyMutations}; distillation output
   * does not depend on the wall clock, which keeps prompts and notes
   * byte-identical across runs (and therefore testable).
   */
  now?: () => Date;
}

export interface DistillInput {
  repoHash: string;
  findings: WasteFindingRecord[];
  activeSkills: MicroSkillRecord[];
  config: DistillerConfig;
}

export interface DistillResult {
  mutations: SkillMutation[];
  llmUsed: boolean;
  notes: string[];
}

/** Build the terse distiller prompt: constraints, promoted findings, active skills. */
function buildDistillPrompt(input: DistillInput, passed: WasteFindingRecord[], estimate: TokenEstimator): string {
  const lines: string[] = [
    `Repo: ${input.repoHash}`,
    "You are LogLode's micro-skill distiller. Turn recurring coding-agent waste into terse, imperative repo rules that the next session will be shown.",
    '',
    'Constraints:',
    `- The whole rendered skill file must stay under ${input.config.maxSkillFileTokens} tokens; prefer "tighten", "merge", or "retire" over "add".`,
    '- ruleText: 1-3 short imperative lines, repo-specific, no preamble, no headings.',
    '- skillKey and mergeIntoKey: lowercase slug matching ^[a-z0-9][a-z0-9-]*$ (prefix with "cmd-", "nav-", or another topic prefix).',
    '- linkedPaths: repo-relative paths with forward slashes that the rule depends on (used for the git-diff staleness check).',
    '- Propose a skill only when the evidence names a concrete path, command, or invariant.',
    '',
    'Reply with STRICT JSON only, no prose and no code fences, in this shape:',
    '{"mutations":[{"op":"add"|"merge"|"tighten"|"retire","skillKey":"<slug>","ruleText":"<rule>","linkedPaths":["<path>"],"mergeIntoKey":"<existing slug>","rationale":"<one line>"}]}',
    'op semantics: "add" = new skill; "tighten" = rewrite an existing skill; "merge" = absorb skillKey into mergeIntoKey; "retire" = drop a stale or low-value skill (skillKey only).',
    '',
    '## Promoted waste findings',
  ];

  for (const finding of passed) {
    lines.push(
      `- ${finding.patternType} | signature=${finding.signature} | session=${finding.sessionId} | occurrences=${finding.occurrences} | wastedTokens=${finding.wastedTokens} | evidence=${truncateForPrompt(finding.evidenceJson, 400)}`,
    );
  }

  lines.push('', '## Active skills (current file contents)');
  if (input.activeSkills.length === 0) {
    lines.push('- (none)');
  } else {
    for (const skill of input.activeSkills) {
      lines.push(
        `- ${skill.skillKey} (${estimate(skill.ruleText)} tokens, savings=${skill.estimatedSavings}, sessions=${skill.sourceSessions}): ${singleLine(skill.ruleText)}`,
      );
    }
  }

  lines.push('', 'Return the JSON object now.');
  return lines.join('\n');
}

/**
 * Promote findings, ask the injected LLM for mutations, and validate the answer.
 *
 * Never throws: a throwing/no-response call is reported with `llmUsed: false`,
 * an unparseable response with `llmUsed: true` and zero mutations, and invalid
 * mutation entries are dropped one by one with a note.
 */
export async function distillSkills(input: DistillInput, deps: DistillDeps): Promise<DistillResult> {
  const notes: string[] = [];
  const gate = promotionGate({ findings: input.findings, config: input.config });
  if (gate.passed.length === 0) {
    return {
      mutations: [],
      llmUsed: false,
      notes: ['no waste findings passed the promotion threshold; distillation skipped'],
    };
  }

  const estimate = deps.estimateTokens ?? estimateTokens;
  const prompt = buildDistillPrompt(input, gate.passed, estimate);

  let response: DistillerResponse | null;
  try {
    response = await deps.callLlm(prompt);
  } catch (error) {
    return {
      mutations: [],
      llmUsed: false,
      notes: [`distiller LLM call failed: ${describeError(error)}; distillation skipped`],
    };
  }

  if (response === null || response === undefined) {
    return {
      mutations: [],
      llmUsed: false,
      notes: ['distiller LLM returned no response; distillation skipped'],
    };
  }

  const rawMutations: unknown = (response as { mutations?: unknown }).mutations;
  if (!Array.isArray(rawMutations)) {
    return {
      mutations: [],
      llmUsed: true,
      notes: ['distiller LLM response is not a DistillerResponse: "mutations" must be an array'],
    };
  }

  const mutations: SkillMutation[] = [];
  for (let index = 0; index < rawMutations.length; index += 1) {
    const validation = validateMutation(rawMutations[index]);
    if (validation.ok) {
      mutations.push(validation.mutation);
    } else {
      notes.push(`dropped invalid mutation #${index + 1}: ${validation.reason}`);
    }
  }

  notes.unshift(
    `promotion gate passed ${gate.passed.length} finding(s); ${mutations.length} valid mutation(s) accepted from the distiller`,
  );

  return { mutations, llmUsed: true, notes };
}

/* -------------------------------------------------------------------------- */
/* ROI eviction + store application (§6 safeguard 1)                           */
/* -------------------------------------------------------------------------- */

/**
 * Recency decay for the ROI score: `1 / (1 + ageDays / 30)`, so a month-old
 * skill is worth half a fresh one. An unparseable/missing `updated_at` gets the
 * neutral 0.5 (unknown age must not beat or lose to a known-fresh skill), and
 * a future timestamp is clamped to age 0 so clock skew cannot inflate ROI.
 */
function recencyDecay(updatedAt: string | null, now: Date): number {
  if (updatedAt === null) {
    return 0.5;
  }
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) {
    return 0.5;
  }
  const ageDays = Math.max(0, (now.getTime() - parsed) / MILLIS_PER_DAY);
  return 1 / (1 + ageDays / 30);
}

/**
 * §6 safeguard 1: `ROI = wasted_tokens_saved * recency_decay / rule_tokens`,
 * with the token count floored at 1 so a zero-token rule cannot divide by zero.
 */
export function roiScore(skill: MicroSkillRecord, now: Date): number {
  const decay = recencyDecay(skill.updatedAt, now);
  return (skill.estimatedSavings * decay) / Math.max(1, skill.tokenCount);
}

/** Lowest ROI first; ties break toward the older skill (smaller id) for determinism. */
function lowestRoi(skills: MicroSkillRecord[], now: Date): MicroSkillRecord | undefined {
  let victim: MicroSkillRecord | undefined;
  let victimRoi = Number.POSITIVE_INFINITY;
  for (const skill of skills) {
    const roi = roiScore(skill, now);
    if (victim === undefined || roi < victimRoi) {
      victim = skill;
      victimRoi = roi;
      continue;
    }
    if (roi === victimRoi) {
      const victimId = victim.id ?? Number.MAX_SAFE_INTEGER;
      const skillId = skill.id ?? Number.MAX_SAFE_INTEGER;
      if (skillId < victimId) {
        victim = skill;
      }
    }
  }
  return victim;
}

/** Append the source rule's lines to the target's, dropping identical lines. */
function unionRuleText(target: string, source: string): string {
  const splitLines = (text: string): string[] =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  const lines = splitLines(target);
  for (const line of splitLines(source)) {
    if (!lines.includes(line)) {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

export interface ApplyOptions {
  config: DistillerConfig;
  headCommit?: string | null;
  now?: () => Date;
  /**
   * Additive extension of the published contract: the local token estimator is
   * injectable so tests can pin exact token counts instead of depending on the
   * 4-chars-per-token heuristic. Defaults to `src/tokenize.ts`'s
   * `estimateTokens`.
   */
  estimateTokens?: TokenEstimator;
}

export interface ApplyResult {
  applied: SkillMutation[];
  skipped: SkillMutation[];
  notes: string[];
  /** Resulting ACTIVE skills for the repo, ordered by id. */
  skills: MicroSkillRecord[];
}

/**
 * Validate and apply mutations to the store, keeping the active skill set under
 * `config.maxSkillFileTokens`.
 *
 * Purely deterministic — no LLM, no clock beyond `opts.now` — so it can be
 * re-run over a stored LLM response and unit-tested directly. Every mutation
 * either lands in `applied` or in `skipped` with a note explaining why; the
 * token ceiling is re-checked after each add/tighten/merge and enforced by
 * deactivating the lowest-ROI skill (§6 safeguard 1) until the set fits.
 */
export function applyMutations(
  db: LoglodeDb,
  repoHash: string,
  mutations: SkillMutation[],
  opts: ApplyOptions,
): ApplyResult {
  const now = (opts.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const estimate = opts.estimateTokens ?? estimateTokens;
  const headCommit = opts.headCommit ?? null;
  const ceiling = opts.config.maxSkillFileTokens;

  const applied: SkillMutation[] = [];
  const skipped: SkillMutation[] = [];
  const notes: string[] = [];

  /** Working copy of every skill row for this repo, keyed by `skill_key`. */
  const byKey = new Map<string, MicroSkillRecord>();
  for (const skill of listAllMicroSkills(db, repoHash)) {
    byKey.set(skill.skillKey, skill);
  }

  /** Keys created or rewritten by this batch: protected from its own evictions. */
  const batchOwned = new Set<string>();

  const activeSkills = (): MicroSkillRecord[] => {
    const active: MicroSkillRecord[] = [];
    for (const skill of byKey.values()) {
      if (skill.active === 1) {
        active.push(skill);
      }
    }
    return active;
  };

  const totalActiveTokens = (): number =>
    activeSkills().reduce((sum, skill) => sum + (Number.isFinite(skill.tokenCount) ? skill.tokenCount : 0), 0);

  /**
   * Deactivate the lowest-ROI active skills until the file fits.
   *
   * The skills this batch just wrote are excluded from the candidate pool (a
   * fresh `add` has `estimatedSavings = 0`, i.e. the lowest possible ROI, so it
   * would otherwise evict itself); when nothing else is left the just-written
   * skill may still be evicted, because the hard cap wins over a single skill.
   */
  const enforceCeiling = (justTouchedKey: string): void => {
    if (!Number.isFinite(ceiling)) {
      return;
    }
    while (totalActiveTokens() > ceiling) {
      const active = activeSkills();
      if (active.length === 0) {
        break;
      }

      let candidates = active.filter((skill) => !batchOwned.has(skill.skillKey));
      if (candidates.length === 0) {
        candidates = active;
      }
      if (candidates.length > 1) {
        const withoutTouched = candidates.filter((skill) => skill.skillKey !== justTouchedKey);
        if (withoutTouched.length > 0) {
          candidates = withoutTouched;
        }
      }

      const victim = lowestRoi(candidates, now);
      if (victim === undefined) {
        break;
      }

      deactivateMicroSkill(db, repoHash, victim.skillKey);
      victim.active = 0;
      notes.push(
        `evicted ${victim.skillKey} (${victim.tokenCount} tokens, ROI ${roiScore(victim, now).toFixed(3)}) to keep the skill file under ${ceiling} tokens`,
      );
    }

    const total = totalActiveTokens();
    if (total > ceiling) {
      notes.push(`token ceiling ${ceiling} still exceeded (${total} active tokens)`);
    }
  };

  const applyTighten = (mutation: SkillMutation): void => {
    const existing = byKey.get(mutation.skillKey);
    if (existing === undefined) {
      skipped.push(mutation);
      notes.push(`tighten ${mutation.skillKey}: unknown skill key; skipped`);
      return;
    }
    if (existing.id === null) {
      skipped.push(mutation);
      notes.push(`tighten ${mutation.skillKey}: stored skill has no id; skipped`);
      return;
    }

    const ruleText = mutation.ruleText ?? '';
    const updated: MicroSkillRecord = {
      ...existing,
      ruleText,
      tokenCount: estimate(ruleText),
      updatedAt: nowIso,
      active: 1,
    };
    updateMicroSkill(db, updated);
    byKey.set(updated.skillKey, updated);
    batchOwned.add(updated.skillKey);
    applied.push(mutation);

    notes.push(
      existing.active === 1
        ? `tighten ${updated.skillKey}: rule updated (${updated.tokenCount} tokens)`
        : `tighten ${updated.skillKey}: rule updated (${updated.tokenCount} tokens) and the retired skill was reactivated`,
    );
  };

  for (let index = 0; index < mutations.length; index += 1) {
    const candidate: unknown = mutations[index];
    const validation = validateMutation(candidate);
    if (!validation.ok) {
      // `skipped` is typed as SkillMutation[]; an unparseable entry is echoed
      // back as-is so the caller can see exactly what was rejected.
      skipped.push(candidate as SkillMutation);
      notes.push(`skipped mutation #${index + 1}: ${validation.reason}`);
      continue;
    }
    const mutation = validation.mutation;

    if (mutation.op === 'add') {
      const existing = byKey.get(mutation.skillKey);
      if (existing !== undefined) {
        notes.push(`add ${mutation.skillKey}: key already exists; applied as tighten`);
        applyTighten(mutation);
        enforceCeiling(mutation.skillKey);
        continue;
      }

      const ruleText = mutation.ruleText ?? '';
      const record: MicroSkillRecord = {
        id: null,
        repoHash,
        skillKey: mutation.skillKey,
        ruleText,
        tokenCount: estimate(ruleText),
        linkedPathsJson:
          mutation.linkedPaths !== undefined && mutation.linkedPaths.length > 0
            ? JSON.stringify(mutation.linkedPaths)
            : null,
        sourceSessions: 1,
        estimatedSavings: 0,
        lastValidatedCommit: headCommit,
        active: 1,
        updatedAt: nowIso,
      };
      const id = insertMicroSkill(db, record);
      const inserted: MicroSkillRecord = { ...record, id };
      byKey.set(inserted.skillKey, inserted);
      batchOwned.add(inserted.skillKey);
      applied.push(mutation);
      notes.push(
        `add ${inserted.skillKey}: inserted ${inserted.tokenCount} tokens (estimatedSavings defaults to 0; a mutation carries no savings figure)`,
      );
      enforceCeiling(inserted.skillKey);
      continue;
    }

    if (mutation.op === 'tighten') {
      applyTighten(mutation);
      enforceCeiling(mutation.skillKey);
      continue;
    }

    if (mutation.op === 'merge') {
      const source = byKey.get(mutation.skillKey);
      if (source === undefined) {
        skipped.push(mutation);
        notes.push(`merge ${mutation.skillKey}: unknown source skill key; skipped`);
        continue;
      }
      const mergeIntoKey = mutation.mergeIntoKey ?? '';
      const target = byKey.get(mergeIntoKey);
      if (target === undefined) {
        skipped.push(mutation);
        notes.push(`merge ${mutation.skillKey}: unknown merge target ${mergeIntoKey}; skipped`);
        continue;
      }
      if (source.active !== 1) {
        skipped.push(mutation);
        notes.push(`merge ${mutation.skillKey}: source skill is already retired; skipped`);
        continue;
      }
      if (target.id === null) {
        skipped.push(mutation);
        notes.push(`merge ${mutation.skillKey}: merge target ${mergeIntoKey} has no id; skipped`);
        continue;
      }

      const targetWasActive = target.active === 1;
      const ruleText = unionRuleText(target.ruleText, source.ruleText);
      const merged: MicroSkillRecord = {
        ...target,
        ruleText,
        tokenCount: estimate(ruleText),
        linkedPathsJson: (() => {
          const paths = parseLinkedPaths(target.linkedPathsJson);
          for (const path of parseLinkedPaths(source.linkedPathsJson)) {
            if (!paths.includes(path)) {
              paths.push(path);
            }
          }
          return paths.length === 0 ? null : JSON.stringify(paths);
        })(),
        sourceSessions: target.sourceSessions + source.sourceSessions,
        estimatedSavings: target.estimatedSavings + source.estimatedSavings,
        active: 1,
        updatedAt: nowIso,
      };
      updateMicroSkill(db, merged);
      deactivateMicroSkill(db, repoHash, source.skillKey);
      source.active = 0;
      byKey.set(merged.skillKey, merged);
      batchOwned.add(merged.skillKey);
      applied.push(mutation);
      notes.push(
        targetWasActive
          ? `merge ${source.skillKey} -> ${merged.skillKey}: rules merged (${merged.tokenCount} tokens), source retired`
          : `merge ${source.skillKey} -> ${merged.skillKey}: rules merged (${merged.tokenCount} tokens), source retired, target reactivated`,
      );
      enforceCeiling(merged.skillKey);
      continue;
    }

    // op === 'retire'
    const existing = byKey.get(mutation.skillKey);
    if (existing === undefined) {
      skipped.push(mutation);
      notes.push(`retire ${mutation.skillKey}: unknown skill key; skipped`);
      continue;
    }
    if (existing.active !== 1) {
      skipped.push(mutation);
      notes.push(`retire ${mutation.skillKey}: skill is already inactive; skipped`);
      continue;
    }
    deactivateMicroSkill(db, repoHash, existing.skillKey);
    existing.active = 0;
    applied.push(mutation);
    notes.push(`retire ${existing.skillKey}: deactivated`);
  }

  const skills = listActiveMicroSkills(db, repoHash)
    .filter((skill) => skill.active === 1)
    .sort((left, right) => (left.id ?? 0) - (right.id ?? 0));

  return { applied, skipped, notes, skills };
}

/* -------------------------------------------------------------------------- */
/* Production LLM client (Anthropic Messages API)                              */
/* -------------------------------------------------------------------------- */

function extractAssistantText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      return candidate.text;
    }
  }
  return null;
}

/**
 * Parse the model's text into a validated `DistillerResponse`.
 *
 * Tolerates a JSON block wrapped in a ```json fence (models do this even when
 * asked not to) and drops invalid mutations, reusing the same validation as
 * {@link distillSkills} so the store never sees a malformed mutation.
 */
function parseDistillerResponseText(text: string): DistillerResponse | null {
  const candidates: string[] = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  if (fenced !== null && typeof fenced[1] === 'string') {
    candidates.push(fenced[1].trim());
  }

  for (const candidate of candidates) {
    if (candidate === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      continue;
    }
    const mutations = (parsed as { mutations?: unknown }).mutations;
    if (!Array.isArray(mutations)) {
      continue;
    }
    const accepted: SkillMutation[] = [];
    for (const entry of mutations) {
      const validation = validateMutation(entry);
      if (validation.ok) {
        accepted.push(validation.mutation);
      }
    }
    return { mutations: accepted };
  }

  return null;
}

/**
 * Build a `callLlm` for the real distiller: one Anthropic Messages API request
 * per distillation, parsed into a `DistillerResponse`.
 *
 * Layout per the brief: `POST {baseUrl}/v1/messages` with `x-api-key`,
 * `anthropic-version: 2023-06-01`, `content-type: application/json`, and
 * `{ model, max_tokens, messages: [{ role: 'user', content: prompt }] }`.
 *
 * Any network error, non-2xx response, or unparseable body resolves to `null`
 * instead of throwing: distillation is an optimisation, and a provider outage
 * must never break a session. Not exercised by the unit tests (no network).
 */
export function createAnthropicDistillerCall(
  model: string,
  apiKey: string,
  opts: { baseUrl?: string; maxTokens?: number } = {},
): (prompt: string) => Promise<DistillerResponse | null> {
  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const maxTokens = opts.maxTokens ?? 1024;

  return async (prompt: string): Promise<DistillerResponse | null> => {
    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) {
        return null;
      }
      const payload: unknown = await response.json();
      const text = extractAssistantText(payload);
      if (text === null) {
        return null;
      }
      return parseDistillerResponseText(text);
    } catch {
      return null;
    }
  };
}
