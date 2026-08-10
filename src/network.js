'use strict';

/**
 * The exchange as a network event rather than a prompt.
 *
 * How long the model took to say anything, how fast it spoke once it started,
 * whether the SDK quietly retried first, and how much quota the account has
 * left — none of which is in the request or the response body. It lives in the
 * timing of the stream and in headers the client never shows you.
 */

const RATE_LIMIT_PREFIX = 'anthropic-ratelimit-';
const FIELDS = new Set(['limit', 'remaining', 'reset', 'status']);

/**
 * Turns `anthropic-ratelimit-input-tokens-remaining: 39000` into a row per
 * resource. Parsed by shape rather than from a fixed list, so a limit type that
 * did not exist when this was written still shows up.
 */
function parseRateLimits(headers) {
  const rows = new Map();
  for (const [key, value] of Object.entries(headers || {})) {
    const name = key.toLowerCase();
    if (!name.startsWith(RATE_LIMIT_PREFIX)) continue;
    const rest = name.slice(RATE_LIMIT_PREFIX.length);
    const lastDash = rest.lastIndexOf('-');
    const field = lastDash === -1 ? rest : rest.slice(lastDash + 1);
    if (!FIELDS.has(field)) continue;
    const resource = lastDash === -1 ? rest : rest.slice(0, lastDash);
    const row = rows.get(resource) || { resource };
    row[field] = value;
    rows.set(resource, row);
  }

  return [...rows.values()].map((row) => {
    const limit = Number(row.limit);
    const remaining = Number(row.remaining);
    return {
      ...row,
      used: Number.isFinite(limit) && Number.isFinite(remaining) ? limit - remaining : null,
      share: Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0 ? remaining / limit : null,
    };
  });
}

function analyzeNetwork(turn) {
  const timing = turn && turn.timing;
  const headers = (turn && turn.response && turn.response.headers) || {};
  const client = (turn && turn.client) || {};

  const ttfbMs = timing && timing.ttfbMs != null ? timing.ttfbMs : null;
  const durationMs = timing && timing.durationMs != null ? timing.durationMs : null;
  /* Everything after the first byte: the part the model spent generating, as
     opposed to the wait before it began. Mixing the two makes a slow queue look
     like a slow model. */
  const streamMs = ttfbMs != null && durationMs != null ? Math.max(0, durationMs - ttfbMs) : null;

  const outputTokens = Number((turn && turn.response && turn.response.usage && turn.response.usage.output_tokens) || 0);
  const tokensPerSecond = streamMs && streamMs > 0 && outputTokens ? outputTokens / (streamMs / 1000) : null;

  const status = turn && turn.status;
  const error = (turn && turn.response && turn.response.error) || null;

  return {
    recorded: Boolean(timing),
    ttfbMs,
    durationMs,
    streamMs,
    tokensPerSecond,
    bytes: (turn && turn.bytes) || null,
    /* Non-zero means the SDK already failed this request at least once and
       retried without telling anyone. */
    retryCount: client.retryCount != null ? client.retryCount : null,
    status,
    error,
    requestId: headers['request-id'] || null,
    retryAfter: headers['retry-after'] || null,
    rateLimits: parseRateLimits(headers),
  };
}

module.exports = { analyzeNetwork, parseRateLimits };
