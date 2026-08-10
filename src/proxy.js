'use strict';

const https = require('https');

const UPSTREAM_HOST = 'api.anthropic.com';

/**
 * Headers Claude Code sends that must never be forwarded onward or persisted to disk.
 * accept-encoding is stripped so the upstream response comes back uncompressed — otherwise
 * we'd be tee-ing gzipped bytes into the SSE/JSON parser used for capture.
 */
const HOP_BY_HOP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'proxy-authorization']);

/**
 * Request headers worth keeping. Everything the Anthropic SDK stamps on a call
 * says something about the client: `x-stainless-*` is the SDK/runtime fingerprint,
 * `x-stainless-retry-count` is the only place a silent retry is visible, and the
 * `x-claude-code-*` family identifies the session and the subagent inside it.
 * Credentials never reach this list — see SENSITIVE_HEADERS.
 */
const PERSISTED_REQUEST_HEADER_PREFIXES = ['x-stainless-', 'x-claude-code-', 'anthropic-'];
const PERSISTED_REQUEST_HEADERS = new Set(['user-agent', 'x-app', 'accept']);

/**
 * Response headers worth keeping: `request-id` correlates a turn with Anthropic's
 * own logs, `anthropic-ratelimit-*` carries the remaining quota and its reset time,
 * and `retry-after` / `x-should-retry` explain a 429 the SDK swallowed.
 */
const PERSISTED_RESPONSE_HEADERS = new Set([
  'request-id',
  'retry-after',
  'x-should-retry',
  'content-type',
]);

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

function pickRequestHeaders(reqHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(reqHeaders || {})) {
    const k = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(k)) continue;
    const keep = PERSISTED_REQUEST_HEADERS.has(k) || PERSISTED_REQUEST_HEADER_PREFIXES.some((p) => k.startsWith(p));
    if (keep) out[k] = value;
  }
  return out;
}

function pickResponseHeaders(resHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(resHeaders || {})) {
    const k = key.toLowerCase();
    if (k === 'set-cookie') continue;
    if (PERSISTED_RESPONSE_HEADERS.has(k) || k.startsWith('anthropic-')) out[k] = value;
  }
  return out;
}

/** How the caller authenticated, without ever recording the credential itself. */
function authKind(reqHeaders) {
  if (reqHeaders['x-api-key']) return 'api-key';
  const auth = String(reqHeaders.authorization || '');
  if (/^bearer /i.test(auth)) return 'oauth';
  return auth ? 'other' : 'none';
}

/**
 * Claude Code's own version rides in `user-agent` (`claude-cli/2.1.226 …`).
 * It is the only wire-visible marker of which client build produced a capture,
 * which matters when a system prompt changes between releases.
 */
