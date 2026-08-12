# claude-insight-monitor

A local proxy that sits between Claude Code and the Anthropic API, records every
request, and then explains it: what was in the context window, why the cache
behaved the way it did, which of those requests were not the conversation at all,
and what each part of it cost.

Nothing is sent anywhere. The proxy forwards to the real API and keeps a copy on
disk under `~/.cmon/captures/`.

---

## What it's for

Claude Code shows you a conversation. What it sends is something else: a prompt
rebuilt from scratch on every turn, most of it identical to the last one, some of
it edited underneath you, and over a third of the requests not part of the
conversation at all. The bill and the context window are both consequences of
that — and neither the CLI nor the API tells you which part of it did what.

`usage` is the clearest example. It reports that a turn re-wrote 40,000 tokens.
It does not report *why*, and why is the half you can act on: a rewrite caused by
a changed system block is a bug you can fix, one caused by an expired cache TTL
is not. Everything here exists to close that kind of gap.

Concretely, in one real 118-turn session it found:

- **58 of 59 tool definitions were never called** — 34.9K tokens re-sent on every
  turn, about half of what the session spent on prompts.
- **43 of the 118 requests were shell-command security classifiers**, not the
  conversation at all — invisible in the CLI and in the bill.
- **26% of the message history was thinking signatures** — bytes nobody can read,
  replayed on every subsequent turn.
- **28% of the system prompt** was browser-automation instructions, in a session
  that never opened a browser.
- Cache spend of **$6.97 against $44.16 without caching** — and the 21 turns where
  the cache broke early, each traced to the exact block that changed.

None of those numbers are visible anywhere else, and each one is something you
can do something about.

---

## Install

```sh
git clone <this repo> && cd claude-insight-monitor
npm link          # symlinks `cmon` onto your PATH
```

`npm link` points at the working copy, so edits take effect immediately. For a
fixed snapshot instead, use `npm install -g .`. To remove it: `npm unlink -g claude-insight-monitor`.

No dependencies — Node's standard library only.

---

## Quick start

Two terminals. In the first:

```sh
cmon
```

It brings the proxy up, writes `ANTHROPIC_BASE_URL` into `~/.claude/settings.json`,
and waits. In the second terminal, just run `claude` — no export needed. Open
<http://localhost:8787> to watch the context fill up live.

When you're done, press **Enter** in the first terminal. The proxy stops and the
settings key is removed.

That is the whole interface. There are no subcommands and no flags to remember.

---

## What to do with it

The page is organised by mechanism; the questions people actually arrive with cut
across it. Start here.

### "Where is my money going?"

Open the session and read three cards in order. **Where the calls go** splits the
spend by what each request actually was — background classifiers and subagents
usually surprise people. **Cache** shows the session total against what it would
have cost with no caching, so you know whether the caching is working at all.
**Tool definitions** shows how much of every prompt is tool schemas you never use.

### "Why is my cache always cold?"

Step through turns and watch the **Cache** card's verdict. A run of *partial hit*
means something inside the cached region keeps changing — the card names the
block. Common culprits are a timestamp or a rewritten mid-conversation `system`
message. If the verdict is *miss* with the prefix unchanged, it will say so and
point at the TTL instead. **Inside the system prompt** flags any prompt section
that changed mid-session, which ends the cached prefix at that turn.

### "Which tools can I turn off?"

**Tool definitions** ranks every tool by what its definition costs and marks the
ones never called. To find out whether removing them would actually have changed
the answer, use **Time machine → Replay** with tools set to *only the ones ever
called*, and compare the stop reason and the tool calls — not just the price.

### "Why did that turn take so long?"

**Over the wire** splits latency into the wait before the first byte (queueing and
prompt processing) and the generation that follows. A long first half with a
normal second half is not a slow model. The same card shows whether the SDK
already retried the request without telling anyone, and how much rate-limit
budget is left.

### "How much did that subagent really cost?"

