'use strict';

/**
 * The credential the last request of a session carried, held in memory only.
 *
 * Everything else in this proxy is designed so credentials never reach disk:
 * they are dropped before a capture record is built, not redacted afterwards.
 * Exact token counting needs one, because it means calling the API rather than
 * reading a capture — so the line drawn here is narrower than "never touch it"
 * but still explicit:
 *
 *   - kept in a process-lifetime Map, never written to disk and never logged,
 *   - never returned by any endpoint, only used to authenticate an outbound
 *     count_tokens call for the session it came from,
 *   - only ever used when the user explicitly asks for a measurement.
 *
 * Restarting the proxy forgets everything here. An explicitly configured
 * ANTHROPIC_API_KEY takes precedence, so a user who would rather the proxy never
 * reuse Claude Code's own credential can supply their own.
 */

const bySession = new Map();

const AUTH_HEADERS = ['authorization', 'x-api-key'];
const FORWARDED = ['anthropic-version', 'anthropic-beta'];

function remember(sessionId, headers) {
  if (!sessionId || !headers) return;
  const auth = {};
  for (const name of AUTH_HEADERS) if (headers[name]) auth[name] = headers[name];
  if (!Object.keys(auth).length) return;
  for (const name of FORWARDED) if (headers[name]) auth[name] = headers[name];
  bySession.set(sessionId, auth);
}

/**
 * Headers to authenticate an outbound call on this session's behalf. An
 * explicit ANTHROPIC_API_KEY wins: it is the user's own choice, and it means the
 * proxy never has to reuse a credential it merely happened to see.
 */
function headersFor(sessionId) {
  if (process.env.ANTHROPIC_API_KEY) {
    return { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
  }
  const remembered = bySession.get(sessionId);
  return remembered ? { ...remembered } : null;
}

function has(sessionId) {
  return Boolean(headersFor(sessionId));
}

function forget(sessionId) {
  bySession.delete(sessionId);
}

module.exports = { remember, headersFor, has, forget };
