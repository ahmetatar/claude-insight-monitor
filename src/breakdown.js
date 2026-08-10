'use strict';

/** Rough token estimate; Anthropic doesn't expose per-section token counts, only the aggregate `usage` block. */
function estimateTokens(chars) {
  return Math.round(chars / 4);
}

function charLen(value) {
  if (value == null) return 0;
  return typeof value === 'string' ? value.length : JSON.stringify(value).length;
}

/**
 * Builds a section-by-section size estimate for a request body, plus the real
 * usage numbers reported by the API response (when available).
 */
function computeBreakdown(requestBody, responseUsage) {
  const sections = [];

  if (requestBody && requestBody.system != null) {
    const chars = charLen(requestBody.system);
    sections.push({ label: 'system prompt', kind: 'system', chars, approxTokens: estimateTokens(chars) });
  }

  if (Array.isArray(requestBody && requestBody.messages)) {
    requestBody.messages.forEach((msg, i) => {
      const chars = charLen(msg.content);
      sections.push({
        label: `message[${i}] (${msg.role})`,
        kind: 'message',
        index: i,
        chars,
        approxTokens: estimateTokens(chars),
      });
    });
  }

  if (Array.isArray(requestBody && requestBody.tools)) {
    requestBody.tools.forEach((tool, i) => {
      const chars = charLen(tool.description) + charLen(tool.input_schema);
      sections.push({
        label: `tool: ${tool.name || '(unnamed)'}`,
        kind: 'tool',
        index: i,
        chars,
        approxTokens: estimateTokens(chars),
      });
    });
  }

  const totalChars = sections.reduce((sum, s) => sum + s.chars, 0);

  const usage = responseUsage
    ? {
        input_tokens: responseUsage.input_tokens ?? null,
        output_tokens: responseUsage.output_tokens ?? null,
        cache_creation_input_tokens: responseUsage.cache_creation_input_tokens ?? null,
        cache_read_input_tokens: responseUsage.cache_read_input_tokens ?? null,
      }
    : null;

  return { sections, totalChars, totalApproxTokens: estimateTokens(totalChars), usage };
}

module.exports = { computeBreakdown, estimateTokens };