**Threads** lists the conversation and each subagent separately, with what each
spent and — inferred from ordering — which call spawned it and how many tokens it
handed back. The ratio between those two is the point.

### "Am I about to run out of context?"

Under **History over time**: how fast the window is filling and how many turns of
headroom that leaves at the current rate. The same footer lists every turn where
the transcript was edited rather than appended to, which is where tokens quietly
disappear from what the model can see.

### "This turn went wrong — let me reproduce it"

**Copy as curl** on the Raw JSON card gives you the exact request as a runnable
command, with your key left as `$ANTHROPIC_API_KEY`. **Copy request** gives the
body alone as a fixture.

### "Are these token numbers real?"

Mostly they are estimates (`chars / 4`), and the card says so. **Measure exactly**
replaces them with real counts from `count_tokens` and tells you how far off the
estimate was, which calibrates every other number on the page.

> Two actions send real requests and spend quota — **Measure exactly** and
> **Replay**. Both are explicit clicks, never automatic, and both say what they
> will do before you press them. Everything else on the page is read from
> captures already on disk.

---

## The command

One command, no arguments: `cmon`. It starts the proxy, points Claude Code at
it, prints the UI link, and waits.

Everything it did is undone when it ends, and every way of ending it counts:
**Enter**, **Ctrl-C**, closing the terminal window (`SIGHUP`), or `kill`
(`SIGTERM`). Each one removes the `settings.json` key and stops the proxy.
Captures are kept.

`kill -9` is the one signal a process cannot catch, so it leaves the key behind.
The next `cmon` notices and removes it before doing anything else — a stale key
would otherwise point every later `claude` at a dead proxy.

The port is chosen for you: `8787`, or the next free one above it if something
already holds it. If `settings.json` already holds an `ANTHROPIC_BASE_URL` you
set yourself, `cmon` leaves it alone and hands you an `export` line instead.

### Environment

| Variable | Meaning |
| --- | --- |
| `CMON_HOME` | Where the pid file, log and captures live. Default `~/.cmon`. Set it per project if you want separate stores. |
| `CMON_PORT` | Port for the proxy process itself; set for you by `cmon`. |
| `CMON_HOST` | Bind address. Default `127.0.0.1` — set `0.0.0.0` only if you deliberately want it reachable from the network. |
| `ANTHROPIC_API_KEY` | Optional, and only used by **Measure exactly** and **Replay**. When set, the proxy never reuses Claude Code's own credential for them. |

---

## How Claude Code gets pointed at the proxy

Claude Code needs `ANTHROPIC_BASE_URL` to reach the proxy, and there is no way
for one process to change another terminal's environment — env is copied into a
process at birth and never written back. So `cmon` writes the variable into the
`env` block of `~/.claude/settings.json`, which Claude Code reads at startup.
That reaches every `claude` you launch afterwards, in any terminal, with no
export: the closest thing to a global switch, and the reason the second terminal
needs nothing but `claude`.

The cost of a global switch is that it outlives the process that set it, which
is what the safeguards below are for.

### Why a stale key is dangerous, and what stops it

A leftover `ANTHROPIC_BASE_URL` in `settings.json` points every future `claude`
at a proxy that is no longer listening, and the failure looks like a broken API
key. Three safeguards:

1. **Journalled writes.** Every value written is recorded in
   `~/.cmon/settings-patch.json`. Reverting removes only that exact value.
2. **Your own value is never touched.** If `settings.json` already sets
   `ANTHROPIC_BASE_URL`, `cmon` says so and falls back to the export line.
3. **Self-repair on startup.** If our key is still there while the proxy is down,
   the next `cmon` removes it before starting anything. So a `kill -9` or a
   reboot cannot strand it past the next run.

---

# Part I — The UI

<http://localhost:8787> — one page, live over SSE. A card with nothing to say for
a given turn hides itself rather than showing zeroes.

### Always on screen

