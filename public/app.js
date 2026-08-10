'use strict';

const DARK = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

const THEME = DARK
  ? { ink: '#EFEEF4', dim: '#848A9C', edge: '#20232B', panel: '#101216', accent: '#E8825C' }
  : { ink: '#14151A', dim: '#6A6E7E', edge: '#E2E2EA', panel: '#FFFFFF', accent: '#C4562F' };

const SERIES = [
  { key: 'input_tokens', label: 'input', color: DARK ? '#7C9BFF' : '#4A6FE3' },
  { key: 'cache_creation_input_tokens', label: 'cache write', color: DARK ? '#E8825C' : '#C4562F' },
  { key: 'cache_read_input_tokens', label: 'cache read', color: DARK ? '#4FC0AE' : '#2F7F76' },
  { key: 'output_tokens', label: 'output', color: DARK ? '#E3B44A' : '#B98407' },
];

/* Everything the model had to read this turn — the three input-side series. */
const CONTEXT_KEYS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

const GROUP_COLORS = {
  'System prompt': SERIES[1].color,
  Messages: SERIES[0].color,
  'Tool definitions': SERIES[2].color,
};

const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

const state = {
  sessions: [],
  sessionId: null,
  turns: [],
  turnIndex: -1,
  /* True once the user picks a turn other than the newest one: live turns keep
     streaming in, but the selection stays put instead of jumping to the tail. */
  pinned: false,
  /* sessionId whose delete button is armed — the second click is the one that
     actually deletes, so a stray click can never drop a capture. */
  pendingDelete: null,
  /* Set when a delete came back without a verdict, so the row can say so
     instead of quietly pretending the capture is gone. */
  deleteError: null,
  breakdownOpen: false,
  breakdownFilter: '',
  /* Exact section counts, keyed `sessionId#turnIndex`. Only ever filled by an
     explicit click, because producing one spends the user's quota. */
  measurements: {},
  measuring: null,
  measureError: null,
  /* Session-wide statistics, fetched separately: facts about the whole session
     rather than things that belong on every turn. */
  tools: null,
  topology: null,
};

let historyChart = null;

const el = (id) => document.getElementById(id);

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

function relativeTime(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function compactNum(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function usageOf(turn) {
  return (turn && turn.response && turn.response.usage) || {};
}

function callOf(turn) {
  return (turn && turn.call) || null;
}

/* Claude Code multiplexes several conversations onto one session id: the agent
   loop, its subagents, and short background calls with their own far smaller
   context. Charting them on one line produced a sawtooth that read as the
   window collapsing and refilling. The proxy classifies each call from what it
   sends; the fallback covers captures recorded before it did. */
function isSideChain(turn) {
  const call = callOf(turn);
  if (call) return call.group !== 'main';
  if (turn && turn.agentId) return true;
  return (((turn && turn.request && turn.request.tools) || []).length) === 0;
}

/* The main conversation, each turn tagged with its position in the full list so
   the chart can still address turns by their real number. */
function mainChain() {
  return state.turns.map((turn, index) => ({ turn, index })).filter((p) => !isSideChain(p.turn));
}

function contextTokens(turn) {
  const u = usageOf(turn);
  return CONTEXT_KEYS.reduce((sum, k) => sum + Number(u[k] || 0), 0);
}

/* The 1M window is negotiated via the anthropic-beta header, not the model id:
   Claude Code's "[1m]" suffix is an internal alias and never reaches the wire
   (the body carries a plain "claude-opus-5"). The model id is kept only as a
   fallback for captures recorded before the header was stored. */
function contextLimit(turn) {
  const beta = String((turn && turn.request && turn.request.anthropicBeta) || '');
  if (/context-1m/i.test(beta)) return 1_000_000;
  const model = String((turn && turn.request && turn.request.model) || '');
  return /\[1m\]|-1m\b|1m\]/i.test(model) ? 1_000_000 : 200_000;
}

/* --------------------------------------------------------------- data */

async function loadSessions() {
  state.sessions = await fetchJson('/api/sessions');
  renderSessionList();
  if (!state.sessionId && state.sessions.length) {
    selectSession(state.sessions[0].sessionId);
  } else if (!state.sessions.length) {
    renderDetail();
  }
}

/* Tool stats go stale as a live session runs, but they change slowly and cost a
   full re-read of the session to compute — so a burst of turns coalesces into
   one refresh instead of one per turn. */
let toolRefreshTimer = null;
function scheduleToolRefresh(sessionId) {
  clearTimeout(toolRefreshTimer);
  toolRefreshTimer = setTimeout(async () => {
    await loadSessionStats(sessionId);
    if (state.sessionId === sessionId) {
      renderTools();
      renderThreads();
    }
  }, 2000);
}

async function loadSessionStats(sessionId) {
  const [tools, topology] = await Promise.all([
    fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/tools`).catch(() => null),
    fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/topology`).catch(() => null),
  ]);
  // A failed fetch simply leaves its card hidden.
  state.tools = tools;
  state.topology = topology;
}

