'use strict';

const https = require('https');

const { computeBreakdown } = require('./breakdown');

/**
 * Exact section sizes, measured instead of estimated.
 *
 * Every token figure in the breakdown is `chars / 4`, because the API reports
 * usage in aggregate and never per section. `/v1/messages/count_tokens` will
 * answer exactly — but only for a whole request, so the sections have to be
 * isolated by measuring four requests and subtracting:
 *
 *   baseline  a minimal request: the fixed per-request overhead
 *   +tools    baseline plus the tool definitions
 *   +system   baseline plus the system prompt
 *   full      the real request
 *
 * tools = (+tools − baseline), system = (+system − baseline), and the messages
 * are whatever is left of the full count. Four calls rather than one per
 * section, which would be one call per message.
 *
 * This spends the user's quota, so nothing here runs on its own — it is only
 * ever reached from an explicit request to measure one turn.
 */

const UPSTREAM_HOST = 'api.anthropic.com';
const BASELINE_MESSAGES = [{ role: 'user', content: '.' }];

function post(body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: '/v1/messages/count_tokens',
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
            /* fall through to the error below */
          }
          if (res.statusCode !== 200 || !parsed || typeof parsed.input_tokens !== 'number') {
            const message = (parsed && parsed.error && parsed.error.message) || text.slice(0, 200) || 'no response body';
            reject(Object.assign(new Error(message), { status: res.statusCode }));
            return;
          }
          resolve(parsed.input_tokens);
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function measureTurn(turn, headers) {
  const request = turn && turn.request;
  if (!request || !request.model) throw new Error('this capture has no request body to measure');

  const model = request.model;
  const tools = Array.isArray(request.tools) && request.tools.length ? request.tools : null;
  const system = request.system || null;
  const messages = Array.isArray(request.messages) && request.messages.length ? request.messages : BASELINE_MESSAGES;

  const baseline = await post({ model, messages: BASELINE_MESSAGES }, headers);
  const withTools = tools ? await post({ model, messages: BASELINE_MESSAGES, tools }, headers) : baseline;
  const withSystem = system ? await post({ model, messages: BASELINE_MESSAGES, system }, headers) : baseline;
  const full = await post({ model, messages, ...(tools ? { tools } : {}), ...(system ? { system } : {}) }, headers);

  const toolTokens = withTools - baseline;
  const systemTokens = withSystem - baseline;
  /* Whatever the full request costs beyond the other three, with the baseline
     added back because subtracting tools and system removed it twice. */
  const messageTokens = Math.max(0, full - toolTokens - systemTokens - baseline);

  const estimate = computeBreakdown(request, null);
  const estimateBy = { system: 0, message: 0, tool: 0 };
  for (const section of estimate.sections) estimateBy[section.kind] += section.approxTokens;

  return {
    model,
    measuredAt: new Date().toISOString(),
    exact: { total: full, baseline, tools: toolTokens, system: systemTokens, messages: messageTokens },
    estimated: { total: estimate.totalApproxTokens, tools: estimateBy.tool, system: estimateBy.system, messages: estimateBy.message },
    /* How far off `chars / 4` was on this request — the number to read the rest
       of the estimates by, since they all share the same divisor. */
    ratio: estimate.totalApproxTokens > 0 ? full / estimate.totalApproxTokens : null,
    charsPerToken: full > 0 ? estimate.totalChars / full : null,
    calls: 2 + (tools ? 1 : 0) + (system ? 1 : 0),
  };
}

module.exports = { measureTurn };
