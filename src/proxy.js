'use strict';

const https = require('https');

const UPSTREAM_HOST = 'api.anthropic.com';

/**
 * Headers Claude Code sends that must never be forwarded onward or persisted to disk.
 * accept-encoding is stripped so the upstream response comes back uncompressed — otherwise
 * we'd be tee-ing gzipped bytes into the SSE/JSON parser used for capture.
 */
const HOP_BY_HOP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function buildForwardHeaders(reqHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Incrementally parses an Anthropic Messages SSE stream to reconstruct the
 * final response body (content blocks + usage) without buffering/blocking
 * the pass-through to the real client.
 */
function createSseAccumulator() {
  let buffer = '';
  const content = [];
  let stopReason = null;
  let usage = {};
  let model = null;

  function feed(chunk) {
    buffer += chunk;
    const events = buffer.split('\n\n');
    buffer = events.pop(); // last piece may be incomplete
    for (const evt of events) {
      const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let payload;
      try {
        payload = JSON.parse(dataLine.slice('data:'.length).trim());
      } catch {
        continue;
      }
      switch (payload.type) {
        case 'message_start':
          model = payload.message?.model ?? model;
          usage = { ...usage, ...(payload.message?.usage || {}) };
          break;
        case 'content_block_start':
          content[payload.index] = payload.content_block?.type === 'tool_use'
            ? { ...payload.content_block, input: '' }
            : { ...payload.content_block };
          break;
        case 'content_block_delta':
          if (content[payload.index]) {
            if (payload.delta?.type === 'text_delta') {
              content[payload.index].text = (content[payload.index].text || '') + payload.delta.text;
            } else if (payload.delta?.type === 'input_json_delta') {
              content[payload.index].input = (content[payload.index].input || '') + payload.delta.partial_json;
            }
          }
          break;
        case 'message_delta':
          stopReason = payload.delta?.stop_reason ?? stopReason;
          usage = { ...usage, ...(payload.usage || {}) };
          break;
        default:
          break;
      }
    }
  }

  function finalize() {
    return {
      model,
      content: content.filter(Boolean),
      stop_reason: stopReason,
      usage,
    };
  }

  return { feed, finalize };
}

/** Non-streaming responses arrive as a single JSON body instead of SSE. */
function parseJsonResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Forwards req to the real Anthropic API, pipes the response back to res
 * untouched, and calls onCapture(turn) once the exchange completes.
 */
async function handleProxyRequest(req, res, { onCapture }) {
  const rawBody = await readBody(req);
  let requestBody = null;
  try {
    requestBody = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // non-JSON body; forward as-is, skip capture parsing
  }

  const headers = buildForwardHeaders(req.headers);
  headers['content-length'] = Buffer.byteLength(rawBody);

  const upstreamReq = https.request(
    {
      hostname: UPSTREAM_HOST,
      port: 443,
      path: req.url,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);

      const isSse = String(upstreamRes.headers['content-type'] || '').includes('text/event-stream');
      const sse = isSse ? createSseAccumulator() : null;
      const rawChunks = isSse ? null : [];

      upstreamRes.on('data', (chunk) => {
        res.write(chunk);
        if (sse) sse.feed(chunk.toString('utf8'));
        else rawChunks.push(chunk);
      });

      upstreamRes.on('end', () => {
        res.end();
        if (!requestBody) return;

        const responseBody = sse
          ? sse.finalize()
          : parseJsonResponse(Buffer.concat(rawChunks).toString('utf8'));

        const turn = {
          timestamp: new Date().toISOString(),
          sessionId: req.headers['x-claude-code-session-id'] || 'default',
          agentId: req.headers['x-claude-code-agent-id'] || null,
          request: {
            model: requestBody.model,
            system: requestBody.system,
            messages: requestBody.messages,
            tools: requestBody.tools,
            max_tokens: requestBody.max_tokens,
            stream: requestBody.stream,
            anthropicBeta: req.headers['anthropic-beta'] || null,
          },
          response: responseBody
            ? {
                model: responseBody.model,
                content: responseBody.content,
                stop_reason: responseBody.stop_reason,
                usage: responseBody.usage,
              }
            : null,
          status: upstreamRes.statusCode,
        };
        onCapture(turn);
      });
    }
  );

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'upstream_request_failed', message: err.message }));
  });

  upstreamReq.write(rawBody);
  upstreamReq.end();
}

module.exports = { handleProxyRequest, SENSITIVE_HEADERS };
