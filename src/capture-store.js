'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * One store per machine, not per working directory — the CLI is installed
 * globally, so `cmon` must see the same captures wherever it runs.
 * Override with CXT_PROXY_HOME when you want a project-local store.
 */
const RUNTIME_DIR = process.env.CXT_PROXY_HOME
  ? path.resolve(process.env.CXT_PROXY_HOME)
  : path.join(os.homedir(), '.cxt-proxy');
const CAPTURES_DIR = path.join(RUNTIME_DIR, 'captures');

function ensureDirs() {
  fs.mkdirSync(CAPTURES_DIR, { recursive: true });
}

function sessionFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(CAPTURES_DIR, `${safe}.jsonl`);
}

/** In-memory cache: sessionId -> array of turn records (loaded lazily, appended live). */
const cache = new Map();

function loadSession(sessionId) {
  if (cache.has(sessionId)) return cache.get(sessionId);
  const file = sessionFile(sessionId);
  const turns = [];
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        turns.push(JSON.parse(line));
      } catch {
        // skip malformed line
      }
    }
  }
  cache.set(sessionId, turns);
  return turns;
}

function listSessions() {
  ensureDirs();
  const files = fs.existsSync(CAPTURES_DIR) ? fs.readdirSync(CAPTURES_DIR) : [];
  return files
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const sessionId = f.slice(0, -'.jsonl'.length);
      const turns = loadSession(sessionId);
      const last = turns[turns.length - 1];
      return {
        sessionId,
        turnCount: turns.length,
        lastActiveAt: last ? last.timestamp : null,
      };
    })
    .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));
}

function appendTurn(sessionId, turn) {
  ensureDirs();
  const turns = loadSession(sessionId); // load prior turns before writing this one
  fs.appendFileSync(sessionFile(sessionId), JSON.stringify(turn) + '\n');
  turns.push(turn);
  return turn;
}

/**
 * Drop a session for good: its capture file AND its cache entry. Removing only
 * the file would leave `loadSession` serving the stale in-memory copy, and the
 * session would reappear on the next append.
 * Returns false when there was nothing to delete.
 */
function deleteSession(sessionId) {
  ensureDirs();
  const file = sessionFile(sessionId);
  const existed = fs.existsSync(file);
  if (existed) fs.rmSync(file);
  cache.delete(sessionId);
  return existed;
}

function getTurns(sessionId) {
  ensureDirs();
  return loadSession(sessionId);
}

function countAllTurns() {
  return listSessions().reduce((sum, s) => sum + s.turnCount, 0);
}

module.exports = {
  RUNTIME_DIR,
  CAPTURES_DIR,
  ensureDirs,
  listSessions,
  appendTurn,
  deleteSession,
  getTurns,
  countAllTurns,
};
