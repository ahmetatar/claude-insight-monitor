# claude-cxt-dump

A local proxy that sits between Claude Code and the Anthropic API, records every
request, and shows you exactly what was in the context window — system prompt,
messages, tool definitions, and the real token usage the API reported back.

Nothing is sent anywhere. The proxy forwards to the real API and keeps a copy on
disk under `~/.cxt-proxy/captures/`.

---

## Install

```sh
git clone <this repo> && cd claude-cxt-dump
npm link          # symlinks `ctx-proxy` onto your PATH
```

`npm link` points at the working copy, so edits take effect immediately. For a
fixed snapshot instead, use `npm install -g .`. To remove it: `npm unlink -g claude-cxt-dump`.

No dependencies — Node's standard library only.

---

## Quick start

Two terminals. In the first:

```sh
ctx-proxy session
```

It brings the proxy up, writes `ANTHROPIC_BASE_URL` into `~/.claude/settings.json`,
and waits. In the second terminal, just run `claude` — no export needed. Open
<http://localhost:8787> to watch the context fill up live.

When you're done, press **Enter** in the first terminal. The proxy stops and the
settings key is removed.

Prefer a single terminal?

```sh
ctx-proxy exec -- claude
```

Here the variable exists only inside the `claude` process, so there is nothing to
clean up: when `claude` exits, the proxy stops.

Those two cover almost everything. `start` / `stop` / `status` are there for the
cases they don't: leaving the proxy up across several sessions, and checking on it.

---

## Commands

Five commands, two of which you'll actually type.

| Command | What it does |
| --- | --- |
| `ctx-proxy session` | Start the proxy, point Claude Code at it, undo both on Enter. The everyday command. |
| `ctx-proxy exec -- <cmd>` | Run `<cmd>` against the proxy; the variable exists only inside that process and the proxy stops when it exits. |
| `ctx-proxy start` | Leave the proxy running in the background, detached from any terminal. Prints the export line. |
| `ctx-proxy stop` | Stop it and clean up. |
| `ctx-proxy status` | Running? How many turns captured? Is `settings.json` clean? |

`--port <n>` works on all of them (default `8787`).

Cleanup is not a command, because forgetting to run it is exactly the failure
mode: `session` undoes itself on Enter or Ctrl-C, and `stop` and `status` drop a
`settings.json` key left behind by a crash whenever they notice the proxy is
down. If `settings.json` already holds an `ANTHROPIC_BASE_URL` you set yourself,
`session` leaves it alone and falls back to handing you an `export` line.

### Environment

| Variable | Meaning |
| --- | --- |
| `CXT_PROXY_HOME` | Where the pid file, log and captures live. Default `~/.cxt-proxy`. Set it per project if you want separate stores. |
| `CXT_PROXY_PORT` | Port for the proxy process itself; normally set for you by the CLI. |
| `CXT_PROXY_HOST` | Bind address. Default `127.0.0.1` — set `0.0.0.0` only if you deliberately want it reachable from the network. |

---

## How the three ways to point Claude at the proxy differ

Claude Code needs `ANTHROPIC_BASE_URL` to reach the proxy. There is no way for
one process to change another terminal's environment — env is copied into a
process at birth and never written back — so each option makes a different
trade-off:

- **`settings.json`** (`session`) — Claude Code reads its `env` block at startup,
  so this reaches every `claude` you launch afterwards, in any terminal, with no
  export. This is the closest thing to a global switch.
- **`exec`** — the variable lives only inside the child process. Nothing to clean
  up, but the proxy dies with that one `claude`.
- **`export`** (`start`) — the classic way, scoped to one shell. You unset it
  yourself.

### Why a stale key is dangerous, and what stops it

A leftover `ANTHROPIC_BASE_URL` in `settings.json` points every future `claude`
at a proxy that is no longer listening, and the failure looks like a broken API
key. Three safeguards:

1. **Journalled writes.** Every value written is recorded in
   `~/.cxt-proxy/settings-patch.json`. Reverting removes only that exact value.
2. **Your own value is never touched.** If `settings.json` already sets
   `ANTHROPIC_BASE_URL`, the CLI says so and falls back to the export line.
3. **Self-repair.** If the proxy is down but our key is still there, `status` and
   `stop` remove it. So a `kill -9` or a reboot cannot strand it.

---

## The UI

<http://localhost:8787> — one page, live over SSE.

- **Sessions rail** — every captured session, newest first.
- **Turn ribbon** — one bar per turn, height = context tokens. Background calls
  are drawn as outlines so the eye follows the agent loop. Click to jump;
  `←`/`→` (or `j`/`k`) also work.
- **Context window** — a ring showing how full the window is, split by input /
  cache read / cache write, against the model's real limit (1M variants are
  detected from the model id). Below it, the four usage numbers.
- **History over time** — every turn's usage as a stacked area chart. Clicking a
  point selects that turn.
- **What fills the window** — system prompt vs messages vs tool definitions as a
  proportion bar, then all individual sections ranked by size. Click any section
  to open an inspector with the full text: a tool's description, its parameters
  (type, required, docs) and raw JSON schema; a message's content blocks with
  their types, cache markers and per-block token counts. Every block has a copy
  button. `Esc` closes it.
- **Where the calls go** — every request sorted into what it actually is, with
  its share of the session's spend. See below.
- **Cache** — why the prompt cache behaved the way it did on this turn. A
  verdict (prefix hit / partial hit / miss / cold start), the prefix drawn in
  token space with its cache breakpoints and the exact point where it stopped
  matching the previous turn, what the turn cost, and what it would have cost
  with no cache at all. See below.
