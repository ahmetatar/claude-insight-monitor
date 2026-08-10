'use strict';

const { estimateTokens } = require('./breakdown');
const { computeCost } = require('./pricing');

const TTL_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 };

/** djb2. Only ever compared against another hash of the same function. */
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

/* The cache matches on content bytes; `cache_control` is a marker *about* the
   content, not part of it. Hashing it would make the rolling breakpoint look
   like a content change on every single turn — the block it moves off of and
   the block it moves onto would both read as edited. */
function canonical(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'cache_control' in value) {
    const { cache_control, ...rest } = value;
    return JSON.stringify(rest) || '';
  }
  return JSON.stringify(value) || '';
}

function ttlOf(block) {
  const cc = block && block.cache_control;
  if (!cc) return null;
  return cc.ttl || '5m';
}

/**
 * The request flattened into the units the cache actually matches on, in the
 * order the API renders them: tools, then system, then messages. A prefix hit
 * survives only up to the first unit whose bytes changed, so this list — not
 * the request object — is what a cache diff has to compare.
 */
function prefixUnits(request) {
  const units = [];
  const push = (kind, label, value, block) => {
    const text = canonical(value);
    units.push({ kind, label, chars: text.length, hash: hash(text), ttl: ttlOf(block) });
  };

  for (const tool of request.tools || []) {
    push('tool', `tool: ${tool.name || '(unnamed)'}`, { d: tool.description, s: tool.input_schema }, tool);
  }

  const system = request.system;
  if (typeof system === 'string') push('system', 'system prompt', system, null);
  else if (Array.isArray(system)) system.forEach((b, i) => push('system', `system[${i}]`, b.text ?? b, b));

  (request.messages || []).forEach((msg, i) => {
    if (Array.isArray(msg.content)) {
      msg.content.forEach((b, j) => {
        const type = (b && b.type) || 'block';
        push('message', `message[${i}].${type}[${j}] (${msg.role})`, b, b);
      });
    } else {
      push('message', `message[${i}] (${msg.role})`, msg.content, null);
    }
  });

  return units;
}

const unitCache = new WeakMap();
function unitsFor(turn) {
  if (!turn || !turn.request) return [];
  let units = unitCache.get(turn);
  if (!units) {
    units = prefixUnits(turn.request);
    unitCache.set(turn, units);
  }
  return units;
}

/**
 * Claude Code multiplexes unrelated conversations onto one session id — the
 * agent loop, subagents, and short utility calls with their own tiny prefixes.
 * Diffing a security-check call against the previous agent turn would report a
 * total cache miss on every turn, so each chain is compared only against itself.
 */
function chainKey(turn) {
  const tools = (turn.request && turn.request.tools) || [];
  const names = tools.map((t) => t.name).join(',');
  return [turn.agentId || '-', turn.request && turn.request.model, tools.length, hash(names)].join('|');
}

/** Index of the last unit carrying a cache_control marker — the end of what was actually cached. */
function lastBreakpointIndex(units) {
  for (let i = units.length - 1; i >= 0; i--) if (units[i].ttl) return i;
  return -1;
}

/** The first unit whose bytes differ from the previous turn's — the point where the cache stopped being reusable. */
function findDivergence(prev, cur) {
  const overlap = Math.min(prev.length, cur.length);
  for (let i = 0; i < overlap; i++) {
    if (prev[i].hash !== cur[i].hash) {
      return { index: i, unit: cur[i], previous: prev[i], reason: 'changed' };
    }
  }
  // A shorter prefix than last time means units were removed, not appended —
  // the signature of context editing dropping tool results from the history.
  if (prev.length > cur.length) {
    return { index: cur.length, unit: null, previous: prev[cur.length], reason: 'removed' };
  }
  return null;
}

function usageParts(usage) {
  const u = usage || {};
  const writeTotal = Number(u.cache_creation_input_tokens || 0);
  const write1h = Number(u.cache_creation?.ephemeral_1h_input_tokens || 0);
  return {
    input: Number(u.input_tokens || 0),
    output: Number(u.output_tokens || 0),
    read: Number(u.cache_read_input_tokens || 0),
    write: writeTotal,
    write1h,
    write5m: Number(u.cache_creation?.ephemeral_5m_input_tokens ?? (writeTotal - write1h)),
  };
}

