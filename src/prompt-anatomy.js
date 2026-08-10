'use strict';

const { estimateTokens } = require('./breakdown');

/**
 * The fixed instructions, broken into the parts they are actually made of.
 *
 * "System prompt: 3.6K tokens" is a number you can do nothing with. The prompt
 * is a stack of independently-sourced pieces — Claude Code's own instructions,
 * the harness notes for this session, the environment block, per-integration
 * guidance — and each one is there because something is switched on. Sizing them
 * separately is what turns the number into a decision about what to turn off.
 *
 * The same goes for `<system-reminder>` blocks, which are injected into user
 * messages rather than the system prompt: they read as conversation, they are
 * billed as conversation, and they are neither.
 */

const REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
const BILLING_HEADER = /^\s*x-anthropic-billing-header:/;
const HEADING = /^(#{1,2})\s+(.+?)\s*$/;

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

function blockText(block) {
  if (typeof block === 'string') return block;
  return (block && block.text) || '';
}

function firstLine(text, max = 70) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, max);
  }
  return '';
}

/**
 * Splits one system block on its top-level markdown headings. Claude Code writes
 * the prompt as a document, so the headings are the seams the authors intended;
 * sub-headings stay folded into their parent so the list reads as a table of
 * contents rather than an outline.
 */
function splitSections(text, blockIndex) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;

  const open = (label, level) => {
    current = { label, level, blockIndex, lines: [] };
    sections.push(current);
  };

  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match && match[1].length === 1) {
      open(match[2], 1);
      continue;
    }
    if (!current) open(null, 0);
    current.lines.push(line);
  }

  return sections.map((section) => {
    const body = section.lines.join('\n');
    // An unheaded lead-in is named after its own first line when it is short
    // enough to be a title in its own right — the identity line, typically.
    const label = section.label || (body.trim().length <= 200 ? firstLine(body) : 'preamble');
    return { label: label || 'preamble', level: section.level, chars: body.length, hash: hash(body) };
  });
}

function systemSections(request) {
  const system = request && request.system;
  if (typeof system === 'string') return splitSections(system, 0);
  if (!Array.isArray(system)) return [];

  const sections = [];
  system.forEach((block, index) => {
    const text = blockText(block);
    if (!text) return;
    if (BILLING_HEADER.test(text)) {
      sections.push({ label: 'billing header', level: 0, chars: text.length, hash: hash(text) });
      return;
    }
    sections.push(...splitSections(text, index));
  });
  return sections;
}

/**
 * `<system-reminder>` blocks, pulled out of the messages they are hidden inside.
 * Grouped by opening line, because the same reminder is re-injected turn after
 * turn and the interesting number is how much it costs across all of them.
 */
function reminders(request) {
  const found = new Map();
  for (const message of (request && request.messages) || []) {
    const content = message.content;
    const blocks = Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      const text = blockText(block) || (typeof block === 'string' ? block : '');
      if (!text || !text.includes('<system-reminder>')) continue;
      REMINDER.lastIndex = 0;
      let match;
      while ((match = REMINDER.exec(text))) {
        const body = match[1];
        const kind = firstLine(body) || '(empty)';
        const entry = found.get(kind) || { kind, count: 0, chars: 0 };
        entry.count += 1;
        entry.chars += body.length;
        found.set(kind, entry);
      }
    }
  }
  return [...found.values()]
    .map((r) => ({ ...r, tokens: estimateTokens(r.chars) }))
    .sort((a, b) => b.chars - a.chars);
}

/**
 * Per-turn anatomy, plus which sections differ from the previous turn of the
 * same chain — the prompt changing mid-session is both a behaviour change and a
 * cache invalidation, and it otherwise happens silently.
 */
function analyzePrompt(turn, prev) {
  const sections = systemSections(turn && turn.request);
  const previous = prev ? new Map(systemSections(prev.request).map((s) => [s.label, s.hash])) : null;
  const totalChars = sections.reduce((sum, s) => sum + s.chars, 0);

  const reminderList = reminders(turn && turn.request);
  const reminderChars = reminderList.reduce((sum, r) => sum + r.chars, 0);

  const changed = [];
  const sized = sections.map((section) => {
    const before = previous ? previous.get(section.label) : undefined;
    const state = !previous ? null : before === undefined ? 'added' : before === section.hash ? null : 'changed';
    if (state) changed.push({ label: section.label, state });
    return {
      label: section.label,
      tokens: estimateTokens(section.chars),
      chars: section.chars,
      share: totalChars > 0 ? section.chars / totalChars : 0,
      state,
    };
  });

  if (previous) {
    const now = new Set(sections.map((s) => s.label));
    for (const label of previous.keys()) if (!now.has(label)) changed.push({ label, state: 'removed' });
  }

  return {
    sections: sized,
    systemTokens: estimateTokens(totalChars),
    reminders: reminderList,
    reminderTokens: estimateTokens(reminderChars),
    changed,
  };
}

module.exports = { analyzePrompt, systemSections, reminders };
