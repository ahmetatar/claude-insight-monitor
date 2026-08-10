'use strict';

const https = require('https');

const { computeBreakdown } = require('./breakdown');
const { computeCost } = require('./pricing');

/**
 * Re-running a captured turn with something changed.
 *
 * Every other layer measures what happened. This one answers what would have
 * happened instead — the question the tool-economics layer raises and cannot
 * settle: 58 of these 59 tools were never called, so would the turn have gone
 * the same way without them? Reading a capture cannot tell you. Sending the
 * request again, minus the tools, can.
 *
 * It sends a real request and spends real quota, so like exact counting it only
 * ever runs from an explicit action, and the reply is never written to the
 * capture store — a replay is an experiment, not something the session did.
 */

const UPSTREAM_HOST = 'api.anthropic.com';

/* A replay exists to be compared, not to produce work, so its output is bounded
   regardless of what the original asked for. */
const MAX_OUTPUT_TOKENS = 4096;

function send(body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'anthropic-version': '2023-06-01',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* handled below */
          }
          if (!parsed) {
            reject(Object.assign(new Error(text.slice(0, 200) || 'no response body'), { status: res.statusCode }));
            return;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * The captured request with the asked-for changes applied. Everything not named
 * in `changes` is sent exactly as it was captured — a replay that quietly
 * normalised the history would answer a different question than the one asked.
 */
function buildRequest(turn, changes, usedToolNames) {
  const original = turn.request;
  const body = {
    model: changes.model || original.model,
    max_tokens: Math.min(Number(original.max_tokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
    messages: original.messages,
  };

  if (changes.system !== 'drop' && original.system != null) body.system = original.system;

  if (changes.tools !== 'none' && Array.isArray(original.tools)) {
    const tools =
      changes.tools === 'used' ? original.tools.filter((tool) => usedToolNames.has(tool.name)) : original.tools;
    if (tools.length) body.tools = tools;
  }

  /* Sampling and thinking configuration ride along when the capture has them:
     replaying at a different effort would be a different experiment. */
  for (const field of ['thinking', 'output_config', 'tool_choice', 'stop_sequences', 'temperature', 'top_p', 'top_k']) {
    if (original[field] != null) body[field] = original[field];
  }

  return body;
}

/** Tool names the model actually called anywhere in this session. */
function calledTools(turns) {
  const names = new Set();
  for (const turn of turns) {
    for (const block of (turn.response && turn.response.content) || []) {
      if (block.type === 'tool_use' && block.name) names.add(block.name);
    }
  }
  return names;
}

function summarise(request, response) {
  const breakdown = computeBreakdown(request, null);
  const usage = (response && response.usage) || null;
  const content = (response && response.content) || [];
  return {
    model: request.model,
    toolCount: (request.tools || []).length,
    hasSystem: request.system != null,
    promptTokensEstimate: breakdown.totalApproxTokens,
    usage,
    cost: computeCost(request.model, usage),
    stopReason: (response && response.stop_reason) || null,
    /* The block order says as much as the text: whether it still reached for a
       tool is usually the whole answer. */
    shape: content.map((b) => b.type),
    toolCalls: content.filter((b) => b.type === 'tool_use').map((b) => b.name),
    text: content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n'),
  };
}

async function replayTurn(turn, changes, turns, headers) {
  if (!turn || !turn.request || !turn.request.model) throw new Error('this capture has no request body to replay');

  const body = buildRequest(turn, changes, calledTools(turns));
  const { status, body: response } = await send(body, headers);
  if (status !== 200) {
    const message = (response.error && response.error.message) || `HTTP ${status}`;
    throw Object.assign(new Error(message), { status });
  }

  return {
    replayedAt: new Date().toISOString(),
    changes,
    maxOutputTokens: body.max_tokens,
    original: summarise(turn.request, turn.response),
    replay: summarise(body, response),
  };
}

module.exports = { replayTurn, buildRequest, calledTools };