function parseClient(reqHeaders) {
  const ua = String(reqHeaders['user-agent'] || '');
  const cli = ua.match(/claude-cli\/([^\s(]+)/i);
  return {
    userAgent: ua || null,
    cliVersion: cli ? cli[1] : null,
    authType: authKind(reqHeaders),
    retryCount: reqHeaders['x-stainless-retry-count'] != null ? Number(reqHeaders['x-stainless-retry-count']) : null,
    sdk: {
      lang: reqHeaders['x-stainless-lang'] || null,
      package: reqHeaders['x-stainless-package-version'] || null,
      os: reqHeaders['x-stainless-os'] || null,
      arch: reqHeaders['x-stainless-arch'] || null,
      runtime: reqHeaders['x-stainless-runtime'] || null,
      runtimeVersion: reqHeaders['x-stainless-runtime-version'] || null,
    },
  };
}

/** `/v1/messages/count_tokens` is how Claude Code estimates the window before it sends;
 *  its request looks like a Messages call but its response is a single token count. */
function endpointKind(pathname) {
  if (/\/v1\/messages\/count_tokens/.test(pathname)) return 'count_tokens';
  if (/\/v1\/messages/.test(pathname)) return 'messages';
  return 'other';
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
  let stopSequence = null;
  let usage = {};
  let model = null;
  let messageId = null;
  let error = null;

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
          messageId = payload.message?.id ?? messageId;
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
            } else if (payload.delta?.type === 'thinking_delta') {
              content[payload.index].thinking = (content[payload.index].thinking || '') + payload.delta.thinking;
            } else if (payload.delta?.type === 'signature_delta') {
              content[payload.index].signature = (content[payload.index].signature || '') + payload.delta.signature;
            }
          }
          break;
        case 'message_delta':
          stopReason = payload.delta?.stop_reason ?? stopReason;
          stopSequence = payload.delta?.stop_sequence ?? stopSequence;
          usage = { ...usage, ...(payload.usage || {}) };
          break;
        // A stream can fail after a 200 header; the error arrives as an event, not a status code.
        case 'error':
          error = payload.error || { type: 'stream_error' };
          break;
        default:
          break;
      }
    }
  }

  function finalize() {
    return {
      id: messageId,
      model,
      content: content.filter(Boolean),
      stop_reason: stopReason,
      stop_sequence: stopSequence,
      usage,
      error,
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
 * Everything the request body carries beyond model/messages/tools. These decide
 * how the turn is sampled and how much of the window survives it — thinking budget,
 * effort, tool choice, the context-management policy — and none of them are
 * recoverable from the response.
 */
function captureRequestParams(body) {
  return {
    max_tokens: body.max_tokens,
    stream: body.stream,
    thinking: body.thinking ?? null,
    effort: body.effort ?? null,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    top_k: body.top_k ?? null,
    tool_choice: body.tool_choice ?? null,
    stop_sequences: body.stop_sequences ?? null,
    metadata: body.metadata ?? null,
    service_tier: body.service_tier ?? null,
    context_management: body.context_management ?? null,
    output_format: body.output_format ?? null,
    mcp_servers: body.mcp_servers ?? null,
  };
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

  const startedAt = Date.now();

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
      let responseBytes = 0;
      let firstByteAt = null;

      upstreamRes.on('data', (chunk) => {
        if (firstByteAt === null) firstByteAt = Date.now();
        responseBytes += chunk.length;
        res.write(chunk);
        if (sse) sse.feed(chunk.toString('utf8'));
        else rawChunks.push(chunk);
      });

      upstreamRes.on('end', () => {
        res.end();
        if (!requestBody) return;

        const endedAt = Date.now();
        const parsed = sse
          ? sse.finalize()
          : parseJsonResponse(Buffer.concat(rawChunks).toString('utf8'));
        const kind = endpointKind(req.url);

        const turn = {
          schema: 2,
          timestamp: new Date(startedAt).toISOString(),
          sessionId: req.headers['x-claude-code-session-id'] || 'default',
          agentId: req.headers['x-claude-code-agent-id'] || null,
          endpoint: { method: req.method, path: req.url, kind },
          client: parseClient(req.headers),
          request: {
            model: requestBody.model,
            system: requestBody.system,
            messages: requestBody.messages,
            tools: requestBody.tools,
            ...captureRequestParams(requestBody),
            anthropicBeta: req.headers['anthropic-beta'] || null,
            betas: String(req.headers['anthropic-beta'] || '').split(',').map((b) => b.trim()).filter(Boolean),
            headers: pickRequestHeaders(req.headers),
          },
          response: parsed
            ? {
                id: parsed.id ?? null,
                model: parsed.model,
                content: parsed.content,
                stop_reason: parsed.stop_reason,
                stop_sequence: parsed.stop_sequence ?? null,
                usage: parsed.usage,
                // count_tokens answers with a bare token count, and any 4xx/5xx with an
                // error object; both are the whole point of the call, so keep them verbatim.
                body: kind === 'messages' && !parsed.error ? null : parsed,
                error: parsed.error || null,
                headers: pickResponseHeaders(upstreamRes.headers),
              }
            : null,
          timing: {
            startedAt: new Date(startedAt).toISOString(),
            ttfbMs: firstByteAt === null ? null : firstByteAt - startedAt,
            durationMs: endedAt - startedAt,
          },
          bytes: { request: rawBody.length, response: responseBytes },
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
