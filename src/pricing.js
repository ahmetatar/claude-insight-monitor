'use strict';

/**
 * List prices in USD per million tokens. Cached from Anthropic's published
 * pricing; the proxy never fetches it, so a new model simply falls through to
 * `null` and the UI shows no cost rather than a wrong one.
 */
const PRICES = [
  [/^claude-fable-5|^claude-mythos-5/, { input: 10, output: 50 }],
  [/^claude-opus-5|^claude-opus-4/, { input: 5, output: 25 }],
  [/^claude-sonnet-5|^claude-sonnet-4/, { input: 3, output: 15 }],
  [/^claude-haiku-4/, { input: 1, output: 5 }],
];

/**
 * Cache multipliers on the base input price. A write costs more than a plain
 * read of the same tokens — 1.25x for the 5-minute TTL, 2x for the hour — and
 * a hit costs a tenth. These three numbers are why a cache miss is expensive
 * and why the counterfactual below is worth showing.
 */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;

function ratesFor(model) {
  const id = String(model || '');
  for (const [pattern, rates] of PRICES) {
    if (pattern.test(id)) return rates;
  }
  return null;
}

/**
 * What this turn cost, and what it would have cost with no cache at all —
 * every cached token re-sent at full input price. The gap is the cache's
 * actual value on this turn, which is the only honest way to read a large
 * `cache_creation` number: a write is only wasteful if nothing reads it.
 */
function computeCost(model, usage) {
  const rates = ratesFor(model);
  if (!rates || !usage) return null;

  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const read = Number(usage.cache_read_input_tokens || 0);
  const writeTotal = Number(usage.cache_creation_input_tokens || 0);
  const write1h = Number(usage.cache_creation?.ephemeral_1h_input_tokens || 0);
  const write5m = Number(usage.cache_creation?.ephemeral_5m_input_tokens ?? (writeTotal - write1h));

  const perInput = rates.input / 1e6;
  const perOutput = rates.output / 1e6;

  const actual =
    input * perInput +
    read * perInput * CACHE_READ +
    write5m * perInput * CACHE_WRITE_5M +
    write1h * perInput * CACHE_WRITE_1H +
    output * perOutput;

  const withoutCache = (input + read + writeTotal) * perInput + output * perOutput;

  return {
    rates,
    actual,
    withoutCache,
    saved: withoutCache - actual,
    // Negative when this turn wrote more than it read — normal on the first
    // turn of a conversation, a warning sign on the twentieth.
    savedPct: withoutCache > 0 ? (withoutCache - actual) / withoutCache : 0,
    parts: {
      input: input * perInput,
      cacheRead: read * perInput * CACHE_READ,
      cacheWrite: write5m * perInput * CACHE_WRITE_5M + write1h * perInput * CACHE_WRITE_1H,
      output: output * perOutput,
    },
  };
}

module.exports = { ratesFor, computeCost, CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_READ };