- **Sessions rail** — every captured session, newest first. Deleting one takes
  two clicks, so a stray click can never drop a capture.
- **Turn ribbon** — one bar per turn, height = context tokens. Background calls
  are drawn as outlines so the eye follows the agent loop. Click to jump;
  `←`/`→` (or `j`/`k`) also work. The line above it names the turn's model, what
  kind of call it is, the entrypoint (`cli` / `sdk-cli`) and any HTTP error.

### The cards

| Card | What it shows | Layer |
| --- | --- | --- |
| **Context window** | A ring: how full the window is, split by input / cache read / cache write, against the model's real limit (1M variants are detected from the beta header). Below it, the four real usage numbers. | — |
| **Where the calls go** | Every request in the session sorted into what it actually is, with its share of the spend. | [2](#2--what-the-calls-actually-are) |
| **Threads** | The session split into the conversation and each subagent: what each spent, what it handed back. Hidden when there is one thread. | [9](#9--threads) |
| **Cache** | Why the cache behaved as it did: a verdict, the prefix drawn in token space with its breakpoints and the exact point where it stopped matching, the turn's cost, and its no-cache counterfactual. | [1](#1--cache-forensics) |
| **Over the wire** | Time to first byte vs generating time, tokens/sec, bytes, silent SDK retries, failures with their reason, remaining rate-limit budget. | [7](#7--over-the-wire) |
| **Thinking** | How much of the output was reasoning, the order the blocks came back in, and what replaying their signatures costs. | [6](#6--the-thinking-layer) |
| **History over time** | Every turn's usage as a stacked area chart, plus how fast the window is filling, how many turns of headroom that leaves, and every turn whose transcript was edited rather than appended to — click one to jump there. | [3](#3--what-happened-to-the-history) |
| **What fills the window** | System prompt vs messages vs tool definitions as a proportion bar, then every individual section ranked by size. Click any section for an inspector with the full text, a tool's parameters and raw schema, or a message's content blocks with their cache markers and per-block counts — each with a copy button. **Measure exactly** replaces the estimates with real counts. | [8](#8--measuring-instead-of-estimating) |
| **Tool definitions** | Every tool, what its definition costs, how often the model actually called it, and how much came back as results. | [5](#5--what-the-tool-list-costs) |
| **Inside the system prompt** | The fixed instructions split into their own sections and ranked, plus the `<system-reminder>` blocks injected into the messages. | [4](#4--inside-the-system-prompt) |
| **Time machine** | Compare this turn against any other turn of the same kind, and send it again with the tool list trimmed, the system prompt dropped, or a different model — then read the two side by side. | [10](#10--the-time-machine) |
| **Raw JSON** | The complete captured request and response, collapsible, plus **Copy as curl** and **Copy request** to reproduce the turn outside the harness. | [10](#10--the-time-machine) |

Token figures in the breakdown are estimates (`chars / 4`) — the API only reports
usage in aggregate. The four numbers under the ring are the real ones, and
**Measure exactly** turns the estimates into measurements.

### HTTP API

Everything the page draws is available directly.

| Endpoint | Returns |
| --- | --- |
| `GET /api/sessions` | Every session with its turn count and last activity. |
| `GET /api/sessions/<id>/turns` | Every turn, each annotated with `breakdown`, `call`, `cache`, `history`, `prompt`, `thinking` and `network`. |
| `GET /api/sessions/<id>/tools` | Session-wide tool economics (layer 5). |
| `GET /api/sessions/<id>/topology` | The session's threads (layer 9). |
| `GET /api/sessions/<id>/diff?a=<n>&b=<n>` | Structured diff between any two turns (layer 10). |
| `POST /api/sessions/<id>/turns/<n>/replay` | Re-sends that turn with changes (layer 10). Spends quota; never recorded. |
| `POST /api/sessions/<id>/turns/<n>/count` | Measures that turn exactly (layer 8). Spends quota; cached after the first call. |
| `GET /api/events` | SSE: one annotated turn per event, live. |
| `GET /api/health` | Liveness and total captured turns. |
| `DELETE /api/sessions/<id>` | Drops a capture. |

---

# Part II — What it captures

Before anything can be explained it has to be recorded, and the interesting parts
of an exchange are not all in the request body.

One JSONL line per exchange (`schema: 2`), request and response kept whole, plus:

| Field | Contents | Why it matters |
| --- | --- | --- |
| `endpoint` | Method, path, and `kind`: `messages` or `count_tokens`. | Claude Code sizes the window before it sends; without the path those calls are indistinguishable from real ones. |
| `client` | `claude-cli` version from the user agent, auth type (`oauth` / `api-key`), SDK retry count, `x-stainless-*` runtime fingerprint. | The retry count is the only trace a silently-retried request leaves. |
| `request` | Beyond model/system/messages/tools: `thinking`, `output_config` (effort, task budgets), `tool_choice`, `stop_sequences`, `metadata`, `context_management`, sampling params, and `betas` parsed into a list. | These decide how a turn is sampled and how much of the window survives it; none are recoverable from the response. |
| `response` | Message id, content, stop reason, usage, and `error` — including the error event a stream can emit *after* a 200 — plus the full body for anything that isn't a plain Messages reply. | A captured 429 used to record an empty object. |
| `response.headers` | `request-id`, every `anthropic-ratelimit-*`, `retry-after`. | Correlation with Anthropic's own logs, and the account's remaining quota. |
| `timing` | `ttfbMs`, `durationMs`. | Latency has two halves that mean different things. |
| `bytes` | Request and response sizes on the wire. | |

Streams also accumulate `thinking` and `signature` deltas, which were previously
dropped on the floor.

**Credentials are never written.** `authorization`, `x-api-key`, `cookie` and
`set-cookie` are dropped *before* the record is built, not redacted afterwards.
The one place a credential is held at all is described in
[layer 8](#8--measuring-instead-of-estimating).

Captures written before this schema still load; they simply lack the new fields,
and the cards that depend on them hide rather than showing zeroes.

---

# Part III — The ten layers

Each layer answers one question the raw capture cannot.

| # | Layer | The question it answers |
| --- | --- | --- |
| [1](#1--cache-forensics) | Cache forensics | The cache rewrote 40K tokens — *why*, and what did that cost? |
| [2](#2--what-the-calls-actually-are) | Call classification | Which of these requests are the conversation, and which are not? |
| [3](#3--what-happened-to-the-history) | History diffing | Did the transcript grow, or did something edit it underneath the model? |
| [4](#4--inside-the-system-prompt) | Prompt anatomy | The system prompt is 3.6K tokens — of what? |
| [5](#5--what-the-tool-list-costs) | Tool economics | What does the tool list cost, against what it is used for? |
| [6](#6--the-thinking-layer) | Thinking | How much of the output was reasoning rather than the answer? |
| [7](#7--over-the-wire) | Network | Was it slow to start or slow to speak — and how much quota is left? |
| [8](#8--measuring-instead-of-estimating) | Exact counting | How wrong is `chars / 4`? |
| [9](#9--threads) | Topology | What did each subagent spend, and what did it hand back? |
| [10](#10--the-time-machine) | Time machine | What accumulated between two turns — and what would have happened if it had been sent differently? |

Figures below come from two real captured sessions — 118 turns of the Claude Code
CLI, and one Agent SDK turn — unless a section says otherwise.

---

## 1 · Cache forensics

**What it's for.** `usage` tells you a turn re-wrote 40K tokens. It never tells
you why, and "why" is the half you can act on: a rewrite caused by a changed
system block is a bug you can fix, one caused by an expired TTL is not.

**How it works.** Each request is reconstructed as the prefix the API actually
matches on — tools, then system, then messages, one unit per content block. Each
unit is hashed and compared against the previous turn *of the same conversation*.
The first unit whose bytes differ is where the cache stopped being reusable.

Two details separate signal from noise:

- `cache_control` is excluded from the hashes. It marks content rather than being
  content; hashing it made the rolling breakpoint read as an edit to both the
  block it left and the block it landed on, on every single turn.
- Only a difference *before* the last breakpoint costs anything. Past it the
  bytes were never cached, so a changed tail is the conversation moving on, not a
  miss.

| Verdict | Meaning |
| --- | --- |
| prefix hit | Everything the previous turn had cached was byte-identical. |
| partial hit | Something inside the cached region changed; the tokens after it were written again. |
| miss | Nothing was reused — attributed to a prefix change, an expired TTL, or (prefix unchanged, TTL not up) eviction upstream. |
| cold start | First turn of this conversation. |

**Cost.** List prices with the cache multipliers — writes 1.25× at the 5-minute
TTL, 2× at the hour, reads 0.1× — shown against the counterfactual of no cache at
all. A large `cache_creation` number is only wasteful if nothing reads it, and
that comparison is the only honest way to tell which it was. A model missing from
the price table shows no cost rather than a wrong one.

**Found in the captures.** 94 prefix hits, 21 partial hits, 1 miss, 2 cold
starts. **$6.97 spent against $44.16 without caching.** The partial hits were
almost all Claude Code rewriting a mid-conversation `system` message in place —
about 112 tokens each, landing inside the cached prefix.

---

## 2 · What the calls actually are

**What it's for.** One session id is not one conversation. Claude Code
multiplexes the agent loop, its subagents, and a fleet of short background calls
onto the same id. Averaged into one chart they read as the context window
collapsing and refilling; averaged into one bill they are invisible.

**How it works.** Every request is sorted by what it sends — signals on the wire,
not guesses:

| Kind | Recognised by |
| --- | --- |
| agent loop | Tool definitions present — the conversation whose window the UI tracks. |
| subagent | An `x-claude-code-agent-id` header; its own context window. |
| bash security check | A system prompt opening "You are a security monitor for autonomous AI coding agents". |
| session title | The title-generation prompt, run once to name the session for the resume list. |
| compaction | A toolless call asking for a summary of the conversation. |
| quota probe | A one-token request whose entire body is the word `quota` — the startup reachability check. |
| token count | A `/v1/messages/count_tokens` call. |
| utility call | Anything else with no tools. Its opening line is kept, so an unrecognised kind stays identifiable rather than being silently bucketed. |

The ribbon and the trend chart follow this classification instead of the
has-no-tools heuristic they used before.

**Found in the captures.** Of 118 requests: 73 agent loop, **43 bash security
checks**, 1 session title, 1 quota probe (which got a 429). The background calls
were 38% of the requests and 11% of the spend — 2.8M input tokens.

**Also on the wire.** Claude Code prepends its own billing header as the first
system block (`cc_version=2.1.226.06d; cc_entrypoint=cli;`), so every capture
records the CLI build that produced it and whether it came from the terminal
(`cli`) or the Agent SDK (`sdk-cli`).

---

## 3 · What happened to the history

**What it's for.** A conversation is supposed to grow by appending. Anything else
is the harness editing the transcript underneath the model — and none of it shows
up in the usage numbers, because a rewritten message costs exactly what the one
it replaced did.

**How it works.** Each turn's message list is compared with the previous turn's
and the change is named:

| Shape | What it means |
| --- | --- |
| append | Only new messages. The normal case. |
| edit | A message already there came back different — rewritten, shortened, or a tool result cleared to reclaim room. |
| branch | The list got shorter after a common prefix: an earlier state replayed. |
| compaction | Most of the history is gone and the tokens collapsed with it — a summary standing in for what was there. |
| reset | Nothing survived. |

Only conversations are reported. A background classifier's single message growing
between calls is how those calls work, not an edited transcript, and there are
enough of them to bury the real ones.

The trend chart's footer carries the other half: how fast the window is filling,
and how many turns of headroom that leaves at the current rate.

**Found in the captures.** No compaction, no branches. What did happen, on 21
turns, was a mid-conversation `system` message being rewritten or an earlier user
message shortened in place — ≈290 tokens the model can no longer see, every one of
them inside the cached prefix, which is exactly what layer 1 reports from the
other side.

---

## 4 · Inside the system prompt

**What it's for.** "System prompt: 3.6K tokens" is a number you can do nothing
with. The prompt is a stack of independently-sourced pieces, each present because
something is switched on. Sizing them separately turns the number into a decision
about what to turn off.

**How it works.** The prompt is split on its own markdown headings — the seams its
authors intended — and each section sized. Sections are also compared turn to
turn, because a prompt that changes mid-session changes behaviour *and* ends the
cached prefix there, silently on both counts.

`<system-reminder>` blocks get their own layer. They are injected into user
messages rather than the system prompt, so they read as conversation and are
billed as conversation, and they are neither.

**Found in the captures.** `Claude in Chrome browser automation` is **28% of the
system prompt** — 1K tokens on every turn, in a session that never opened a
browser. And the bulky instructions turn out not to live in the system prompt at
all: in the Agent SDK session, the reminder layer carries a **2.0K-token
agent-type catalogue** and a **1.5K-token skill catalogue**. Neither session
changed its prompt mid-flight, and the card says so plainly rather than inventing
a finding.

---

## 5 · What the tool list costs

**What it's for.** Tool definitions render at the very front of the prompt, so
all of them are re-sent on every turn whether the model ever calls them or not.
That makes an unused tool a fixed line item, not a harmless extra — and because
they sit ahead of everything else, adding or removing one invalidates the whole
cache.

**How it works.** Per tool: what its definition costs, how many turns carried it,
how many times the model called it, and how many tokens came back as results.
Tool-list changes are listed too, since each one ends the cached prefix at its
turn.

The bill is **attributed rather than assumed**. Definitions are served from cache
after the first turn, so charging them at full input price would be wrong by an
order of magnitude; instead each turn's real prompt spend is split by the share of
the prompt the definitions occupy.

**Found in the captures.** 59 tools, 34.9K tokens of definitions, and **58 of them
were never called** — 98% of the definition bytes, re-sent on all 73 turns. The
one that was, `Bash`, has a 613-token definition and returned 16.3K tokens of
results. On the attribution above, definitions account for **≈$2.76 of the $5.84**
that session spent on prompts. The list never changed, so it stayed cacheable
throughout.

Served from `/api/sessions/<id>/tools`, because it is one fact about a whole
session rather than a property of a turn.

---

## 6 · The thinking layer

**What it's for.** Thinking is billed as output but is not the answer, so a
turn's output count says nothing about how much of it anyone reads.

**How it works.** Per turn: thinking tokens against output tokens, the order the
response blocks came back in, and the state of the blocks themselves. Per session:
how many turns thought at all, and what the accumulated signatures cost to replay.

**Found in the captures.**

- **32% of all output tokens were thinking** (14.6K of 45.2K). Adaptive thinking
  chose per turn: 42 of 73 conversation turns thought, 31 answered directly.
- The blocks come back with an **empty `thinking` string and a long signature** —
  the raw reasoning is never returned. That is visible twice over: in the
  response, and in what Claude Code echoes back on the next turn.
- The signature is what keeps costing. Every thinking block is replayed into every
  later request for the rest of the conversation; by the end of the session 39 of
  them carried **59,520 characters, about 26% of the entire message history**, of
  bytes nobody can read.
- 37 turns ran `thinking → tool call`: interleaved thinking, the model reasoning
  between tool calls rather than once up front.

**Limit.** What was *requested* — `thinking`, `output_config.effort`, task budgets
— is only reported for captures recorded after the proxy started keeping those
fields. Older captures say so rather than implying nothing was set.

---

## 7 · Over the wire

**What it's for.** Latency splits in two and the halves mean different things: the
wait before the first byte is queueing and prompt processing, everything after it
is generation. Averaged together, a slow queue reads as a slow model.

**How it works.** The two halves are reported separately, with tokens per second
measured against the generating half only. Alongside them, three things that are
otherwise invisible:

- **Silent retries** — `x-stainless-retry-count` is the only place a retry the SDK
  already handled shows up. The request succeeded, so nothing else surfaces.
- **Failures with their reason** — a 429 carries its error body and `retry-after`;
  a stream that fails after a 200 carries the error event that ended it.
- **Remaining quota** — the `anthropic-ratelimit-*` headers, parsed *by shape*
  (`<resource>-<field>`) rather than from a fixed list, so a limit type that did
  not exist when this was written still appears.

**Limit and verification.** These fields only exist in captures recorded after the
proxy started keeping them, so the card hides itself on older ones. Verified by
driving the real proxy against a stubbed upstream: staggered first-byte times, a
rate-limited turn with `retry-after`, and a turn that arrived after an SDK retry
all land as expected.

---

## 8 · Measuring instead of estimating

**What it's for.** Every token figure in the breakdown is `chars / 4`, because the
API reports usage in aggregate and never per section. `count_tokens` answers
exactly.

**How it works.** `count_tokens` only answers for a whole request, so the sections
are isolated by measuring four and subtracting:

```
baseline    a minimal request      →  the fixed per-request overhead
+ tools     baseline plus tools    →  tools    = (+tools − baseline)
+ system    baseline plus system   →  system   = (+system − baseline)
full        the real request       →  messages = full − tools − system − baseline
```

Four calls rather than one per section — measuring per message would be one call
per message. It reports the calibration too: how far `chars / 4` was off on this
request, and the chars-per-token it actually averaged, which is the number to read
every other estimate by.

**It spends your quota, so nothing measures on its own.** It happens on an
explicit click, the button says what it will do before you press it, and results
are cached so asking twice is free.

### The credential

Measuring means calling the API, which needs a credential — and everything else
here is built so credentials never reach disk. The line drawn is narrower but
explicit: the auth header of a session's last request is kept in a
**process-lifetime map in memory**, never written to disk, never logged, never
returned by any endpoint, and used only to authenticate a count for the session it
came from. Restarting the proxy forgets it.

If you would rather it never reuse Claude Code's own credential, start the proxy
with `ANTHROPIC_API_KEY` set — an explicit key always wins.

**Verification.** Driven against a stubbed upstream with a deliberately
non-`chars/4` tokenizer: the decomposition adds up, the remembered credential
reaches the outbound calls, and it never appears in the capture file.

---

## 9 · Threads

**What it's for.** A subagent is a whole conversation of its own — its own context
window, its own tool set, its own bill — that exists to hand a few hundred tokens
back to the conversation that spawned it. Turn by turn that is invisible: its
turns interleave with everything else, and its cost lands in the session total
with nothing to attribute it to.

**How it works.** Threads are grouped by the `x-claude-code-agent-id` header,
which is fact. Which tool call spawned which thread is **inferred** from ordering
— the closest `Agent` / `Task` / `Workflow` call already made when the thread's
first turn arrived — and the card says so rather than presenting it as read from
the wire. Clicking a thread jumps to its first turn, where the cache card shows it
starting cold: a subagent's prefix has nothing in common with the conversation's.

The number worth having is the ratio between what a subagent spent and what it
handed back.

**Limit and verification.** The captures on hand contain no subagents, so this was
verified against a scripted session driven through the real proxy: two subagents
spent 80.7K tokens and $0.083 — 69% of that session — to report back 18 tokens
between them.

---

## 10 · The time machine

**What it's for.** Every other layer measures what happened. This one answers the
two questions a capture cannot: what accumulated *between* two turns, and what
would have happened if the request had been sent differently.

### Compare

The cache and history layers compare a turn with the one immediately before it,
because that is what the cache does. A different question needs a different
pairing: what actually piled up between turn 5 and turn 90, which tools appeared
along the way, which parts of the prompt were rewritten. Pick any other turn *of
the same kind* — diffing a security check against an agent turn would just report
that two unrelated prompts differ — and the diff comes back split by messages,
tool definitions and system prompt, each with its token delta and what changed by
name.

### Replay

The tool-economics layer raises a question it cannot settle: 58 of those 59 tools
were never called, so would the turn have gone the same way without them? Reading
a capture cannot tell you. Sending the request again, minus the tools, can.

Three changes are available — the tool list (as captured / only the ones ever
called in this session / none), the system prompt (kept or dropped), and the
model (any model this session used) — and everything not named is sent exactly as
captured. The result is shown against the original: tools sent, prompt size,
billed tokens, cost, stop reason, which tools it called this time, and what it
said.

The block shape usually answers the question before the text does. In a scripted
session driven through the proxy, dropping the tool list took the prompt from
2.3K to 1.4K tokens and the cost from $0.0098 to $0.0024 — and changed the stop
reason from `tool_use` to `end_turn`: without tools the model described the
command instead of running it.

**It sends a real request and spends real quota**, so like measuring it only runs
from an explicit click, its output is capped at 4K tokens, and **the reply is
never written to the capture store** — a replay is an experiment, not something
the session did. It uses the same in-memory-only credential as
[layer 8](#8--measuring-instead-of-estimating).

### Export

**Copy as curl** turns the captured request into something runnable — the fastest
route from "this turn went wrong" to a reproduction outside the harness, with the
key left as `$ANTHROPIC_API_KEY` rather than baked in. **Copy request** gives the
body alone, as a fixture. Both send only fields that are part of a request: the
capture also carries the parsed beta list and the headers we kept, which the API
would reject.

**Verification.** Driven against a stubbed upstream: the diff reports the right
deltas across a span where the tool list grew, all three tool modes replay
correctly, the store still holds only the captured turns afterwards, and the
credential never appears in the capture file.

---

## Layout

```
bin/cli.js              the cmon command
src/run.js              proxy entry point
src/proxy.js            forwards to api.anthropic.com and records each exchange
src/server.js           static files + the HTTP API + SSE
src/capture-store.js    append-only JSONL store, one file per session
src/breakdown.js        per-section size estimates for a request body

src/cache-forensics.js  layer 1 — chain walking, prefix diffing, cost of a miss
src/call-kinds.js       layer 2 — agent loop / subagent / background classification
src/history-diff.js     layer 3 — what changed in the message list since last turn
src/prompt-anatomy.js   layer 4 — system prompt sections plus the reminder layer
src/tool-economics.js   layer 5 — definition cost against actual use
src/thinking.js         layer 6 — thinking tokens, block order, signature replay
src/network.js          layer 7 — latency split, retries, failures, rate limits
src/token-count.js      layer 8 — exact sizes via four count_tokens calls
src/credentials.js      layer 8 — in-memory-only auth, used solely for those calls
src/topology.js         layer 9 — conversation and subagent threads
src/turn-diff.js        layer 10 — structured diff between any two turns
src/replay.js           layer 10 — re-sending a captured turn with changes

src/pricing.js          list prices and the cache read/write multipliers
src/settings-env.js     journalled read/modify/write of ~/.claude/settings.json
public/                 the UI (no build step — Tailwind + Chart.js from CDN)
```

## Notes

- Captures contain your full prompts and tool output. `~/.cmon/` is plain
  text on disk; delete it when you're done.
- The proxy binds to `127.0.0.1` only, unless you set `CMON_HOST`.
- Requires Node 18+.
