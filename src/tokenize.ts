/**
 * Deterministic, dependency-free token estimate.
 *
 * LogLode needs token counts for tool output (telemetry, watchdog spikes) and for
 * micro-skill budget enforcement, but it must not ship or call a real tokenizer:
 * running one per streamed tool result would be slow, platform-specific, and a
 * runtime dependency. Instead we use a deliberately coarse approximation of
 * ~4 characters per token. It is stable across machines and cheap enough to call
 * on every chunk, which is what the budgets and heuristics actually need. It is
 * NOT a substitute for provider-reported usage, which is the source of truth for
 * billing.
 */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}
