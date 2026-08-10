'use strict';

const { estimateTokens } = require('./breakdown');

/**
 * The thinking layer.
 *
 * Thinking is billed as output but is not the answer, so a turn's output token
 * count says nothing about how much of it the user ever sees. It is also the one
 * part of the response whose text does not come back: on current models the
 * blocks arrive with an empty `thinking` string and a long opaque signature, and
 * it is the signature — not the reasoning — that gets replayed into every
 * subsequent request for the rest of the conversation.
 */

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

function contentBlocks(message) {
  const content = message && message.content;
  return Array.isArray(content) ? content : [];
}

/**
 * How the request asked for thinking. Captures recorded before the proxy kept
 * these fields simply have nothing to report, which is different from a request
 * that asked for nothing.
 */
function requestedConfig(request) {
  if (!request) return null;
  const thinking = request.thinking ?? null;
  const outputConfig = request.output_config ?? null;
  const effort = (outputConfig && outputConfig.effort) ?? request.effort ?? null;
  if (thinking === undefined && !outputConfig && !effort) return null;
  return {
    thinking,
    effort: typeof effort === 'object' && effort ? effort.type || null : effort,
    taskBudget: (outputConfig && outputConfig.task_budget) || null,
    // Present in schema 2 captures only; absent means "not recorded", not "off".
    recorded: 'thinking' in request || 'output_config' in request,
  };
}

function analyzeThinking(turn) {
  const request = turn && turn.request;
  const response = turn && turn.response;
  const usage = (response && response.usage) || {};

  const blocks = [];
  for (const block of (response && response.content) || []) {
    if (!THINKING_TYPES.has(block.type)) continue;
    blocks.push({
      kind: block.type,
      textChars: String(block.thinking || '').length,
      signatureChars: String(block.signature || '').length,
    });
  }

  /* What the signature replay costs. Every thinking block the model produced is
     sent back on every later turn, and the signature is the whole of it — bytes
     nobody can read, occupying the cached prefix for the rest of the session. */
  let signatureChars = 0;
  let echoed = 0;
  for (const message of (request && request.messages) || []) {
    for (const block of contentBlocks(message)) {
      if (!THINKING_TYPES.has(block.type)) continue;
      echoed += 1;
      signatureChars += String(block.signature || '').length;
    }
  }

  const thinkingTokens = Number(usage.output_tokens_details?.thinking_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens || 0);

  const hasText = blocks.some((b) => b.textChars > 0);
  const hasSignature = blocks.some((b) => b.signatureChars > 0);

  return {
    thinkingTokens,
    outputTokens,
    ratio: outputTokens > 0 ? thinkingTokens / outputTokens : 0,
    blocks,
    /* Only claim a display mode when a block actually came back: with no blocks
       at all the turn simply did not think, which is not the same as the text
       being withheld. */
    display: blocks.length === 0 ? null : hasText ? 'summarized' : 'omitted',
    signaturesPresent: hasSignature,
    echoedBlocks: echoed,
    echoedSignatureTokens: estimateTokens(signatureChars),
    /* The order of block types in the response: on interleaved thinking this is
       where you see the model thinking between tool calls rather than only once
       up front. */
    shape: ((response && response.content) || []).map((b) => b.type),
    config: requestedConfig(request),
  };
}

module.exports = { analyzeThinking };
