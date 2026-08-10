'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { handleProxyRequest } = require('./proxy');
const store = require('./capture-store');
const { computeBreakdown } = require('./breakdown');
const { analyzeTurn, walkChains, predecessorOf, chainKey, CANDIDATE_DEPTH } = require('./cache-forensics');
const { diffHistory } = require('./history-diff');
const { analyzePrompt } = require('./prompt-anatomy');
const { analyzeTools } = require('./tool-economics');
const { analyzeThinking } = require('./thinking');
const { classify } = require('./call-kinds');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const bus = new EventEmitter();
bus.setMaxListeners(100);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function handleSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(':ok\n\n');

  const onTurn = (turn) => {
    res.write(`data: ${JSON.stringify(turn)}\n\n`);
  };
  bus.on('turn', onTurn);

  req.on('close', () => {
    bus.off('turn', onTurn);
  });
}

function withBreakdown(turn, cache, history, prompt) {
  return {
    ...turn,
    breakdown: computeBreakdown(turn.request, turn.response && turn.response.usage),
    call: classify(turn),
    thinking: analyzeThinking(turn),
    cache,
    history,
    prompt,
  };
}

/* Cache analysis is comparative: a turn only means something next to the previous
   turn of its own chain. Live captures arrive one at a time, so the predecessor is
   looked up from the store rather than carried in the event. */
function annotateLive(turn) {
  const history = store.getTurns(turn.sessionId);
  const key = chainKey(turn);
  const candidates = [];
  for (let i = history.length - 2; i >= 0 && candidates.length < CANDIDATE_DEPTH; i--) {
    if (chainKey(history[i]) === key) candidates.unshift(history[i]);
  }
  const prev = predecessorOf(turn, candidates);
  return withBreakdown(turn, analyzeTurn(turn, prev), diffHistory(prev, turn), analyzePrompt(turn, prev));
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url.startsWith('/v1/')) {
        await handleProxyRequest(req, res, {
          onCapture: (turn) => {
            store.appendTurn(turn.sessionId, turn);
            bus.emit('turn', annotateLive(turn));
          },
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/api/health') {
        sendJson(res, 200, { ok: true, capturedTurns: store.countAllTurns() });
        return;
      }

      if (req.method === 'GET' && req.url === '/api/sessions') {
        sendJson(res, 200, store.listSessions());
        return;
      }

      if (req.method === 'GET' && req.url === '/api/events') {
        handleSse(req, res);
        return;
      }

      const sessionTurnsMatch = req.method === 'GET' && req.url.match(/^\/api\/sessions\/([^/]+)\/turns$/);
      if (sessionTurnsMatch) {
        const sessionId = decodeURIComponent(sessionTurnsMatch[1]);
        const raw = store.getTurns(sessionId);
        const annotations = walkChains(raw, (turn, prev) => ({
          cache: analyzeTurn(turn, prev),
          history: diffHistory(prev, turn),
          prompt: analyzePrompt(turn, prev),
        }));
        const turns = raw.map((turn, i) =>
          withBreakdown(turn, annotations[i].cache, annotations[i].history, annotations[i].prompt)
        );
        sendJson(res, 200, turns);
        return;
      }

      /* Session-scoped rather than per-turn: the tool list is one fact about the
         whole session, and repeating it on all 118 turns would dwarf them. */
      const toolsMatch = req.method === 'GET' && req.url.match(/^\/api\/sessions\/([^/]+)\/tools$/);
      if (toolsMatch) {
        const sessionId = decodeURIComponent(toolsMatch[1]);
        sendJson(res, 200, analyzeTools(store.getTurns(sessionId)));
        return;
      }

      const sessionMatch = req.method === 'DELETE' && req.url.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const deleted = store.deleteSession(sessionId);
        sendJson(res, deleted ? 200 : 404, { deleted, sessionId });
        return;
      }

      serveStatic(req, res);
    } catch (err) {
      sendJson(res, 500, { error: 'internal_error', message: err.message });
    }
  });
}

module.exports = { createServer };
