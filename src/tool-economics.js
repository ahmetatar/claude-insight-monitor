'use strict';

const { computeBreakdown, estimateTokens } = require('./breakdown');
const { computeCost } = require('./pricing');

/**
 * What the tool list costs, against what it is used for.
 *
 * Tool definitions render at the very front of the prompt, so every one of them
 * is re-sent on every turn for the whole session whether the model ever calls it
 * or not. A tool that is never called is not free and not harmless: it is a
 * fixed line item on every request, and — because it sits ahead of everything
 * else — adding or removing one invalidates the entire cache.
 *
 * The bill is attributed rather than assumed. Definitions are almost always
 * served from cache after the first turn, so charging them at full input price
 * would be wrong by an order of magnitude; instead each turn's real prompt spend
 * is split by the share of the prompt the definitions occupy.
 */

function definitionChars(tool) {
  return String(tool.description || '').length + JSON.stringify(tool.input_schema || {}).length;
}

function toolNames(turn) {
  return ((turn.request && turn.request.tools) || []).map((t) => t.name);
}

function contentBlocks(message) {
  const content = message && message.content;
  return Array.isArray(content) ? content : [];
}

function analyzeTools(turns) {
  const tools = new Map();
  const resultChars = new Map(); // tool_use_id -> chars, so a result is counted once
  const resultOwner = new Map(); // tool_use_id -> tool name
  const churn = [];
  let attributedCost = 0;
  let promptCost = 0;
  let lastNames = null;

  turns.forEach((turn, index) => {
    const definitions = (turn.request && turn.request.tools) || [];

    for (const tool of definitions) {
      const entry = tools.get(tool.name) || { name: tool.name, chars: 0, turnsPresent: 0, calls: 0, resultChars: 0 };
      entry.chars = definitionChars(tool);
      entry.turnsPresent += 1;
      tools.set(tool.name, entry);
    }

    // Adding or removing a tool moves every byte after it: worth naming the turn.
    if (definitions.length) {
      const names = toolNames(turn);
      if (lastNames) {
        const before = new Set(lastNames);
        const after = new Set(names);
        const added = names.filter((n) => !before.has(n));
        const removed = lastNames.filter((n) => !after.has(n));
        if (added.length || removed.length) churn.push({ turnIndex: index, added, removed });
      }
      lastNames = names;
    }

    for (const block of (turn.response && turn.response.content) || []) {
      if (block.type !== 'tool_use') continue;
      const entry = tools.get(block.name) || { name: block.name, chars: 0, turnsPresent: 0, calls: 0, resultChars: 0 };
      entry.calls += 1;
      tools.set(block.name, entry);
    }

    for (const message of (turn.request && turn.request.messages) || []) {
      for (const block of contentBlocks(message)) {
        if (block.type === 'tool_use' && block.id) resultOwner.set(block.id, block.name);
        if (block.type === 'tool_result' && block.tool_use_id && !resultChars.has(block.tool_use_id)) {
          resultChars.set(block.tool_use_id, JSON.stringify(block.content || '').length);
        }
      }
    }

    // Split this turn's real prompt spend by how much of the prompt is definitions.
    const cost = computeCost(turn.request && turn.request.model, turn.response && turn.response.usage);
    if (cost && definitions.length) {
      const breakdown = computeBreakdown(turn.request, null);
      const definitionTokens = estimateTokens(definitions.reduce((sum, t) => sum + definitionChars(t), 0));
      const total = breakdown.totalApproxTokens || 1;
      const prompt = cost.parts.input + cost.parts.cacheRead + cost.parts.cacheWrite;
      promptCost += prompt;
      attributedCost += prompt * Math.min(1, definitionTokens / total);
    } else if (cost) {
      promptCost += cost.parts.input + cost.parts.cacheRead + cost.parts.cacheWrite;
    }
  });

  for (const [id, chars] of resultChars) {
    const name = resultOwner.get(id);
    const entry = name && tools.get(name);
    if (entry) entry.resultChars += chars;
  }

  const rows = [...tools.values()]
    .map((entry) => ({
      name: entry.name,
      definitionTokens: estimateTokens(entry.chars),
      turnsPresent: entry.turnsPresent,
      calls: entry.calls,
      resultTokens: estimateTokens(entry.resultChars),
    }))
    .sort((a, b) => b.definitionTokens - a.definitionTokens);

  const definitionTokens = rows.reduce((sum, r) => sum + r.definitionTokens, 0);
  const unused = rows.filter((r) => r.calls === 0);

  return {
    tools: rows,
    churn,
    totals: {
      definitionTokens,
      unusedTokens: unused.reduce((sum, r) => sum + r.definitionTokens, 0),
      unusedCount: unused.length,
      calls: rows.reduce((sum, r) => sum + r.calls, 0),
      resultTokens: rows.reduce((sum, r) => sum + r.resultTokens, 0),
      attributedCost,
      promptCost,
    },
  };
}

module.exports = { analyzeTools };