- **Raw JSON** — the complete captured request and response, collapsible.

Token figures in the breakdown are estimates (`chars / 4`); the API only reports
usage in aggregate. The four numbers under the ring are the real ones.

---

## What the calls actually are

One session id is not one conversation. Claude Code multiplexes the agent loop,
its subagents, and a fleet of short background calls onto the same id — in a
118-turn session captured here, 43 of them were security classifiers that
evaluate a shell command before the Bash tool runs it, and never touch the
conversation at all. Averaged into one chart they read as the context window
collapsing and refilling; averaged into one bill they are invisible.

Each request is sorted by what it sends:

| Kind | Recognised by |
| --- | --- |
| agent loop | Tool definitions present — the conversation whose window the UI tracks. |
| subagent | An `x-claude-code-agent-id` header; its own context window. |
| bash security check | A system prompt that opens "You are a security monitor for autonomous AI coding agents". |
| session title | The title-generation prompt, run once to name the session. |
| compaction | A toolless call asking for a summary of the conversation. |
| quota probe | A one-token request whose entire body is the word `quota` — the startup reachability check. |
| token count | A `/v1/messages/count_tokens` call: Claude Code sizing the window before it sends. |
| utility call | Anything else with no tools. Its opening line is kept so an unrecognised kind is still identifiable rather than silently bucketed. |

Claude Code also prepends its own billing header as the first system block
(`cc_version=2.1.226.06d; cc_entrypoint=cli;`), so each capture records the CLI
build that produced it and whether it came from the terminal (`cli`) or the
Agent SDK (`sdk-cli`).

## Cache forensics

`usage` tells you a turn re-wrote 40K tokens; it never tells you why, and "why"
is the half you can act on. The proxy reconstructs the prefix the API actually
matches on — tools, then system, then messages, one unit per content block —
hashes each unit, and compares it against the previous turn of the same
conversation. The first unit whose bytes differ is where the cache stopped being
reusable.

Only a difference *before* the last cache breakpoint costs anything; past it the
bytes were never cached, so a changed tail is just the conversation moving on.
That distinction is what separates a real miss from normal growth:

| Verdict | Meaning |
| --- | --- |
| prefix hit | Everything the previous turn had cached was byte-identical. |
| partial hit | Something inside the cached region changed; the tokens after it had to be written again. |
| miss | Nothing was reused. Attributed to a prefix change, an expired TTL, or — when the prefix is unchanged and the TTL is not up — eviction upstream. |
| cold start | First turn of this conversation; there was nothing to reuse. |

Costs use Anthropic's list prices with the cache multipliers (writes 1.25x at the
5-minute TTL, 2x at the hour, reads 0.1x), alongside the counterfactual: the same
turn with every cached token re-sent at full price. A large `cache_creation`
number is only wasteful if nothing reads it, and that comparison is the only
honest way to see which it was.

One session id carries several conversations — the agent loop, subagents, and
short utility calls that ship no tools. Each is compared only against its own
history; among recent turns, the predecessor is the one sharing the longest
prefix.

Prices are a cached table. A model that isn't in it shows no cost rather than a
wrong one.

## What a capture records

One JSONL line per exchange (`schema: 2`). The request and response bodies are
kept whole, plus the parts of the exchange that live outside them:

| Field | Contents |
| --- | --- |
| `endpoint` | Method, path and `kind` — `messages`, or `count_tokens` for the calls Claude Code makes to size the window before it sends. |
| `client` | `claude-cli` version parsed out of the user agent, auth type (`oauth` / `api-key`), SDK retry count, and the `x-stainless-*` runtime fingerprint. |
| `request` | Beyond model/system/messages/tools: `thinking`, `effort`, `tool_choice`, `stop_sequences`, `metadata`, `context_management`, sampling params, and `betas` as a parsed list. |
| `response` | Message id, content, stop reason, usage, plus `error` — including the `error` event a stream can emit *after* a 200 — and the full body for anything that isn't a plain Messages reply. |
| `response.headers` | `request-id` for correlating with Anthropic's logs, `anthropic-ratelimit-*` for remaining quota, `retry-after` on a 429. |
| `timing` | `ttfbMs` (time to first byte) and `durationMs`. |
| `bytes` | Request and response sizes on the wire. |

Credentials are never written: `authorization`, `x-api-key`, `cookie` and
`set-cookie` are dropped before the record is built, not redacted afterwards.

Captures written before this schema are still read; they simply lack the new
fields.

## Layout

```
bin/cli.js            the ctx-proxy command
src/run.js            proxy entry point
src/proxy.js          forwards to api.anthropic.com and records each exchange
src/server.js         static files + /api/sessions, /api/events (SSE), /api/health
src/capture-store.js  append-only JSONL store, one file per session
src/breakdown.js      per-section size estimates for a request body
src/cache-forensics.js  prefix diffing: what broke the cache, and what it cost
src/call-kinds.js     sorts each request into agent loop / subagent / background
src/pricing.js        list prices and the cache read/write multipliers
src/settings-env.js   journalled read/modify/write of ~/.claude/settings.json
public/               the UI (no build step — Tailwind + Chart.js from CDN)
```

## Notes

- Captures contain your full prompts and tool output. `~/.cxt-proxy/` is plain
  text on disk; delete it when you're done.
- The proxy binds to `127.0.0.1` only, unless you set `CXT_PROXY_HOST`.
- Requires Node 18+.
