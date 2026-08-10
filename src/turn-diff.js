'use strict';

const { estimateTokens } = require('./breakdown');
const { systemSections } = require('./prompt-anatomy');

/**
 * Two turns compared, whichever two you pick.
 *
 * The cache and history layers compare a turn with the one immediately before
 * it, because that is what the cache does. A different question needs a
 * different pairing: what actually accumulated between turn 5 and turn 90, which
 * tools appeared, which parts of the prompt were rewritten along the way. That
 * span is where the window filled up, and no per-turn view shows it.
 */

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

function canonical(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'cache_control' in value) {
    const { cache_control, ...rest } = value;
    return JSON.stringify(rest) || '';
  }
  return JSON.stringify(value) || '';
}

/** Tools keyed by name: order matters to the cache, identity matters to a reader. */
function toolMap(request) {
  const map = new Map();
  for (const tool of (request && request.tools) || []) {
    const text = canonical({ d: tool.description, s: tool.input_schema });
    map.set(tool.name, { chars: text.length, hash: hash(text) });
  }
  return map;
}

function sectionMap(request) {
  const map = new Map();
  for (const section of systemSections(request)) map.set(section.label, section);
  return map;
}

function messageUnits(request) {
  return ((request && request.messages) || []).map((message, index) => {
    const content = message.content;
    const blocks = Array.isArray(content) ? content : [content];
    const text = blocks.map(canonical).join(' ');
    return {
      index,
      role: message.role,
      types: blocks.map((b) => (typeof b === 'string' ? 'text' : (b && b.type) || 'text')),
      chars: text.length,
      hash: hash(text),
    };
  });
}

/** Added / removed / changed, by key, with the token delta each way. */
function diffKeyed(before, after) {
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, entry] of after) {
    const previous = before.get(key);
    if (!previous) added.push({ key, tokens: estimateTokens(entry.chars) });
    else if (previous.hash !== entry.hash) {
      changed.push({
        key,
        tokensBefore: estimateTokens(previous.chars),
        tokensAfter: estimateTokens(entry.chars),
      });
    }
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push({ key, tokens: estimateTokens(entry.chars) });
  }
  return { added, removed, changed };
}

function totalTokens(map) {
  let chars = 0;
  for (const entry of map.values()) chars += entry.chars;
  return estimateTokens(chars);
}

function diffTurns(a, b) {
  if (!a || !b || !a.request || !b.request) return null;

  const toolsBefore = toolMap(a.request);
  const toolsAfter = toolMap(b.request);
  const systemBefore = sectionMap(a.request);
  const systemAfter = sectionMap(b.request);
  const messagesBefore = messageUnits(a.request);
  const messagesAfter = messageUnits(b.request);

  /* Messages are positional: the first index whose bytes differ is where the two
     turns stopped sharing a history, and everything past it on the newer side is
     what accumulated. */
  let common = 0;
  const overlap = Math.min(messagesBefore.length, messagesAfter.length);
  while (common < overlap && messagesBefore[common].hash === messagesAfter[common].hash) common += 1;

  const editedMessages = [];
  for (let i = common; i < overlap; i++) {
    editedMessages.push({
      index: i,
      role: messagesAfter[i].role,
      tokensBefore: estimateTokens(messagesBefore[i].chars),
      tokensAfter: estimateTokens(messagesAfter[i].chars),
    });
  }

  const appended = messagesAfter.slice(Math.max(common, messagesBefore.length));
  const dropped = messagesBefore.slice(Math.max(common, messagesAfter.length));

  const tokensOf = (units) => estimateTokens(units.reduce((sum, u) => sum + u.chars, 0));

  return {
    models: { before: a.request.model || null, after: b.request.model || null },
    tools: {
      ...diffKeyed(toolsBefore, toolsAfter),
      countBefore: toolsBefore.size,
      countAfter: toolsAfter.size,
      tokensBefore: totalTokens(toolsBefore),
      tokensAfter: totalTokens(toolsAfter),
    },
    system: {
      ...diffKeyed(systemBefore, systemAfter),
      tokensBefore: totalTokens(systemBefore),
      tokensAfter: totalTokens(systemAfter),
    },
    messages: {
      common,
      countBefore: messagesBefore.length,
      countAfter: messagesAfter.length,
      appended: appended.length,
      appendedTokens: tokensOf(appended),
      dropped: dropped.length,
      droppedTokens: tokensOf(dropped),
      edited: editedMessages,
      tokensBefore: tokensOf(messagesBefore),
      tokensAfter: tokensOf(messagesAfter),
    },
  };
}

module.exports = { diffTurns };