async function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.tools = null;
  state.topology = null;
  state.turns = await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/turns`);
  loadSessionStats(sessionId).then(() => {
    if (state.sessionId === sessionId) {
      renderTools();
      renderThreads();
    }
  });
  state.turnIndex = state.turns.length - 1;
  state.pinned = false;
  renderSessionList();
  renderDetail();
}

function selectTurn(i) {
  state.measureError = null;
  if (i < 0 || i >= state.turns.length) return;
  state.turnIndex = i;
  /* Picking the newest turn is how you get back to following the tail. */
  state.pinned = i !== state.turns.length - 1;
  renderDetail();
}

/* A live turn arrived while the user is pinned to an older one: refresh only the
   parts that describe the session as a whole. The detail panes and the drawer
   belong to the pinned turn and must survive untouched. */
function renderLiveTail() {
  if (!state.turns[state.turnIndex]) return;
  renderRibbon();
  renderHistory();
}

/* -------------------------------------------------------- session rail */

async function deleteSession(sessionId) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });

  /* Only a JSON body from the delete route counts as an answer. A bare 404 is
     what the static handler returns for a route it does not know — which is
     exactly what a server running from before this endpoint existed replies —
     and treating that as "already gone" made the row vanish while the capture
     stayed on disk, only to return on the next refresh. */
  const body = await res.json().catch(() => null);
  if (!body || typeof body.deleted !== 'boolean') {
    throw new Error(`DELETE /api/sessions returned ${res.status} with no verdict — is the proxy running the current build?`);
  }

  state.pendingDelete = null;
  state.sessions = state.sessions.filter((s) => s.sessionId !== sessionId);

  if (state.sessionId === sessionId) {
    /* The open session just went away — fall back to the newest survivor. */
    if (state.sessions.length) {
      await selectSession(state.sessions[0].sessionId);
    } else {
      state.sessionId = null;
      state.turns = [];
      state.turnIndex = -1;
      state.pinned = false;
      renderDetail();
    }
  }
  renderSessionList();
  refreshTurnCount();
}

function renderSessionList() {
  const ul = el('session-list');
  if (!state.sessions.length) {
    ul.innerHTML = `<li class="px-3 py-2 text-[11.5px] leading-relaxed text-dim dark:text-dim-dk">
      No sessions yet. Send a prompt through the proxy to see it here.</li>`;
    return;
  }
  ul.innerHTML = '';
  for (const s of state.sessions) {
    const active = s.sessionId === state.sessionId;
    const li = document.createElement('li');
    li.className = 'session-row';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'session-card';
    card.dataset.active = String(active);
    card.innerHTML = `
      <span class="block font-mono text-[11.5px] truncate ${
        active ? 'text-accent dark:text-accent-dk font-semibold' : 'text-ink dark:text-ink-dk'
      }">${escapeHtml(s.sessionId)}</span>
      <span class="mt-1 flex justify-between text-[10.5px] tabular-nums text-dim dark:text-dim-dk">
        <span>${s.turnCount} turn${s.turnCount === 1 ? '' : 's'}</span>
        <span>${escapeHtml(relativeTime(s.lastActiveAt))}</span>
      </span>`;
    card.onclick = () => {
      state.pendingDelete = null;
      state.deleteError = null;
      selectSession(s.sessionId);
    };

    const armed = state.pendingDelete === s.sessionId;
    const failed = state.deleteError && state.deleteError.sessionId === s.sessionId;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'session-del';
    del.dataset.armed = String(armed || failed);
    del.textContent = failed ? 'failed' : armed ? 'delete?' : '✕';
    del.title = failed
      ? state.deleteError.message
      : armed
        ? 'Click again to delete this session for good'
        : 'Delete this session';
    del.onclick = (ev) => {
      ev.stopPropagation(); // never let the row-select fire underneath
      if (armed) {
        deleteSession(s.sessionId).catch((err) => {
          console.error(err);
          state.pendingDelete = null;
          state.deleteError = { sessionId: s.sessionId, message: err.message };
          renderSessionList();
        });
      } else {
        state.pendingDelete = s.sessionId;
        renderSessionList();
      }
    };

    li.appendChild(card);
    li.appendChild(del);
    ul.appendChild(li);
  }
}

/* --------------------------------------------------------------- detail */

function renderDetail() {
  const container = el('detail');
  container.innerHTML = '';
  closeDrawer(); // its content belongs to the turn being replaced

  if (historyChart) {
    historyChart.destroy();
    historyChart = null;
  }

  const turn = state.turns[state.turnIndex];
  if (!turn) {
    container.appendChild(el('tpl-empty').content.cloneNode(true));
    return;
  }

  container.appendChild(el('tpl-detail').content.cloneNode(true));

  renderRibbon();
  renderGauge(turn);
  renderStats(turn);
  renderCalls();
  renderCache(turn);
  renderThinking(turn);
  renderNetwork(turn);
  renderHistory();
  renderTrajectory();
  renderBreakdown(turn);
  renderTools();
  renderThreads();
  renderPrompt(turn);
  renderMeasure();
  renderJson(el('json-view'), { request: turn.request, response: turn.response });

  el('json-expand').onclick = () => container.querySelectorAll('.json-view details').forEach((d) => (d.open = true));
  el('json-collapse').onclick = () => container.querySelectorAll('.json-view details').forEach((d, i) => (d.open = i === 0));
}

/* --------------------------------------------------------- turn ribbon */

function renderRibbon() {
  const ribbon = el('ribbon');
  const max = Math.max(1, ...state.turns.map(contextTokens));

  ribbon.innerHTML = '';
  state.turns.forEach((t, i) => {
    const tokens = contextTokens(t);
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'ribbon-bar';
    bar.dataset.active = String(i === state.turnIndex);
    bar.dataset.side = String(isSideChain(t));
    if (!tokens) bar.dataset.error = 'true';
    bar.style.height = `${Math.max(3, (tokens / max) * 34)}px`;
    const call = callOf(t);
    bar.dataset.kind = call ? call.id : '';
    bar.title = `#${i + 1} · ${compactNum(tokens)} ctx tokens${call ? ` · ${call.label}` : ''}`;
    bar.onclick = () => selectTurn(i);
    ribbon.appendChild(bar);
  });

  const active = ribbon.children[state.turnIndex];
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const turn = state.turns[state.turnIndex];
  const time = turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString() : '—';
  el('ribbon-title').textContent = `Turn ${state.turnIndex + 1} / ${state.turns.length}`;
  const follow = el('turn-follow');
  follow.hidden = !state.pinned;
  follow.onclick = () => selectTurn(state.turns.length - 1);
  const call = callOf(turn);
  el('ribbon-meta').textContent = [
    time,
    turn.request?.model || 'unknown model',
    call ? call.label : null,
    call && call.entrypoint ? call.entrypoint : null,
    turn.status && turn.status >= 400 ? `HTTP ${turn.status}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const prev = el('turn-prev');
  const next = el('turn-next');
  prev.disabled = state.turnIndex <= 0;
  next.disabled = state.turnIndex >= state.turns.length - 1;
  prev.onclick = () => selectTurn(state.turnIndex - 1);
  next.onclick = () => selectTurn(state.turnIndex + 1);
}

/* --------------------------------------------------------- context gauge */

const GAUGE_R = 66;
const GAUGE_C = 2 * Math.PI * GAUGE_R;

function renderGauge(turn) {
  const svg = el('gauge');
  const usage = usageOf(turn);
  const limit = contextLimit(turn);
  const used = contextTokens(turn);

  const ns = 'http://www.w3.org/2000/svg';
  svg.innerHTML = '';

  const track = document.createElementNS(ns, 'circle');
  track.setAttribute('cx', '80');
  track.setAttribute('cy', '80');
  track.setAttribute('r', String(GAUGE_R));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', THEME.edge);
  track.setAttribute('stroke-width', '13');
  svg.appendChild(track);

  let offset = 0;
  for (const s of CONTEXT_KEYS.map((k) => SERIES.find((x) => x.key === k))) {
    const value = Number(usage[s.key] || 0);
    if (!value) continue;
    const frac = Math.min(1, value / limit);
    const len = frac * GAUGE_C;
    const arc = document.createElementNS(ns, 'circle');
    arc.setAttribute('cx', '80');
    arc.setAttribute('cy', '80');
    arc.setAttribute('r', String(GAUGE_R));
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', s.color);
    arc.setAttribute('stroke-width', '13');
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', `${Math.max(0, len - 2)} ${GAUGE_C}`);
    arc.setAttribute('stroke-dashoffset', String(-offset));
    arc.innerHTML = `<title>${escapeHtml(s.label)}: ${compactNum(value)}</title>`;
    svg.appendChild(arc);
    offset += len;
  }

  const pct = (used / limit) * 100;
  el('gauge-pct').textContent = used ? `${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%` : '—';
  el('gauge-cap').textContent = `${compactNum(used)} of ${compactNum(limit)} ctx`;
  el('context-sub').textContent = `${turn.request?.model || 'unknown model'} · ${compactNum(limit)} limit`;
}

/* ------------------------------------------------------------ stat tiles */

function renderStats(turn) {
  const usage = usageOf(turn);
  el('usage-stats').innerHTML = SERIES.map((s) => {
    const v = usage[s.key];
    return `
      <div class="min-w-0">
        <dt class="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-dim dark:text-dim-dk">
          <span class="w-1.5 h-1.5 rounded-full inline-block shrink-0" style="background:${s.color}"></span>
          <span class="truncate">${escapeHtml(s.label)}</span>
        </dt>
        <dd class="m-0 mt-2.5 text-[30px] font-semibold tracking-[-0.035em] tabular-nums leading-none ${
          v == null ? 'text-dim dark:text-dim-dk' : ''
        }">${v == null ? '—' : compactNum(v)}</dd>
      </div>`;
  }).join('');
}

/* ----------------------------------------------------------------- tools */

/* Tool definitions render at the front of the prompt, so every one of them is
   re-sent on every turn of the session whether the model calls it or not. That
   makes an unused tool a fixed line item rather than a harmless extra. */
function renderTools() {
  const card = el('tools-card');
  const data = state.tools;
  if (!data || !data.tools.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const { totals } = data;
  el('tools-sub').textContent = `${data.tools.length} tools · ${compactNum(totals.definitionTokens)} tokens of definitions`;

  const max = Math.max(1, ...data.tools.map((t) => t.definitionTokens));
  el('tools-rows').innerHTML = data.tools
    .map((tool) => {
      const unused = tool.calls === 0;
      return `
      <div class="stat-row" ${unused ? 'style="opacity:.55"' : ''}>
        <div class="min-w-0 flex items-center gap-2.5">
          <span class="font-mono text-[12px] truncate" title="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</span>
          ${
            unused
              ? '<span class="font-mono text-[10px] uppercase tracking-[0.1em] text-dim dark:text-dim-dk shrink-0">never called</span>'
              : `<span class="font-mono text-[10.5px] tabular-nums shrink-0" style="color:var(--signal)">×${tool.calls}</span>`
          }
        </div>
        <div class="font-mono text-[12px] tabular-nums text-right shrink-0">
          ${compactNum(tool.definitionTokens)}
          ${tool.resultTokens ? `<span class="text-dim dark:text-dim-dk">· ${compactNum(tool.resultTokens)} back</span>` : ''}
        </div>
        <div class="stat-share"><span style="width:${((tool.definitionTokens / max) * 100).toFixed(1)}%;background:${
          unused ? 'color-mix(in srgb, var(--dim) 55%, transparent)' : 'var(--signal)'
        }"></span></div>
      </div>`;
    })
    .join('');

  const share = totals.definitionTokens > 0 ? totals.unusedTokens / totals.definitionTokens : 0;
  const lines = [
    `${totals.unusedCount} of ${data.tools.length} tools were never called — ${compactNum(
      totals.unusedTokens
    )} tokens (${Math.round(share * 100)}% of the definitions) re-sent on every turn`,
  ];
  if (totals.promptCost > 0) {
    lines.push(
      `definitions account for ≈${money(totals.attributedCost)} of the ${money(
        totals.promptCost
      )} this session spent on prompts`
    );
  }
  if (totals.resultTokens) lines.push(`${compactNum(totals.resultTokens)} tokens came back as tool results`);
  lines.push(
    data.churn.length
      ? `the tool list changed on ${data.churn.length} turn${
          data.churn.length === 1 ? '' : 's'
        } — each change invalidates the whole cache`
      : 'the tool list never changed, so it stayed cacheable all session'
  );

  el('tools-foot').innerHTML = lines
    .map((line) => `<div class="font-mono text-[11px] text-dim dark:text-dim-dk">${line}</div>`)
    .join('');
}

/* --------------------------------------------------------- system prompt */

/* "System prompt: 3.6K tokens" is a number you can do nothing with. Each section
   is there because something is switched on, so sizing them separately turns the
   number into a decision about what to turn off. */
function renderPrompt(turn) {
  const card = el('prompt-card');
  const prompt = turn.prompt;
  if (!prompt || !prompt.sections.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  el('prompt-sub').textContent = `${compactNum(prompt.systemTokens)} tokens · ${prompt.sections.length} sections${
    prompt.reminderTokens ? ` · ${compactNum(prompt.reminderTokens)} in reminders` : ''
  }`;

  const ranked = [...prompt.sections].sort((a, b) => b.tokens - a.tokens);
  el('prompt-sections').innerHTML = ranked
    .map(
      (section) => `
      <div class="stat-row">
        <div class="min-w-0 flex items-center gap-2.5">
          <span class="text-[13.5px] font-semibold tracking-tight truncate">${escapeHtml(section.label)}</span>
          ${
            section.state
              ? `<span class="font-mono text-[10px] uppercase tracking-[0.1em]" style="color:var(--warn)">${section.state}</span>`
              : ''
          }
        </div>
        <div class="font-mono text-[12px] tabular-nums text-right shrink-0">
          ${compactNum(section.tokens)}
          <span class="text-dim dark:text-dim-dk">· ${Math.round(section.share * 100)}%</span>
        </div>
        <div class="stat-share"><span style="width:${(section.share * 100).toFixed(1)}%;background:var(--accent)"></span></div>
      </div>`
    )
    .join('');

  const wrap = el('prompt-reminders-wrap');
  if (!prompt.reminders.length) {
    wrap.hidden = true;
  } else {
    wrap.hidden = false;
    el('prompt-reminders').innerHTML = prompt.reminders
      .map(
        (reminder) => `
        <div class="stat-row">
          <div class="min-w-0 flex items-center gap-2.5">
            <span class="font-mono text-[11.5px] truncate">${escapeHtml(reminder.kind)}</span>
            ${reminder.count > 1 ? `<span class="font-mono text-[10.5px] text-dim dark:text-dim-dk tabular-nums">×${reminder.count}</span>` : ''}
          </div>
          <div class="font-mono text-[12px] tabular-nums text-right shrink-0">${compactNum(reminder.tokens)}</div>
        </div>`
      )
      .join('');
  }

  renderPromptChanges();
}

/* A prompt that changes mid-session changes behaviour and invalidates the cache
   from that point on, and it does both silently. */
function renderPromptChanges() {
  const changes = state.turns
    .map((turn, index) => ({ turn, index, changed: (turn.prompt && turn.prompt.changed) || [] }))
    .filter((x) => x.changed.length)
    .filter((x) => {
      const call = callOf(x.turn);
      return !call || call.group === 'main' || call.group === 'subagent';
    });

  const foot = el('prompt-foot');
  if (!changes.length) {
    foot.innerHTML =
      '<div class="font-mono text-[11px] text-dim dark:text-dim-dk">unchanged across every turn of this session</div>';
    return;
  }

  const chips = changes
    .slice(-14)
    .map(
      (x) =>
        `<button type="button" class="ghost-btn tabular-nums" data-turn="${x.index}" title="${escapeHtml(
          x.changed.map((c) => `${c.label} ${c.state}`).join(' · ')
        )}">#${x.index + 1}</button>`
    )
    .join('');

  foot.innerHTML = `
    <div class="flex flex-col gap-3">
      <div class="font-mono text-[11px] text-dim dark:text-dim-dk">the system prompt changed on ${
        changes.length
      } turn${changes.length === 1 ? '' : 's'} — each one also ends the cached prefix there</div>
      <div class="flex flex-wrap gap-2">${chips}</div>
    </div>`;

  foot.querySelectorAll('[data-turn]').forEach((button) => {
    button.onclick = () => selectTurn(Number(button.dataset.turn));
  });
}

