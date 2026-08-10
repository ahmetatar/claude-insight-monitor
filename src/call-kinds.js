'use strict';

/**
 * One session id is not one conversation. Claude Code multiplexes the agent
 * loop, its subagents, and a fleet of short background calls onto the same id —
 * in a captured session here, better than a third of all requests were security
 * classifiers that never touch the conversation at all. Charting them together
 * makes the context window look like it collapses and refills; billing them
 * together hides what the background actually costs.
 *
 * Every signal used below is on the wire, not inferred from timing.
 */

/** Claude Code prepends its own billing header as the first system block: `cc_version=2.1.226.06d; cc_entrypoint=cli;`. */
const BILLING_HEADER = /^\s*x-anthropic-billing-header:\s*([^\n]*)/;

function systemText(request) {
  const system = request && request.system;
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map((b) => (typeof b === 'string' ? b : b && b.text) || '').join('\n');
}

/** The version and entrypoint Claude Code stamps on itself — `cli` for the terminal, `sdk-cli` for the Agent SDK. */
function parseBilling(text) {
  const match = text.match(BILLING_HEADER);
  if (!match) return { ccVersion: null, entrypoint: null };
  const fields = {};
  for (const part of match[1].split(';')) {
    const [k, v] = part.split('=').map((s) => s && s.trim());
    if (k && v) fields[k] = v;
  }
  return { ccVersion: fields.cc_version || null, entrypoint: fields.cc_entrypoint || null };
}

/** First line of the prompt proper — what identifies a call whose kind we don't recognise. */
function openingLine(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || BILLING_HEADER.test(trimmed)) continue;
    return trimmed.slice(0, 120);
  }
  return '';
}

function onlyUserText(messages) {
  if (!Array.isArray(messages) || messages.length !== 1) return null;
  const content = messages[0].content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.map((b) => (b && b.text) || '').join('');
}

/**
 * Ordered: the first match wins, so the specific shapes come before the general
 * ones. `group` decides how a call is charted — `main` is the conversation whose
 * context window the UI tracks, everything else runs beside it.
 */
const RULES = [
  {
    id: 'token-count',
    label: 'token count',
    group: 'meta',
    note: 'Claude Code sizing the window before it sends',
    test: (c) => c.endpointKind === 'count_tokens',
  },
  {
    id: 'probe',
    label: 'quota probe',
    group: 'meta',
    note: 'startup reachability and quota check',
    // A one-token request whose whole body is the word "quota": no system, no
    // tools, nothing to generate. It exists to see whether the key still works.
    test: (c) => c.maxTokens <= 1 || (c.singleUserText || '').trim() === 'quota',
  },
  {
    id: 'bash-security',
    label: 'bash security check',
    group: 'background',
    note: 'classifies a command before the Bash tool runs it',
    test: (c) => /^You are a security monitor for autonomous AI coding agents/m.test(c.system),
  },
  {
    id: 'title',
    label: 'session title',
    group: 'background',
    note: 'names the session for the resume list',
    test: (c) => /Generate a concise, sentence-case title/.test(c.system),
  },
  {
    id: 'compaction',
    label: 'compaction',
    group: 'background',
    note: 'summarises the conversation so it fits again',
    test: (c) => c.toolCount === 0 && /\bsummar(y|ise|ize)\b/i.test(c.system) && /conversation|transcript|session/i.test(c.system),
  },
  {
    id: 'subagent',
    label: 'subagent',
    group: 'subagent',
    note: 'a Task/Agent run with its own context window',
    test: (c) => Boolean(c.agentId),
  },
  {
    id: 'main',
    label: 'agent loop',
    group: 'main',
    note: 'the conversation you are having',
    test: (c) => c.toolCount > 0,
  },
  {
    id: 'utility',
    label: 'utility call',
    group: 'background',
    note: 'a short background call with no tools',
    test: () => true,
  },
];

const cache = new WeakMap();

function classify(turn) {
  if (!turn || !turn.request) return null;
  const cached = cache.get(turn);
  if (cached) return cached;

  const request = turn.request;
  const system = systemText(request).slice(0, 4000);
  const context = {
    system,
    endpointKind: (turn.endpoint && turn.endpoint.kind) || 'messages',
    agentId: turn.agentId,
    toolCount: (request.tools || []).length,
    maxTokens: Number(request.max_tokens || 0),
    singleUserText: onlyUserText(request.messages),
  };

  const rule = RULES.find((r) => r.test(context)) || RULES[RULES.length - 1];
  const billing = parseBilling(system);

  const result = {
    id: rule.id,
    label: rule.label,
    group: rule.group,
    note: rule.note,
    ccVersion: billing.ccVersion,
    entrypoint: billing.entrypoint,
    opening: openingLine(system),
    toolCount: context.toolCount,
  };
  cache.set(turn, result);
  return result;
}

module.exports = { classify, RULES };