function timeOf(turn) {
  const t = (turn.timing && turn.timing.startedAt) || turn.timestamp;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * One session id can carry several conversations at once — Claude Code opens
 * side threads that share the model and the whole tool set, so the immediately
 * preceding turn is often from a different thread entirely. The server matches
 * whatever prefix it holds, so we do the same: among recent turns of this chain,
 * the real predecessor is the one sharing the longest prefix.
 */
const CANDIDATE_DEPTH = 8;

function pickPredecessor(units, candidates) {
  const list = Array.isArray(candidates) ? candidates : candidates ? [candidates] : [];
  let best = null;
  let bestShared = -1;
  for (const candidate of list.slice(-CANDIDATE_DEPTH)) {
    const other = unitsFor(candidate);
    const divergence = findDivergence(other, units);
    const shared = divergence ? divergence.index : Math.min(other.length, units.length);
    if (shared > bestShared) {
      bestShared = shared;
      best = candidate;
    }
  }
  return best;
}

/**
 * Why this turn's cache behaved the way it did.
 *
 * The usage numbers say what happened — tokens read, tokens rewritten — but not
 * why, and "why" is the actionable half: a rewrite caused by a changed system
 * block is a bug you can fix, one caused by an expired TTL is not.
 */
function analyzeTurn(turn, candidates) {
  const units = unitsFor(turn);
  const prev = pickPredecessor(units, candidates);
  const usage = usageParts(turn.response && turn.response.usage);

  const breakpoints = [];
  let cumulativeChars = 0;
  units.forEach((u, i) => {
    cumulativeChars += u.chars;
    if (u.ttl) breakpoints.push({ index: i, kind: u.kind, label: u.label, ttl: u.ttl, approxTokensUpTo: estimateTokens(cumulativeChars) });
  });

  const ttls = new Set(breakpoints.map((b) => b.ttl));
  const ttl = ttls.size === 1 ? [...ttls][0] : ttls.size > 1 ? 'mixed' : null;

  const prevUnits = prev ? unitsFor(prev) : [];
  const divergence = prev ? findDivergence(prevUnits, units) : null;
  /* Only a divergence inside the region the previous turn had cached costs
     anything. Past the last breakpoint the bytes were never cached, so a
     changed tail — the new user turn, a fresh tool result — is the normal
     shape of a conversation, not a miss. */
  const cachedThrough = lastBreakpointIndex(prevUnits);
  const invalidating = Boolean(divergence) && divergence.index <= cachedThrough;
  const elapsedMs = prev && timeOf(turn) && timeOf(prev) ? timeOf(turn) - timeOf(prev) : null;

  let tokensBeforeDivergence = null;
  if (divergence) {
    let chars = 0;
    for (let i = 0; i < divergence.index; i++) chars += units[i].chars;
    tokensBeforeDivergence = estimateTokens(chars);
  }

  let verdict;
  if (!prev) verdict = usage.read > 0 ? 'hit' : 'cold';
  else if (usage.read === 0) verdict = 'miss';
  else if (invalidating) verdict = 'partial';
  else verdict = 'hit';

  // Attribution, in the order the evidence is trustworthy: a byte-level
  // divergence is proof, an expired TTL is inference, everything else is
  // eviction we cannot see from here.
  let cause = null;
  if (verdict === 'miss' || verdict === 'partial') {
    const ttlWindow = TTL_MS[ttl] || TTL_MS['5m'];
    if (invalidating) {
      let lostChars = 0;
      for (let i = divergence.index; i <= cachedThrough && i < prevUnits.length; i++) lostChars += prevUnits[i].chars;
      cause = {
        type: 'prefix-drift',
        unit: divergence.unit ? divergence.unit.label : divergence.previous && divergence.previous.label,
        reason: divergence.reason,
        tokensInvalidated: estimateTokens(lostChars),
      };
    } else if (elapsedMs != null && elapsedMs > ttlWindow) {
      cause = { type: 'ttl-expiry', idleMs: elapsedMs, ttl: ttl || '5m' };
    } else {
      cause = { type: 'unknown' };
    }
  }

  return {
    chainKey: chainKey(turn),
    verdict,
    cause,
    ttl,
    breakpoints,
    unitCount: units.length,
    /* Measured over the same units as the breakpoints above. The breakdown's own
       total counts slightly different bytes, and mixing the two made a fully
       cached prefix read as larger than the prompt containing it. */
    approxTokens: estimateTokens(cumulativeChars),
    cachedThrough,
    divergence: divergence
      ? {
          index: divergence.index,
          reason: divergence.reason,
          invalidating,
          label: divergence.unit ? divergence.unit.label : divergence.previous.label,
          kind: divergence.unit ? divergence.unit.kind : divergence.previous.kind,
          tokensBefore: tokensBeforeDivergence,
        }
      : null,
    elapsedMs,
    usage,
    cost: computeCost(turn.request && turn.request.model, turn.response && turn.response.usage),
  };
}

/**
 * Walks a session in order, comparing every turn with the previous turn of its
 * own chain, and returns one analysis per turn.
 */
function analyzeSession(turns) {
  return walkChains(turns, (turn, prev) => analyzeTurn(turn, prev));
}

/** The predecessor a turn's cache was matched against, for callers outside this module. */
function predecessorOf(turn, candidates) {
  return pickPredecessor(unitsFor(turn), candidates);
}

/**
 * Walks a session in order, handing each turn the predecessor of its own chain.
 * Everything that compares a turn with what came before it — cache diffing,
 * history diffing — has to agree on which turn that was, so they share one walk.
 */
function walkChains(turns, visit) {
  const byChain = new Map();
  return turns.map((turn, index) => {
    const key = chainKey(turn);
    const history = byChain.get(key) || [];
    const result = visit(turn, predecessorOf(turn, history), index);
    history.push(turn);
    if (history.length > CANDIDATE_DEPTH) history.shift();
    byChain.set(key, history);
    return result;
  });
}

module.exports = { analyzeTurn, analyzeSession, walkChains, predecessorOf, chainKey, prefixUnits, CANDIDATE_DEPTH };