/* --------------------------------------------------------------- threads */

/* A subagent is a whole conversation of its own — its own window, its own tool
   set, its own bill — that exists to hand a few hundred tokens back to the
   conversation that spawned it. Turn by turn that is invisible. */
function renderThreads() {
  const card = el('threads-card');
  const data = state.topology;
  /* A session with one thread is just a conversation; the card would be a
     one-row restatement of everything else on the page. */
  if (!data || data.threads.length < 2) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const { totals } = data;
  el('threads-sub').textContent = `${totals.threads} threads · ${totals.subagents} subagent${
    totals.subagents === 1 ? '' : 's'
  }`;

  const max = Math.max(1, ...data.threads.map((t) => t.billedTokens));
  el('threads-rows').innerHTML = data.threads
    .map((thread) => {
      // Show the id whole and let the cell truncate it — a fixed slice cuts
      // exactly where agent ids differ from each other.
      const label = thread.kind === 'conversation' ? 'the conversation' : `subagent ${thread.id}`;
      const spawn = thread.spawn
        ? `spawned by ${escapeHtml(thread.spawn.toolName)} at turn #${thread.spawn.turnIndex + 1}${
            thread.spawn.reportTokens != null ? ` · reported back ${compactNum(thread.spawn.reportTokens)} tokens` : ''
          }`
        : thread.kind === 'subagent'
        ? 'no spawning call found before it started'
        : `${thread.toolCount} tools · peak ${compactNum(thread.peakContextTokens)} context tokens`;

      return `
      <button type="button" class="stat-row text-left w-full" data-turn="${thread.firstTurnIndex}">
        <div class="min-w-0 flex items-center gap-2.5">
          <span class="dot" style="background:${
            thread.kind === 'subagent' ? 'var(--signal)' : 'var(--accent)'
          }"></span>
          <span class="text-[13.5px] font-semibold tracking-tight truncate">${escapeHtml(label)}</span>
          <span class="font-mono text-[10.5px] text-dim dark:text-dim-dk tabular-nums shrink-0">${thread.turns} turn${
            thread.turns === 1 ? '' : 's'
          }</span>
        </div>
        <div class="font-mono text-[12px] tabular-nums text-right shrink-0">${money(thread.cost)}</div>
        <div class="font-mono text-[10.5px] text-dim dark:text-dim-dk truncate">${spawn}</div>
        <div class="font-mono text-[10.5px] text-dim dark:text-dim-dk tabular-nums text-right shrink-0">${compactNum(
          thread.billedTokens
        )} in · ${compactNum(thread.outputTokens)} out</div>
        <div class="stat-share"><span style="width:${((thread.billedTokens / max) * 100).toFixed(1)}%;background:${
          thread.kind === 'subagent' ? 'var(--signal)' : 'var(--accent)'
        }"></span></div>
      </button>`;
    })
    .join('');

  el('threads-rows')
    .querySelectorAll('[data-turn]')
    .forEach((button) => {
      button.onclick = () => selectTurn(Number(button.dataset.turn));
    });

  const lines = [];
  if (totals.subagents) {
    const ratio = totals.reportedTokens > 0 ? Math.round(totals.subagentBilledTokens / totals.reportedTokens) : null;
    lines.push(
      `subagents spent ${compactNum(totals.subagentBilledTokens)} tokens (${money(totals.subagentCost)}, ${
        totals.totalCost > 0 ? Math.round((totals.subagentCost / totals.totalCost) * 100) : 0
      }% of the session) to report back ${compactNum(totals.reportedTokens)}${
        ratio ? ` — ${ratio}× what the conversation ever saw` : ''
      }`
    );
  }
  lines.push('which call spawned which thread is inferred from ordering, not stated on the wire');
  el('threads-foot').innerHTML = lines
    .map((line) => `<div class="font-mono text-[11px] text-dim dark:text-dim-dk">${line}</div>`)
    .join('');
}

/* --------------------------------------------------------- exact counting */

/* Every token figure in the breakdown is `chars / 4`, because the API reports
   usage in aggregate and never per section. count_tokens will answer exactly,
   for a price — so this only ever runs when asked. */
function measureKey(index) {
  return `${state.sessionId}#${index}`;
}

function renderMeasure() {
  const button = el('measure-btn');
  const panel = el('measure-result');
  if (!button || !panel) return;

  const key = measureKey(state.turnIndex);
  const result = state.measurements[key];
  const busy = state.measuring === key;

  button.disabled = busy;
  button.textContent = busy ? 'measuring…' : result ? 'measured' : 'Measure exactly';
  button.onclick = () => measureCurrentTurn();

  if (state.measureError) {
    panel.hidden = false;
    panel.innerHTML = `<div class="font-mono text-[11px]" style="color:var(--danger)">${escapeHtml(state.measureError)}</div>`;
    return;
  }
  if (!result) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const rows = [
    ['system prompt', result.estimated.system, result.exact.system],
    ['messages', result.estimated.messages, result.exact.messages],
    ['tool definitions', result.estimated.tools, result.exact.tools],
    ['request overhead', null, result.exact.baseline],
    ['total', result.estimated.total, result.exact.total],
  ];

  const off = result.ratio != null ? Math.round((result.ratio - 1) * 100) : null;
  panel.innerHTML = `
    <div class="label-eyebrow mb-4">Measured with count_tokens</div>
    <div class="flex flex-col">
      ${rows
        .map(
          ([label, estimated, exact]) => `
        <div class="stat-row">
          <div class="min-w-0 font-mono text-[12px] truncate">${escapeHtml(label)}</div>
          <div class="font-mono text-[12px] tabular-nums text-right shrink-0">
            ${compactNum(exact)}
            ${estimated != null ? `<span class="text-dim dark:text-dim-dk">· est ${compactNum(estimated)}</span>` : ''}
          </div>
        </div>`
        )
        .join('')}
    </div>
    <div class="mt-5 font-mono text-[11px] text-dim dark:text-dim-dk">
      ${
        off == null
          ? ''
          : `the chars/4 estimate was ${off === 0 ? 'exact' : `${off > 0 ? 'under' : 'over'} by ${Math.abs(off)}%`} on this request · ${result.charsPerToken.toFixed(
              2
            )} chars per token${result.cached ? ' · cached' : ` · ${result.calls} count_tokens calls`}
    </div>`
      }`;
}

async function measureCurrentTurn() {
  const key = measureKey(state.turnIndex);
  if (state.measurements[key] || state.measuring) return;
  state.measuring = key;
  state.measureError = null;
  renderMeasure();

  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(state.sessionId)}/turns/${state.turnIndex}/count`,
      { method: 'POST' }
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
    state.measurements[key] = body;
  } catch (err) {
    state.measureError = err.message;
  } finally {
    state.measuring = null;
    renderMeasure();
  }
}

/* --------------------------------------------------------------- network */

function ms(value) {
  if (value == null) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}s`;
}

