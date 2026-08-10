'use strict';

const { estimateTokens } = require('./breakdown');

/**
 * What happened to the message list between one turn and the next.
 *
 * A conversation is supposed to grow by appending. Anything else — a message
 * rewritten in place, the list getting shorter, the whole history collapsing —
 * is the harness editing the transcript underneath the model: tool results
 * cleared to reclaim room, a compaction standing in for what came before, or a
 * branch replaying an earlier state. None of it shows up in the usage numbers,
 * and all of it changes what the model can still see.
 */

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

/* cache_control marks content rather than being content — a moving breakpoint
   is not an edit to the message it moves across. */
function canonicalBlock(block) {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object' && 'cache_control' in block) {
    const { cache_control, ...rest } = block;
    return JSON.stringify(rest) || '';
  }
  return JSON.stringify(block) || '';
}

function messageUnit(msg, index) {
  const content = msg && msg.content;
  const blocks = Array.isArray(content) ? content : [content];
  const text = blocks.map(canonicalBlock).join(' ');
  const types = blocks.map((b) => (typeof b === 'string' ? 'text' : (b && b.type) || 'text'));
  return { index, role: msg && msg.role, chars: text.length, hash: hash(text), types };
}

const cache = new WeakMap();
function unitsFor(turn) {
  if (!turn || !turn.request) return [];
  let units = cache.get(turn);
  if (!units) {
    units = ((turn.request && turn.request.messages) || []).map(messageUnit);
    cache.set(turn, units);
  }
  return units;
}

function tokensOf(units) {
  return estimateTokens(units.reduce((sum, u) => sum + u.chars, 0));
}

/** A tool result replaced by something much smaller is the shape context editing leaves behind. */
function editKind(before, after) {
  const shrank = after.chars < before.chars * 0.5;
  if (shrank && before.types.includes('tool_result')) return 'tool result cleared';
  if (shrank) return 'shortened';
  if (after.chars > before.chars) return 'extended';
  return 'rewritten';
}

function diffHistory(prev, cur) {
  const after = unitsFor(cur);
  if (!prev) {
    const only = tokensOf(after);
    return {
      shape: 'first',
      common: 0,
      appended: after.length,
      removed: 0,
      edits: [],
      tokensBefore: 0,
      tokensAfter: only,
      tokensDelta: only,
      tokensReclaimed: 0,
    };
  }
  const before = unitsFor(prev);

  let common = 0;
  const overlap = Math.min(before.length, after.length);
  while (common < overlap && before[common].hash === after[common].hash) common += 1;

  const edits = [];
  for (let i = common; i < overlap; i++) {
    edits.push({
      index: i,
      role: after[i].role,
      kind: editKind(before[i], after[i]),
      tokensBefore: estimateTokens(before[i].chars),
      tokensAfter: estimateTokens(after[i].chars),
    });
  }

  const removed = Math.max(0, before.length - after.length);
  const appended = Math.max(0, after.length - before.length);
  const tokensBefore = tokensOf(before);
  const tokensAfter = tokensOf(after);

  let shape;
  // Nothing survived — but only call it a reset when there was a conversation to
  // lose. A one-message background call whose single message changed is an edit,
  // not a wiped history, and there are enough of those to drown everything else.
  if (common === 0 && Math.min(before.length, after.length) > 1) shape = 'reset';
  // A history that keeps its opening but loses most of its bulk is a summary
  // standing in for what was there: compaction.
  else if (removed > 0 && after.length <= before.length / 2 && tokensAfter < tokensBefore * 0.6) shape = 'compaction';
  else if (removed > 0) shape = 'branch';
  else if (edits.length) shape = 'edit';
  else shape = 'append';

  const droppedChars = before.slice(after.length).reduce((sum, u) => sum + u.chars, 0);

  return {
    shape,
    common,
    appended,
    removed,
    edits,
    tokensBefore,
    tokensAfter,
    tokensDelta: tokensAfter - tokensBefore,
    /* Tokens the model can no longer see: everything edited away, plus everything dropped off the end. */
    tokensReclaimed:
      edits.reduce((sum, e) => sum + Math.max(0, e.tokensBefore - e.tokensAfter), 0) + estimateTokens(droppedChars),
  };
}

module.exports = { diffHistory };
