'use strict';

const { computeBreakdown, estimateTokens } = require('./breakdown');
const { computeCost } = require('./pricing');

/**
 * The session as a set of threads rather than a list of turns.
 *
 * A subagent is a whole conversation of its own — its own context window, its
 * own tool set, its own bill — that exists to hand a few hundred tokens back to
 * the conversation that spawned it. Read turn by turn that is invisible: the
 * subagent's turns are interleaved with everything else, and its cost lands in
 * the session total with nothing to attribute it to.
 *
 * Threads are grouped from the `x-claude-code-agent-id` header, which is fact.
 * Which tool call spawned which thread is inferred from ordering, and is
 * reported as an inference.
 */

/* Tools that start a nested conversation. A subagent's turns appear between one
   of these being called and its result coming back. */
const SPAWNING_TOOLS = /^(Agent|Task|dispatch_agent|Workflow)$/i;

function timeOf(turn) {
  const value = (turn.timing && turn.timing.startedAt) || turn.timestamp;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function contextTokens(turn) {
  const usage = (turn.response && turn.response.usage) || {};
  return (
    Number(usage.input_tokens || 0) +
    Number(usage.cache_read_input_tokens || 0) +
    Number(usage.cache_creation_input_tokens || 0)
  );
}

function contentBlocks(message) {
  const content = message && message.content;
  return Array.isArray(content) ? content : [];
}

/** Every spawning tool call the conversation made, with when it happened. */
function spawnCalls(turns) {
  const calls = [];
  turns.forEach((turn, index) => {
    if (turn.agentId) return;
    for (const block of (turn.response && turn.response.content) || []) {
      if (block.type !== 'tool_use' || !SPAWNING_TOOLS.test(block.name || '')) continue;
      calls.push({ id: block.id, name: block.name, turnIndex: index, at: timeOf(turn) });
    }
  });
  return calls;
}

/** What a tool call handed back, wherever it later appears in the history. */
function resultSizes(turns) {
  const sizes = new Map();
  for (const turn of turns) {
    for (const message of (turn.request && turn.request.messages) || []) {
      for (const block of contentBlocks(message)) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        if (sizes.has(block.tool_use_id)) continue;
        sizes.set(block.tool_use_id, estimateTokens(JSON.stringify(block.content || '').length));
      }
    }
  }
  return sizes;
}

function analyzeTopology(turns) {
  const threads = new Map();

  turns.forEach((turn, index) => {
    const id = turn.agentId || 'main';
    let thread = threads.get(id);
    if (!thread) {
      thread = {
        id,
        kind: turn.agentId ? 'subagent' : 'conversation',
        turnIndexes: [],
        models: new Set(),
        toolCount: 0,
        peakContextTokens: 0,
        billedTokens: 0,
        outputTokens: 0,
        cost: 0,
        firstAt: null,
        lastAt: null,
      };
      threads.set(id, thread);
    }

    thread.turnIndexes.push(index);
    if (turn.request && turn.request.model) thread.models.add(turn.request.model);
    thread.toolCount = Math.max(thread.toolCount, ((turn.request && turn.request.tools) || []).length);
    thread.peakContextTokens = Math.max(thread.peakContextTokens, contextTokens(turn));
    thread.billedTokens += contextTokens(turn);
    thread.outputTokens += Number((turn.response && turn.response.usage && turn.response.usage.output_tokens) || 0);

    const cost = computeCost(turn.request && turn.request.model, turn.response && turn.response.usage);
    if (cost) thread.cost += cost.actual;

    const at = timeOf(turn);
    if (at != null) {
      if (thread.firstAt == null || at < thread.firstAt) thread.firstAt = at;
      if (thread.lastAt == null || at > thread.lastAt) thread.lastAt = at;
    }
  });

  const calls = spawnCalls(turns);
  const sizes = resultSizes(turns);

  const rows = [...threads.values()].map((thread) => {
    let spawn = null;
    if (thread.kind === 'subagent' && thread.firstAt != null) {
      /* The closest spawning call that had already been made when this thread
         started. Ordering, not causation — hence "inferred" on the way out. */
      const candidates = calls.filter((call) => call.at != null && call.at <= thread.firstAt);
      const chosen = candidates[candidates.length - 1] || null;
      if (chosen) {
        spawn = {
          toolName: chosen.name,
          turnIndex: chosen.turnIndex,
          toolUseId: chosen.id,
          reportTokens: sizes.has(chosen.id) ? sizes.get(chosen.id) : null,
          inferred: true,
        };
      }
    }

    const first = turns[thread.turnIndexes[0]];
    return {
      id: thread.id,
      kind: thread.kind,
      turns: thread.turnIndexes.length,
      firstTurnIndex: thread.turnIndexes[0],
      lastTurnIndex: thread.turnIndexes[thread.turnIndexes.length - 1],
      models: [...thread.models],
      toolCount: thread.toolCount,
      peakContextTokens: thread.peakContextTokens,
      /* What the thread was carrying at its widest, from the request body — the
         usage numbers only exist for turns the API answered. */
      peakPromptTokens: first ? computeBreakdown(first.request, null).totalApproxTokens : 0,
      billedTokens: thread.billedTokens,
      outputTokens: thread.outputTokens,
      cost: thread.cost,
      firstAt: thread.firstAt,
      lastAt: thread.lastAt,
      durationMs: thread.firstAt != null && thread.lastAt != null ? thread.lastAt - thread.firstAt : null,
      spawn,
    };
  });

  rows.sort((a, b) => a.firstTurnIndex - b.firstTurnIndex);

  const subagents = rows.filter((r) => r.kind === 'subagent');
  return {
    threads: rows,
    totals: {
      threads: rows.length,
      subagents: subagents.length,
      subagentCost: subagents.reduce((sum, r) => sum + r.cost, 0),
      totalCost: rows.reduce((sum, r) => sum + r.cost, 0),
      reportedTokens: subagents.reduce((sum, r) => sum + ((r.spawn && r.spawn.reportTokens) || 0), 0),
      subagentBilledTokens: subagents.reduce((sum, r) => sum + r.billedTokens, 0),
    },
  };
}

module.exports = { analyzeTopology };