function bytes(value) {
  if (value == null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/* Latency splits in two and the halves mean different things: the wait before
   the first byte is queueing and prompt processing, everything after it is
   generation. Averaged together, a slow queue reads as a slow model. */
function renderNetwork(turn) {
  const card = el('network-card');
  const net = turn.network;
  if (!net || !net.recorded) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  el('network-sub').textContent = [
    net.status ? `HTTP ${net.status}` : null,
    net.requestId ? net.requestId : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const cells = [
    ['time to first byte', ms(net.ttfbMs), 'queue + prompt'],
    ['generating', ms(net.streamMs), net.tokensPerSecond ? `${net.tokensPerSecond.toFixed(1)} tok/s` : null],
    ['total', ms(net.durationMs), null],
    ['on the wire', bytes(net.bytes && net.bytes.request), net.bytes ? `${bytes(net.bytes.response)} back` : null],
  ];
  el('network-stats').innerHTML = cells
    .map(
      ([label, value, sub]) => `
      <div class="min-w-0">
        <dt class="font-mono text-[10px] uppercase tracking-[0.12em] text-dim dark:text-dim-dk truncate">${escapeHtml(label)}</dt>
        <dd class="m-0 mt-2.5 text-[26px] font-semibold tracking-[-0.035em] tabular-nums leading-none">${escapeHtml(value)}</dd>
        ${sub ? `<div class="mt-2 font-mono text-[10.5px] text-dim dark:text-dim-dk">${escapeHtml(sub)}</div>` : ''}
      </div>`
    )
    .join('');

  renderRateLimits(net);
  renderNetworkFoot(net);
}

function renderRateLimits(net) {
  const wrap = el('network-limits-wrap');
  if (!net.rateLimits.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  el('network-limits').innerHTML = net.rateLimits
    .map((row) => {
      const share = row.share == null ? null : Math.max(0, Math.min(1, row.share));
      const colour = share == null || share > 0.3 ? 'var(--signal)' : share > 0.1 ? 'var(--warn)' : 'var(--danger)';
      return `
      <div class="stat-row">
        <div class="min-w-0 flex items-center gap-2.5">
          <span class="font-mono text-[12px] truncate">${escapeHtml(row.resource)}</span>
          ${row.status ? `<span class="font-mono text-[10.5px] text-dim dark:text-dim-dk">${escapeHtml(row.status)}</span>` : ''}
        </div>
        <div class="font-mono text-[12px] tabular-nums text-right shrink-0">
          ${row.remaining != null ? escapeHtml(String(row.remaining)) : '—'}${
            row.limit != null ? `<span class="text-dim dark:text-dim-dk"> / ${escapeHtml(String(row.limit))}</span>` : ''
          }
        </div>
        ${
          share == null
            ? ''
            : `<div class="stat-share"><span style="width:${(share * 100).toFixed(1)}%;background:${colour}"></span></div>`
        }
        ${
          row.reset
            ? `<div class="font-mono text-[10.5px] text-dim dark:text-dim-dk">resets ${escapeHtml(String(row.reset))}</div>`
            : ''
        }
      </div>`;
    })
    .join('');
}

function renderNetworkFoot(net) {
  const measured = state.turns.filter((t) => t.network && t.network.recorded);
  const lines = [];

  const ttfbs = measured.map((t) => t.network.ttfbMs).filter((v) => v != null).sort((a, b) => a - b);
  const rates = measured.map((t) => t.network.tokensPerSecond).filter((v) => v).sort((a, b) => a - b);
  if (ttfbs.length) {
    const median = ttfbs[Math.floor(ttfbs.length / 2)];
    const slowest = ttfbs[ttfbs.length - 1];
    lines.push(
      `${measured.length} measured turns · median first byte ${ms(median)} · slowest ${ms(slowest)}${
        rates.length ? ` · median ${rates[Math.floor(rates.length / 2)].toFixed(1)} tok/s` : ''
      }`
    );
  }

  /* A retry the SDK handled is invisible everywhere else: the request succeeded,
     so nothing surfaces except a count on a header. */
  const retried = measured.filter((t) => t.network.retryCount > 0);
  const failed = state.turns.filter((t) => t.status && t.status >= 400);
  if (retried.length || failed.length) {
    const parts = [];
    if (retried.length)
      parts.push(`${retried.length} turn${retried.length === 1 ? '' : 's'} arrived after an SDK retry`);
    if (failed.length) {
      const codes = [...new Set(failed.map((t) => t.status))].sort();
      parts.push(`${failed.length} failed (HTTP ${codes.join(', ')})`);
    }
    lines.push(parts.join(' · '));
  } else if (measured.length) {
    lines.push('no retries and no failed requests in this session');
  }

  if (net.error) {
    lines.push(`this turn: ${escapeHtml(net.error.type || 'error')}${net.retryAfter ? ` · retry after ${escapeHtml(String(net.retryAfter))}s` : ''}`);
  }

  el('network-foot').innerHTML = lines
    .map((line) => `<div class="font-mono text-[11px] text-dim dark:text-dim-dk">${line}</div>`)
    .join('');
}

/* -------------------------------------------------------------- thinking */

const BLOCK_LABEL = {
  thinking: 'thinking',
  redacted_thinking: 'redacted thinking',
  text: 'text',
  tool_use: 'tool call',
  server_tool_use: 'server tool',
};

/* Thinking is billed as output but is not the answer, so a turn's output count
   says nothing about how much of it anyone reads. */
function renderThinking(turn) {
  const card = el('thinking-card');
  const thinking = turn.thinking;
  if (!thinking) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const pct = Math.round(thinking.ratio * 100);
  el('thinking-sub').textContent = thinking.outputTokens
    ? `${compactNum(thinking.thinkingTokens)} of ${compactNum(thinking.outputTokens)} output tokens · ${pct}%`
    : 'no output recorded';

  el('thinking-shape').innerHTML = thinking.shape.length
    ? thinking.shape
        .map(
          (type, i) =>
            `${i ? '<span class="font-mono text-[11px] text-dim dark:text-dim-dk">→</span>' : ''}<span class="pill"${
              type.includes('thinking') ? ' style="color:var(--signal);border-color:currentColor"' : ''
            }>${escapeHtml(BLOCK_LABEL[type] || type)}</span>`
        )
        .join('')
    : '<span class="font-mono text-[11px] text-dim dark:text-dim-dk">no content blocks</span>';

  el('thinking-meter').style.width = `${Math.min(100, pct)}%`;
  el('thinking-meter').style.background = 'var(--signal)';

  el('thinking-note').innerHTML = thinkingNote(thinking);
  renderThinkingFoot(thinking);
}

function thinkingNote(thinking) {
  const lines = [];
  if (!thinking.blocks.length) {
    lines.push('This turn returned no thinking blocks — with adaptive thinking that is the model deciding the task did not need any.');
  } else if (thinking.display === 'omitted') {
    lines.push(
      `${thinking.blocks.length} thinking block${
        thinking.blocks.length === 1 ? '' : 's'
      } came back with empty text: the raw reasoning is never returned, only a signature. The tokens were still generated and still billed.`
    );
  } else {
    lines.push(`${thinking.blocks.length} thinking blocks came back as readable summaries.`);
  }

  const config = thinking.config;
  if (config && config.recorded) {
    const parts = [];
    if (config.thinking) parts.push(`thinking: ${escapeHtml(JSON.stringify(config.thinking))}`);
    if (config.effort) parts.push(`effort: ${escapeHtml(config.effort)}`);
    if (config.taskBudget) parts.push(`task budget: ${escapeHtml(JSON.stringify(config.taskBudget))}`);
    lines.push(parts.length ? `Requested with ${parts.join(' · ')}.` : 'The request asked for no thinking configuration.');
  } else {
    lines.push('This capture predates recording the thinking and effort parameters, so what was requested is unknown.');
  }
  return lines.join(' ');
}

/* Signatures are the part that keeps costing after the turn ends: every thinking
   block is replayed into every later request, and the signature is all of it. */
function renderThinkingFoot(thinking) {
  const chain = state.turns.filter((t) => !isSideChain(t) && t.thinking);
  const thought = chain.filter((t) => t.thinking.thinkingTokens > 0).length;
  const thinkingTokens = chain.reduce((sum, t) => sum + t.thinking.thinkingTokens, 0);
  const outputTokens = chain.reduce((sum, t) => sum + t.thinking.outputTokens, 0);

  const lines = [];
  if (chain.length) {
    lines.push(
      `${thought} of ${chain.length} conversation turns thought · ${compactNum(thinkingTokens)} of ${compactNum(
        outputTokens
      )} output tokens (${outputTokens ? Math.round((thinkingTokens / outputTokens) * 100) : 0}%)`
    );
  }
  if (thinking.echoedBlocks) {
    lines.push(
      `${thinking.echoedBlocks} thinking blocks are replayed in this request, carrying ≈${compactNum(
        thinking.echoedSignatureTokens
      )} tokens of signature nobody can read`
    );
  }

  el('thinking-foot').innerHTML = lines
    .map((line) => `<div class="font-mono text-[11px] text-dim dark:text-dim-dk">${line}</div>`)
    .join('');
}

/* ------------------------------------------------------------ trajectory */

const SHAPE_LABEL = {
  edit: 'edited in place',
  branch: 'replayed from an earlier point',
  compaction: 'compacted',
  reset: 'history replaced',
};

/* Where the window is heading, and every point where the harness changed the
   transcript underneath the model. Both are invisible in the usage numbers:
   growth because it is a trend, edits because a rewritten message costs the same
   as the one it replaced. */
function renderTrajectory() {
  const foot = el('history-foot');
  const points = mainChain();
  const lines = [];

  if (points.length > 1) {
    const window = points.slice(-12);
    const first = contextTokens(window[0].turn);
    const last = contextTokens(window[window.length - 1].turn);
    const perTurn = (last - first) / (window.length - 1);
    const limit = contextLimit(window[window.length - 1].turn);
    const headroom = limit - last;

    if (perTurn > 0) {
      const turnsLeft = Math.floor(headroom / perTurn);
      lines.push(
        `growing ≈${compactNum(Math.round(perTurn))} tokens per turn · ≈${compactNum(turnsLeft)} turns of headroom below the ${compactNum(limit)} limit`
      );
    } else {
      lines.push(`not growing over the last ${window.length} turns · ${compactNum(headroom)} tokens of headroom`);
    }
  }

  /* Only the conversations. A background classifier's single message growing
     between calls is how those calls work, not the transcript being edited
     underneath a model, and there are enough of them to bury the real ones. */
  const changed = state.turns
    .map((turn, index) => ({ turn, index, history: turn.history, call: callOf(turn) }))
    .filter((x) => x.history && x.history.shape !== 'append' && x.history.shape !== 'first')
    .filter((x) => !x.call || x.call.group === 'main' || x.call.group === 'subagent');

  const reclaimed = changed.reduce((sum, x) => sum + (x.history.tokensReclaimed || 0), 0);
  const shapes = changed.reduce((acc, x) => {
    acc[x.history.shape] = (acc[x.history.shape] || 0) + 1;
    return acc;
  }, {});

  if (changed.length) {
    const parts = Object.entries(shapes).map(([shape, n]) => `${n} turn${n === 1 ? '' : 's'} ${SHAPE_LABEL[shape] || shape}`);
    lines.push(
      `conversation history: ${parts.join(' · ')}${
        reclaimed ? ` · ≈${compactNum(reclaimed)} tokens the model can no longer see` : ''
      }`
    );
  }

  const chips = changed
    .slice(-14)
    .map(
      (x) =>
        `<button type="button" class="ghost-btn tabular-nums" data-turn="${x.index}" title="${escapeHtml(
          describeHistory(x.history)
        )}">#${x.index + 1}</button>`
    )
    .join('');

  foot.innerHTML = `
    <div class="flex flex-col gap-3">
      ${lines
        .map((line) => `<div class="font-mono text-[11px] text-dim dark:text-dim-dk">${line}</div>`)
        .join('')}
      ${chips ? `<div class="flex flex-wrap gap-2">${chips}</div>` : ''}
    </div>`;

  foot.querySelectorAll('[data-turn]').forEach((button) => {
    button.onclick = () => selectTurn(Number(button.dataset.turn));
  });
}

function describeHistory(history) {
  const parts = [SHAPE_LABEL[history.shape] || history.shape];
  if (history.removed) parts.push(`${history.removed} message${history.removed === 1 ? '' : 's'} dropped`);
  for (const edit of history.edits.slice(0, 4)) {
    parts.push(`message[${edit.index}] (${edit.role}) ${edit.kind} ${compactNum(edit.tokensBefore)}→${compactNum(edit.tokensAfter)}`);
  }
  if (history.edits.length > 4) parts.push(`+${history.edits.length - 4} more`);
  return parts.join(' · ');
}

/* ----------------------------------------------------------------- calls */

/* A third of the requests in a session can be background classifiers that never
   touch the conversation. They are invisible in a per-turn view and invisible on
   the bill; this is the one place they are counted. */
const GROUP_COLOR = {
  main: 'var(--accent)',
  subagent: 'var(--signal)',
  background: 'color-mix(in srgb, var(--dim) 55%, transparent)',
  meta: 'color-mix(in srgb, var(--dim) 30%, transparent)',
};

function billedTokens(turn) {
  const u = usageOf(turn);
  return Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
}

function renderCalls() {
  const card = el('calls-card');
  const classified = state.turns.filter((t) => callOf(t));
  if (!classified.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const kinds = new Map();
  for (const turn of state.turns) {
    const call = callOf(turn);
    if (!call) continue;
    let row = kinds.get(call.id);
    if (!row) {
      row = { ...call, count: 0, tokensIn: 0, tokensOut: 0, cost: 0, models: new Set() };
      kinds.set(call.id, row);
    }
    row.count += 1;
    row.tokensIn += billedTokens(turn);
    row.tokensOut += Number(usageOf(turn).output_tokens || 0);
    row.cost += turn.cache && turn.cache.cost ? turn.cache.cost.actual : 0;
    if (turn.request && turn.request.model) row.models.add(turn.request.model);
  }

  const rows = [...kinds.values()].sort((a, b) => b.cost - a.cost || b.count - a.count);
  const totalCost = rows.reduce((sum, r) => sum + r.cost, 0);
  const totalCalls = rows.reduce((sum, r) => sum + r.count, 0);

  el('calls-sub').textContent = `${totalCalls} calls · ${rows.length} kind${rows.length === 1 ? '' : 's'}`;

  el('calls-rows').innerHTML = rows
    .map((r) => {
      const share = totalCost > 0 ? r.cost / totalCost : 0;
      return `
      <div class="stat-row">
        <div class="min-w-0 flex items-center gap-2.5">
          <span class="dot" style="background:${GROUP_COLOR[r.group] || GROUP_COLOR.background}"></span>
          <span class="text-[13.5px] font-semibold tracking-tight truncate">${escapeHtml(r.label)}</span>
          <span class="font-mono text-[10.5px] text-dim dark:text-dim-dk tabular-nums shrink-0">×${r.count}</span>
        </div>
        <div class="font-mono text-[12px] tabular-nums text-right shrink-0">
          ${money(r.cost)}
          <span class="text-dim dark:text-dim-dk">· ${Math.round(share * 100)}%</span>
        </div>
        <div class="font-mono text-[10.5px] text-dim dark:text-dim-dk truncate">
          ${escapeHtml(r.note)} · ${[...r.models].join(', ') || '—'}
        </div>
        <div class="font-mono text-[10.5px] text-dim dark:text-dim-dk tabular-nums text-right shrink-0">
          ${compactNum(r.tokensIn)} in · ${compactNum(r.tokensOut)} out
        </div>
        <div class="stat-share"><span style="width:${(share * 100).toFixed(1)}%;background:${GROUP_COLOR[r.group] || GROUP_COLOR.background}"></span></div>
      </div>`;
    })
    .join('');

  const background = rows.filter((r) => r.group === 'background' || r.group === 'meta');
  const bgCalls = background.reduce((sum, r) => sum + r.count, 0);
  const bgCost = background.reduce((sum, r) => sum + r.cost, 0);
  const versions = [...new Set(state.turns.map((t) => callOf(t) && callOf(t).ccVersion).filter(Boolean))];

  el('calls-foot').innerHTML = `
    <div class="flex flex-wrap items-baseline gap-x-7 gap-y-2 font-mono text-[11px] text-dim dark:text-dim-dk">
      <span>${bgCalls} of ${totalCalls} calls run beside the conversation${
        totalCost > 0 ? `, costing ${money(bgCost)} (${Math.round((bgCost / totalCost) * 100)}%)` : ''
      }</span>
      ${versions.length ? `<span>claude-cli ${versions.map(escapeHtml).join(', ')}</span>` : ''}
    </div>`;
}

/* ----------------------------------------------------------------- cache */

const VERDICT_LABEL = { hit: 'prefix hit', partial: 'partial hit', miss: 'miss', cold: 'cold start' };

function money(v) {
  if (v == null) return '—';
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function duration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/* The usage numbers say what the cache did; this says why. A rewrite caused by a
   changed block is something you can go and fix, an expired TTL is not, and the
   two are indistinguishable from the token counts alone. */
function cacheExplanation(c) {
  const cause = c.cause;
  if (c.verdict === 'cold') return 'First turn of this conversation — there was no prefix to reuse yet.';
  if (c.verdict === 'hit') {
    return c.divergence
      ? 'Everything the previous turn had cached was byte-identical. The only difference is past the last breakpoint, which was never cached.'
      : 'The whole prefix matched the previous turn, byte for byte.';
  }
  if (!cause) return '';
  if (cause.type === 'ttl-expiry') {
    return `Nothing was reused, and the prefix had not changed — ${duration(c.elapsedMs)} idle since the previous turn, past the ${cause.ttl} TTL.`;
  }
  if (cause.type === 'prefix-drift') {
    const what = c.divergence && c.divergence.reason === 'removed'
      ? `<b class="font-semibold">${escapeHtml(cause.unit || '')}</b> was dropped from the history`
      : `<b class="font-semibold">${escapeHtml(cause.unit || '')}</b> changed`;
    return `${what}, inside the region the previous turn had cached. Roughly <b class="font-semibold tabular-nums">${compactNum(cause.tokensInvalidated)}</b> cached tokens had to be written again.`;
  }
  return 'Nothing was reused, and the prefix is unchanged — the entry was evicted upstream.';
}

function renderCache(turn) {
  const card = el('cache-card');
  const c = turn.cache;
  if (!c) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const ttl = c.ttl ? `${c.ttl} TTL` : 'no breakpoints';
  el('cache-sub').textContent = `${c.breakpoints.length} breakpoint${c.breakpoints.length === 1 ? '' : 's'} · ${ttl}`;

  el('cache-verdict').innerHTML = `
    <div class="flex items-center gap-3 flex-wrap">
      <span class="verdict" data-v="${c.verdict}">${escapeHtml(VERDICT_LABEL[c.verdict] || c.verdict)}</span>
      ${c.elapsedMs != null ? `<span class="pill">${duration(c.elapsedMs)} since previous turn</span>` : ''}
    </div>
    <p class="text-[13px] leading-relaxed text-dim dark:text-dim-dk max-w-[74ch]">${cacheExplanation(c)}</p>`;

  renderCacheStrip(turn, c);
  renderCacheCost(c);
  renderCacheSession();
}

/* The prefix drawn in token space — how far the cached region reached, where the
   breakpoints sat, and where the first difference landed relative to them. */
function renderCacheStrip(turn, c) {
  const total = Math.max(1, c.approxTokens || (turn.breakdown && turn.breakdown.totalApproxTokens) || 1);
  const pct = (t) => `${Math.min(100, Math.max(0, (t / total) * 100))}%`;
  const cachedUpTo = c.breakpoints.length ? c.breakpoints[c.breakpoints.length - 1].approxTokensUpTo : 0;

  const marks = c.breakpoints
    .map((b) => `<span class="cache-tick" style="left:${pct(b.approxTokensUpTo)}" title="breakpoint · ${escapeHtml(b.label)} · ${compactNum(b.approxTokensUpTo)} tokens in"></span>`)
    .join('');
  const breakMark =
    c.divergence && c.divergence.invalidating
      ? `<span class="cache-break" style="left:${pct(c.divergence.tokensBefore || 0)}" title="first difference · ${escapeHtml(c.divergence.label)}"></span>`
      : '';

  el('cache-strip').innerHTML =
    `<span class="cache-fill" style="width:${pct(cachedUpTo)}"></span>${marks}${breakMark}`;

  const dot = (color, text) =>
    `<span class="flex items-center gap-2 font-mono text-[10.5px] text-dim dark:text-dim-dk"><span class="w-1.5 h-1.5 rounded-full inline-block" style="background:${color}"></span>${text}</span>`;
  el('cache-strip-legend').innerHTML = [
    dot('color-mix(in srgb, var(--accent) 45%, transparent)', `cached prefix ≈${compactNum(cachedUpTo)} of ${compactNum(total)} tokens`),
    c.breakpoints.length ? dot('var(--accent)', `${c.breakpoints.length} breakpoint${c.breakpoints.length === 1 ? '' : 's'}`) : '',
    c.divergence && c.divergence.invalidating
      ? dot('var(--danger)', `first difference at ${escapeHtml(c.divergence.label)}`)
      : '',
  ]
    .filter(Boolean)
    .join('');
}

function renderCacheCost(c) {
  const cost = c.cost;
  const cells = [
    ['this turn', cost ? money(cost.actual) : '—', null],
    ['if nothing cached', cost ? money(cost.withoutCache) : '—', 'every cached token re-sent at full input price'],
    ['saved', cost ? `${Math.round(cost.savedPct * 100)}%` : '—', cost ? money(cost.saved) : null],
    ['written / read', `${compactNum(c.usage.write)} / ${compactNum(c.usage.read)}`, c.usage.write1h ? `${compactNum(c.usage.write1h)} at 1h TTL` : null],
  ];
  el('cache-cost').innerHTML = cells
    .map(
      ([label, value, sub]) => `
      <div class="min-w-0">
        <dt class="font-mono text-[10px] uppercase tracking-[0.12em] text-dim dark:text-dim-dk truncate">${escapeHtml(label)}</dt>
        <dd class="m-0 mt-2.5 text-[26px] font-semibold tracking-[-0.035em] tabular-nums leading-none">${value}</dd>
        ${sub ? `<div class="mt-2 font-mono text-[10.5px] text-dim dark:text-dim-dk">${escapeHtml(sub)}</div>` : ''}
      </div>`
    )
    .join('');
}

/* Per-turn cache behaviour only reads as good or bad against the session it sits
   in: one big write is the price of admission, twenty of them is a leak. */
function renderCacheSession() {
  const analysed = state.turns.map((t) => t.cache).filter(Boolean);
  const tally = analysed.reduce((acc, c) => {
    acc[c.verdict] = (acc[c.verdict] || 0) + 1;
    return acc;
  }, {});
  const actual = analysed.reduce((sum, c) => sum + (c.cost ? c.cost.actual : 0), 0);
  const uncached = analysed.reduce((sum, c) => sum + (c.cost ? c.cost.withoutCache : 0), 0);
  const rewritten = analysed.reduce((sum, c) => sum + (c.cause && c.cause.tokensInvalidated ? c.cause.tokensInvalidated : 0), 0);

  const counts = ['hit', 'partial', 'miss', 'cold']
    .filter((v) => tally[v])
    .map((v) => `${tally[v]} ${VERDICT_LABEL[v]}`)
    .join(' · ');

  el('cache-session').innerHTML = `
    <div class="flex flex-wrap items-baseline gap-x-7 gap-y-2 font-mono text-[11px] text-dim dark:text-dim-dk">
      <span>session ${counts || '—'}</span>
      <span>${money(actual)} spent, ${money(uncached)} without cache</span>
      ${rewritten ? `<span>≈${compactNum(rewritten)} tokens rewritten after a prefix change</span>` : ''}
    </div>`;
}

/* ---------------------------------------------------------- history chart */

/* Redraws the trend from scratch — Chart.js keeps a live handle on the canvas,
   so the old instance has to go before a new one can claim it. */
function renderHistory() {
  const points = mainChain();
  const side = state.turns.length - points.length;
  el('history-sub').textContent =
    `${points.length} turn${points.length === 1 ? '' : 's'} in session` +
    (side ? ` · ${side} side call${side === 1 ? '' : 's'} excluded` : '');
  if (historyChart) {
    historyChart.destroy();
    historyChart = null;
  }
  renderHistoryChart(points);
}

function renderHistoryChart(points) {
  const canvas = el('history-canvas');
  if (!canvas || typeof Chart === 'undefined') return;

  const turns = points.map((p) => p.turn);
  const labels = points.map((p) => `#${p.index + 1}`);
  const datasets = SERIES.map((s) => ({
    label: s.label,
    data: turns.map((t) => Number(usageOf(t)[s.key] || 0)),
    borderColor: s.color,
    backgroundColor: s.color + (DARK ? '2b' : '22'),
    pointBackgroundColor: s.color,
    pointBorderColor: THEME.panel,
    pointBorderWidth: 2,
    pointRadius: turns.length === 1 ? 3.5 : 0,
    pointHoverRadius: 4,
    borderWidth: 1.75,
    tension: 0.35,
    fill: true,
  }));

  historyChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: (_evt, items) => {
        const point = items.length && points[items[0].index];
        if (point) selectTurn(point.index);
      },
      plugins: {
        legend: {
          position: 'bottom',
          align: 'start',
          labels: {
            color: THEME.dim,
            font: { family: MONO, size: 10.5 },
            boxWidth: 8,
            boxHeight: 8,
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 18,
          },
        },
        tooltip: {
          backgroundColor: THEME.panel,
          titleColor: THEME.dim,
          bodyColor: THEME.ink,
          borderColor: THEME.edge,
          borderWidth: 1,
          padding: 11,
          cornerRadius: 9,
          displayColors: true,
          usePointStyle: true,
          titleFont: { family: MONO, size: 10 },
          bodyFont: { family: MONO, size: 11 },
          callbacks: {
            title: (items) => `turn ${items[0]?.label ?? ''}`,
            label: (item) => ` ${item.dataset.label}: ${compactNum(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: THEME.edge },
          ticks: { color: THEME.dim, font: { family: MONO, size: 9.5 }, maxRotation: 0, autoSkipPadding: 24 },
        },
        y: {
          beginAtZero: true,
          grid: { color: THEME.edge, drawTicks: false },
          border: { display: false },
          ticks: { color: THEME.dim, font: { family: MONO, size: 9.5 }, padding: 10, callback: (v) => compactNum(v) },
        },
      },
    },
  });
}

/* ------------------------------------------------------------ breakdown */

function groupSections(sections) {
  const groups = [
    { name: 'System prompt', match: (l) => l === 'system prompt', chars: 0, count: 0 },
    { name: 'Messages', match: (l) => l.startsWith('message['), chars: 0, count: 0 },
    { name: 'Tool definitions', match: (l) => l.startsWith('tool:'), chars: 0, count: 0 },
  ];
  for (const s of sections) {
    const g = groups.find((g) => g.match(s.label));
    if (g) {
      g.chars += s.chars;
      g.count += 1;
    }
  }
  return groups.filter((g) => g.count > 0);
}

function renderBreakdown(turn) {
  const breakdown = turn.breakdown;
  const barEl = el('composition-bar');
  const legendEl = el('composition-legend');
  const detailEl = el('breakdown-detail');

  el('breakdown-sub').textContent = breakdown ? `~${compactNum(breakdown.totalApproxTokens)} tok estimated from the request body` : '';

  if (!breakdown || !breakdown.sections.length) {
    barEl.innerHTML = '';
    legendEl.innerHTML = '';
    detailEl.innerHTML = '<p class="text-[12px] text-dim dark:text-dim-dk">No request body captured for this turn.</p>';
    return;
  }

  const groups = groupSections(breakdown.sections);
  const total = Math.max(1, groups.reduce((sum, g) => sum + g.chars, 0));

  barEl.innerHTML = groups
    .map((g) => {
      const color = GROUP_COLORS[g.name] || THEME.dim;
      const pct = (g.chars / total) * 100;
      return `<span class="comp-seg" style="width:${pct}%;background:${color}" title="${escapeHtml(g.name)} — ${pct.toFixed(
        1
      )}%"></span>`;
    })
    .join('');

  legendEl.innerHTML = groups
    .map((g) => {
      const color = GROUP_COLORS[g.name] || THEME.dim;
      const pct = (g.chars / total) * 100;
      return `
        <div class="min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-1.5 h-1.5 rounded-full inline-block shrink-0" style="background:${color}"></span>
            <span class="text-[12.5px] font-semibold truncate">${escapeHtml(g.name)}</span>
            <span class="ml-auto font-mono text-[11px] tabular-nums text-dim dark:text-dim-dk">${pct.toFixed(0)}%</span>
          </div>
          <div class="mt-2.5 text-[21px] font-semibold tracking-[-0.03em] tabular-nums leading-none">${compactNum(
            Math.round(g.chars / 4)
          )}<span class="ml-1 text-[11px] font-normal text-dim dark:text-dim-dk">tok</span></div>
          <div class="mt-1.5 font-mono text-[10.5px] text-dim dark:text-dim-dk">${g.count} item${g.count === 1 ? '' : 's'}</div>
        </div>`;
    })
    .join('');

  /* ---- expandable per-section list --------------------------------- */

  detailEl.innerHTML = '';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ghost-btn';
  toggle.innerHTML = `${state.breakdownOpen ? '▾' : '▸'}&nbsp; ${breakdown.sections.length} individual sections`;
  detailEl.appendChild(toggle);

  const panel = document.createElement('div');
  panel.className = `mt-5 ${state.breakdownOpen ? '' : 'hidden'}`;

  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.placeholder = 'Filter sections — e.g. "tool: Bash"';
  filterInput.value = state.breakdownFilter;
  filterInput.className =
    'w-full mb-5 px-3 py-2 rounded-lg border border-edge dark:border-edge-dk bg-panel dark:bg-panel-dk font-mono text-[11.5px] text-ink dark:text-ink-dk placeholder:text-dim dark:placeholder:text-dim-dk focus:outline-none focus:border-accent dark:focus:border-accent-dk';

  const rowsEl = document.createElement('div');
  rowsEl.className = 'flex flex-col gap-2 max-h-[420px] overflow-y-auto pr-2';

  function colorFor(label) {
    if (label === 'system prompt') return GROUP_COLORS['System prompt'];
    if (label.startsWith('tool:')) return GROUP_COLORS['Tool definitions'];
    return GROUP_COLORS.Messages;
  }

  function renderRows() {
    const sorted = [...breakdown.sections].sort((a, b) => b.chars - a.chars);
    const filter = state.breakdownFilter.toLowerCase();
    const filtered = filter ? sorted.filter((s) => s.label.toLowerCase().includes(filter)) : sorted;
    const maxChars = Math.max(1, ...sorted.map((s) => s.chars));

    rowsEl.innerHTML = '';
    if (!filtered.length) {
      rowsEl.innerHTML = '<p class="text-[11.5px] text-dim dark:text-dim-dk">No sections match.</p>';
      return;
    }
    for (const s of filtered) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'section-row min-w-0';
      row.innerHTML = `
        <div class="flex items-baseline gap-3 mb-1.5 min-w-0">
          <span class="font-mono text-[11px] text-dim dark:text-dim-dk truncate" title="${escapeHtml(s.label)}">${escapeHtml(
        s.label
      )}</span>
          <span class="ml-auto font-mono text-[11px] tabular-nums whitespace-nowrap">${compactNum(s.approxTokens)} tok</span>
          <span class="row-chevron font-mono text-[11px] text-accent dark:text-accent-dk">›</span>
        </div>
        <div class="meter"><span style="width:${(s.chars / maxChars) * 100}%;background:${colorFor(s.label)}"></span></div>`;
      row.onclick = () => openDrawer(s, breakdown);
      rowsEl.appendChild(row);
    }
  }
  renderRows();

  filterInput.oninput = () => {
    state.breakdownFilter = filterInput.value;
    renderRows();
  };

  panel.append(filterInput, rowsEl);
  detailEl.appendChild(panel);

  toggle.onclick = () => {
    state.breakdownOpen = !state.breakdownOpen;
    toggle.innerHTML = `${state.breakdownOpen ? '▾' : '▸'}&nbsp; ${breakdown.sections.length} individual sections`;
    panel.classList.toggle('hidden', !state.breakdownOpen);
  };
}

/* ------------------------------------------------------ section drawer */

/* Sections only carry a label + size. Everything worth reading — a tool's
   description and schema, a message's content blocks — lives in the captured
   request, so resolve back into it. `kind`/`index` come from newer captures;
   older ones fall back to parsing the label. */
function resolveSection(section) {
  const req = (state.turns[state.turnIndex] || {}).request || {};
  const label = section.label;
  let kind = section.kind;
  let index = section.index;

  if (!kind) {
    if (label === 'system prompt') kind = 'system';
    else if (/^message\[(\d+)\]/.test(label)) {
      kind = 'message';
      index = Number(label.match(/^message\[(\d+)\]/)[1]);
    } else if (label.startsWith('tool: ')) kind = 'tool';
  }

  if (kind === 'system') return { kind, data: req.system };
  if (kind === 'message') return { kind, index, data: (req.messages || [])[index] };
  if (kind === 'tool') {
    const tools = req.tools || [];
    const name = label.startsWith('tool: ') ? label.slice(6) : null;
    const data = tools[index] && (!name || (tools[index].name || '(unnamed)') === name)
      ? tools[index]
      : tools.find((t) => (t.name || '(unnamed)') === name);
    return { kind, data };
  }
  return { kind: 'unknown', data: null };
}

function block(title, node, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'min-w-0';

  const head = document.createElement('div');
  head.className = 'flex items-center gap-3 mb-2.5';
  head.innerHTML = `<span class="label-eyebrow">${escapeHtml(title)}</span>`;

  const right = document.createElement('div');
  right.className = 'ml-auto flex items-center gap-1.5';
  head.appendChild(right);

  if (opts.chips) {
    for (const c of opts.chips) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      if (c.tone) chip.dataset.tone = c.tone;
      chip.textContent = c.text;
      right.appendChild(chip);
    }
  }
  if (opts.copy != null) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost-btn';
    btn.textContent = 'Copy';
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(opts.copy);
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1400);
      } catch {
        btn.textContent = 'Failed';
        setTimeout(() => (btn.textContent = 'Copy'), 1400);
      }
    };
    right.appendChild(btn);
  }

  wrap.append(head, node);
  return wrap;
}

function textPanel(text, { clamp = false } = {}) {
  const box = document.createElement('div');
  box.className = `prose-block${clamp ? ' is-clamped' : ''}`;
  const pre = document.createElement('pre');
  pre.textContent = text;
  box.appendChild(pre);

  if (clamp) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ghost-btn w-full rounded-none border-x-0 border-b-0';
    more.textContent = 'Show full text';
    more.onclick = () => {
      box.classList.remove('is-clamped');
      more.remove();
    };
    box.appendChild(more);
  }
  return box;
}

function jsonPanel(value) {
  const box = document.createElement('div');
  box.className = 'json-view prose-block font-mono text-[11.5px] leading-[1.7] p-4 max-h-[340px] overflow-auto';
  box.appendChild(jsonNode(value, true));
  return box;
}

function textOf(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function charsOf(value) {
  if (value == null) return 0;
  return typeof value === 'string' ? value.length : JSON.stringify(value).length;
}

function renderToolDetail(body, tool) {
  if (tool.description) {
    body.appendChild(
      block('Description', textPanel(tool.description, { clamp: tool.description.length > 900 }), {
        chips: [{ text: `${compactNum(Math.round(tool.description.length / 4))} tok` }],
        copy: tool.description,
      })
    );
  }

  const schema = tool.input_schema || {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const names = Object.keys(props);

  if (names.length) {
    const list = document.createElement('div');
    list.className = 'flex flex-col divide-y divide-edge dark:divide-edge-dk border border-edge dark:border-edge-dk rounded-xl overflow-hidden';
    for (const name of names) {
      const p = props[name] || {};
      const type = p.type || (p.enum ? 'enum' : p.anyOf ? 'anyOf' : p.oneOf ? 'oneOf' : '—');
      const rowNode = document.createElement('div');
      rowNode.className = 'px-4 py-3';
      rowNode.innerHTML = `
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-mono text-[12px] font-semibold">${escapeHtml(name)}</span>
          <span class="chip">${escapeHtml(Array.isArray(type) ? type.join(' | ') : String(type))}</span>
          ${required.has(name) ? '<span class="chip" data-tone="accent">required</span>' : ''}
        </div>
        ${
          p.description
            ? `<p class="mt-1.5 text-[11.5px] leading-relaxed text-dim dark:text-dim-dk">${escapeHtml(
                String(p.description).slice(0, 400)
              )}${String(p.description).length > 400 ? '…' : ''}</p>`
            : ''
        }`;
      list.appendChild(rowNode);
    }
    body.appendChild(
      block('Parameters', list, {
        chips: [{ text: `${names.length} · ${required.size} required` }],
      })
    );
  }

  body.appendChild(
    block('Input schema', jsonPanel(schema), {
      chips: [{ text: `${compactNum(Math.round(charsOf(schema) / 4))} tok` }],
      copy: JSON.stringify(schema, null, 2),
    })
  );
}

function renderContentBlocks(body, content, title) {
  if (content == null) {
    body.appendChild(block(title, textPanel('(empty)')));
    return;
  }
  if (typeof content === 'string') {
    body.appendChild(
      block(title, textPanel(content, { clamp: content.length > 1200 }), {
        chips: [{ text: `${compactNum(Math.round(content.length / 4))} tok` }],
        copy: content,
      })
    );
    return;
  }
  const blocks = Array.isArray(content) ? content : [content];
  blocks.forEach((b, i) => {
    const type = (b && b.type) || 'unknown';
    const chips = [{ text: type, tone: type === 'tool_use' ? 'accent' : type === 'tool_result' ? 'signal' : undefined }];
    if (b && b.cache_control) chips.push({ text: `cache: ${b.cache_control.type || 'on'}`, tone: 'signal' });
    if (b && b.is_error) chips.push({ text: 'error', tone: 'accent' });
    chips.push({ text: `${compactNum(Math.round(charsOf(b) / 4))} tok` });

    let node;
    if (type === 'text' || type === 'thinking') {
      const t = b.text || b.thinking || '';
      node = textPanel(t, { clamp: t.length > 1200 });
    } else if (type === 'tool_use') {
      const wrap = document.createElement('div');
      wrap.className = 'flex flex-col gap-2';
      wrap.innerHTML = `<div class="font-mono text-[12px] font-semibold">${escapeHtml(b.name || '(unnamed)')}</div>`;
      wrap.appendChild(jsonPanel(b.input ?? {}));
      node = wrap;
    } else if (type === 'tool_result') {
      const wrap = document.createElement('div');
      wrap.className = 'flex flex-col gap-2';
      if (b.tool_use_id) {
        wrap.innerHTML = `<div class="font-mono text-[10.5px] text-dim dark:text-dim-dk">for ${escapeHtml(b.tool_use_id)}</div>`;
      }
      const inner = b.content;
      const flat =
        typeof inner === 'string'
          ? inner
          : Array.isArray(inner)
          ? inner.map((x) => (x && x.type === 'text' ? x.text : textOf(x))).join('\n')
          : textOf(inner);
      wrap.appendChild(textPanel(flat, { clamp: flat.length > 1200 }));
      node = wrap;
    } else {
      node = jsonPanel(b);
    }

    body.appendChild(block(`${title} · block[${i}]`, node, { chips, copy: textOf(b) }));
  });
}

function openDrawer(section, breakdown) {
  const drawer = el('drawer');
  const resolved = resolveSection(section);
  const body = el('drawer-body');

  el('drawer-kind').textContent =
    resolved.kind === 'tool' ? 'Tool definition' : resolved.kind === 'system' ? 'System prompt' : resolved.kind === 'message' ? 'Message' : 'Section';
  el('drawer-title').textContent = section.label;

  const share = breakdown && breakdown.totalChars ? (section.chars / breakdown.totalChars) * 100 : 0;
  el('drawer-stats').innerHTML = [
    ['approx tokens', compactNum(section.approxTokens)],
    ['characters', compactNum(section.chars)],
    ['of request', `${share < 1 ? share.toFixed(1) : Math.round(share)}%`],
  ]
    .map(([k, v]) => `<div class="drawer-stat"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join('');

  body.innerHTML = '';

  if (!resolved.data) {
    body.appendChild(textPanel('This section could not be resolved back to the captured request body.'));
  } else if (resolved.kind === 'tool') {
    renderToolDetail(body, resolved.data);
  } else if (resolved.kind === 'system') {
    renderContentBlocks(body, resolved.data, 'System');
  } else if (resolved.kind === 'message') {
    const msg = resolved.data;
    const roleRow = document.createElement('div');
    roleRow.className = 'flex items-center gap-2';
    roleRow.innerHTML = `<span class="chip" data-tone="accent">${escapeHtml(msg.role || 'unknown')}</span>
      <span class="chip">${Array.isArray(msg.content) ? msg.content.length : 1} block${
      Array.isArray(msg.content) && msg.content.length !== 1 ? 's' : ''
    }</span>`;
    body.appendChild(roleRow);
    renderContentBlocks(body, msg.content, 'Content');
  }

  body.scrollTop = 0;
  drawer.hidden = false;
  el('drawer-backdrop').hidden = false;
  el('drawer-close').focus();
}

function closeDrawer() {
  el('drawer').hidden = true;
  el('drawer-backdrop').hidden = true;
}

function isDrawerOpen() {
  return !el('drawer').hidden;
}

el('drawer-close').onclick = closeDrawer;
el('drawer-backdrop').onclick = closeDrawer;

/* ----------------------------------------------------------------- json */

function renderJson(container, value) {
  container.innerHTML = '';
  container.appendChild(jsonNode(value, true));
}

function jsonNode(value, open) {
  if (value === null || value === undefined) {
    const span = document.createElement('span');
    span.className = 'text-dim dark:text-dim-dk italic';
    span.textContent = 'null';
    return span;
  }
  if (typeof value === 'string') {
    const span = document.createElement('span');
    span.className = 'text-signal dark:text-signal-dk';
    span.textContent = JSON.stringify(value);
    return span;
  }
  if (typeof value === 'number') {
    const span = document.createElement('span');
    span.className = 'text-accent dark:text-accent-dk';
    span.textContent = String(value);
    return span;
  }
  if (typeof value === 'boolean') {
    const span = document.createElement('span');
    span.className = 'text-dim dark:text-dim-dk font-semibold';
    span.textContent = String(value);
    return span;
  }
  if (Array.isArray(value)) {
    return collapsible(`Array(${value.length})`, value.map((v, i) => [String(i), v]), open);
  }
  if (typeof value === 'object') {
    return collapsible('Object', Object.entries(value), open);
  }
  const span = document.createElement('span');
  span.textContent = String(value);
  return span;
}

function collapsible(summaryText, entries, open) {
  const details = document.createElement('details');
  if (open) details.open = true;
  const summary = document.createElement('summary');
  summary.className = 'text-dim dark:text-dim-dk';
  summary.textContent = summaryText;
  details.appendChild(summary);
  for (const [k, v] of entries) {
    const row = document.createElement('div');
    row.className = 'py-px';
    const keySpan = document.createElement('span');
    keySpan.className = 'text-ink dark:text-ink-dk font-semibold';
    keySpan.textContent = `${k}: `;
    row.appendChild(keySpan);
    row.appendChild(jsonNode(v, false));
    details.appendChild(row);
  }
  return details;
}

/* ------------------------------------------------------------- keyboard */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isDrawerOpen()) {
    closeDrawer();
    return;
  }
  if (e.target instanceof HTMLInputElement || isDrawerOpen()) return;
  if (e.key === 'ArrowLeft' || e.key === 'k') selectTurn(state.turnIndex - 1);
  if (e.key === 'ArrowRight' || e.key === 'j') selectTurn(state.turnIndex + 1);
});

/* ------------------------------------------------------------------- SSE */

function connectLive() {
  const src = new EventSource('/api/events');
  src.onopen = () => {
    el('live-dot').classList.add('bg-signal', 'dark:bg-signal-dk', 'live-dot-on');
    el('live-dot').classList.remove('bg-dim', 'dark:bg-dim-dk');
    el('live-label').textContent = 'live';
  };
  src.onerror = () => {
    el('live-dot').classList.remove('bg-signal', 'dark:bg-signal-dk', 'live-dot-on');
    el('live-dot').classList.add('bg-dim', 'dark:bg-dim-dk');
    el('live-label').textContent = 'reconnecting';
  };
  src.onmessage = (evt) => {
    const turn = JSON.parse(evt.data);
    let session = state.sessions.find((s) => s.sessionId === turn.sessionId);
    if (!session) {
      session = { sessionId: turn.sessionId, turnCount: 0, lastActiveAt: null };
      state.sessions.unshift(session);
    }
    session.turnCount += 1;
    session.lastActiveAt = turn.timestamp;

    if (turn.sessionId === state.sessionId) {
      state.turns.push(turn);
      scheduleToolRefresh(turn.sessionId);
      if (state.pinned) {
        renderLiveTail();
      } else {
        state.turnIndex = state.turns.length - 1;
        renderDetail();
      }
    }
    renderSessionList();
    refreshTurnCount();
  };
}

async function refreshTurnCount() {
  const health = await fetchJson('/api/health');
  el('turn-count').textContent = health.capturedTurns;
}

/* An armed delete disarms as soon as attention moves elsewhere, so a card is
   never left one stray click away from losing its capture. */
document.addEventListener('click', (ev) => {
  if (!state.pendingDelete && !state.deleteError) return;
  if (ev.target.closest('.session-del')) return;
  state.pendingDelete = null;
  state.deleteError = null;
  renderSessionList();
});

renderDetail();
loadSessions();
connectLive();
refreshTurnCount();
