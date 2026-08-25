# cli-wrapper

An OpenAI-compatible HTTP API backed by the `claude` (Claude Code) and `codex` CLIs, run as
chat-only subprocesses (no file/shell tool access). Point any OpenAI-compatible SDK or tool
at it and it just works, using whichever `claude`/`codex` login is already sitting on the
host — no separate API key to provision for the model calls themselves.

- **Drop-in OpenAI API** — `/v1/chat/completions` (streaming + non-streaming) and
  `/v1/models`, backed by a routing table you define (`config.json`'s `models`).
- **Live, no-restart settings page** at `/settings` — model routing, API key, timeout,
  working directory, and activity log, all editable without touching env vars or restarting
  (open to anyone who can reach it, by design — see the callout below). It listens on its
  own port, separate from the API, so exposing one doesn't automatically expose the other.
- **Warm process pool for `claude`** — reuses already-running `claude` processes across
  requests instead of paying a full CLI boot every call, while staying fully stateless from
  the client's point of view. Live pool status (busy/idle workers, queued requests) is
  viewable on the settings page.
- **Optional warm pool for `codex`** (opt-in, off by default) — routes requests through a
  small pool of long-lived `codex app-server` daemons instead of spawning a fresh `codex`
  process every call. Each request still gets its own isolated, ephemeral turn — see
  "Configuration" below.
- **Reasoning effort control** — set a default per model mapping, optionally let a request's
  own `reasoning_effort` field override it, and get any reasoning/thinking content back as
  `reasoning_content`.
- **Optional built-in web search** — per model mapping, grant `claude`'s `WebSearch` tool or
  `codex`'s `web_search` tool, without opening up general shell/file tool access.
- **Recent-activity log** — the last 200 requests, viewable on the settings page, with
  optional full prompt/response capture and optional disk persistence.

## Contents

[Prerequisites](#prerequisites) · [Setup](#setup) · [Configuration](#configuration) ·
[Usage](#usage) · [Shipping to another machine](#shipping-to-another-machine) ·
[Notes / limitations](#notes--limitations) · [Environment variables](#environment-variables) ·
[More docs](#more-docs)

## Prerequisites

- Node.js (tested on v24.11.1)
- `claude` and `codex` CLIs installed and already logged in (this wrapper inherits their
  ambient auth — it does not manage API keys itself)

## Setup

```sh
npm install
npm run dev
```

That's it — no `.env` edits required. On first run, `config.json` is seeded from
`config.example.json` and a random API key is generated for you; the server prints it once
to the console, e.g.:

```
  Generated a new API key for /v1/*: 3f9c2a1e7b...
  View or change it any time at /settings (no login required to open that page).

cli-wrapper API listening on http://localhost:8869
settings (no auth required): http://localhost:8868/settings
```

Note the two different ports: the settings page defaults to **8868**, the OpenAI API to
**8869** — they're two separate listeners, on purpose (see "Configuration" below and the
callout further down).

You can also view/change most settings any time at `/settings` — see "Configuration" below.

> **Check your model ids before relying on the seed config.** `cliModel` values are passed
> straight through to `--model`/`-m`, and which ones work depends on your login (e.g. a
> ChatGPT-plan Codex account may reject `gpt-5-codex` with "not supported when using Codex
> with a ChatGPT account" — check `~/.codex/config.toml` or `codex features list` for what's
> actually available to you, and `claude --model` aliases like `sonnet`/`opus` for Claude).

## Configuration

Two ports, by design:

| Surface                                   | Default port | Configured via                                                            |
| ----------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| Settings (`/settings`, `/api/settings/*`) | `8868`       | env `SETTINGS_PORT` only — not in `config.json` (see below)               |
| OpenAI API (`/v1/*`)                      | `8869`       | `config.json`'s `settings.apiPort`, or env `PORT` to override for one run |

Splitting them means the unauthenticated settings surface (see the callout below) can be
bound/exposed independently of the API — e.g. keep settings on localhost only while the API is reachable more broadly.

Everything below lives in `config.json` and is editable live from `http://localhost:8868/settings`
— no restart needed, except **API port**:

- **API key** — the bearer token required on `/v1/*`. Leave it blank on the settings page
  to disable auth on `/v1/*` entirely (an explicit, visible opt-out — the server never
  starts with a blank key on its own; see the callout below about `/settings` itself).
- **API port**, **CLI timeout**, **CLI working directory**.
- **Activity log**: whether full prompt/response text is captured, and an optional file
  path to persist the last 200 entries to disk (see "Recent activity" below).
- **Codex warm pool** (`codexUseWarmPool`, off by default) and **pool size**
  (`codexPoolSize`, default `2`) — see "Codex warm pool (experimental)" below.

### Model routing

The `models` array in `config.json` (or the "Model routing" table on `/settings`) is what
maps a client-facing `model` name to an actual CLI invocation:

| Field                          | Required | Meaning                                                                                                                                                                                                                                                                             |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                           | yes      | The name clients send as `model` in their request.                                                                                                                                                                                                                                  |
| `provider`                     | yes      | `claude` or `codex`.                                                                                                                                                                                                                                                                |
| `cliModel`                     | yes      | Passed straight through to `--model`/`-m` — e.g. `sonnet`/`opus` for claude, `gpt-5.5` for codex. Account-dependent; see the callout above.                                                                                                                                         |
| `extraFlags`                   | no       | Raw argv appended verbatim to the CLI invocation — an escape hatch for anything not covered by the fields below.                                                                                                                                                                    |
| `reasoningEffort`              | no       | Default reasoning effort: `minimal` / `low` / `medium` / `high` / `xhigh` / `max`. Not every value is valid for every provider (see "Reasoning effort and content" below) — an invalid combination surfaces as a CLI-level error at request time, not a config-save-time rejection. |
| `allowReasoningEffortOverride` | no       | Let a request's own `reasoning_effort` field override the default above for that call. Off by default.                                                                                                                                                                              |
| `enableWebSearch`              | no       | Grant this mapping's CLI its built-in web search tool — `claude`'s `WebSearch`, or `codex`'s `web_search`. See "Web search tool" below.                                                                                                                                             |
| `description`                  | no       | Free text, shown on the settings page only.                                                                                                                                                                                                                                         |

`config.example.json` has working examples of each of these, including a plain mapping per
provider and one web-search-enabled mapping per provider.

### Codex warm pool (experimental)

By default, every `codex`-routed request spawns a fresh `codex exec` process (no shared
state between requests, but a full CLI-boot cost every call). Turning on `codexUseWarmPool`
on the settings page (or in `config.json`) instead routes requests through a small pool of
long-lived `codex app-server` daemons — `codexPoolSize` (default `2`) controls how many.
Each request still gets its own isolated, ephemeral thread/turn on whichever daemon is least
busy, so client-visible behavior (statelessness, no cross-request bleed) is unchanged; only
the process-boot cost is amortized, the same idea as the `claude` pool above.

This is opt-in and marked experimental because `codex app-server`'s JSON-RPC protocol has no
documented backwards-compatibility guarantee across `codex` CLI versions (the subcommand
itself is still labeled `[experimental]` in `codex --help`) — a `codex` upgrade could change
it without warning. Turning the setting off does not stop already-running daemons; they sit
idle until the server restarts. See `AGENTS.md`'s "Warm codex app-server pool" section for
the full design, verified-live numbers, and gotchas.

Only three things remain env vars — see `.env.example`:

- `CONFIG_PATH` (default `./config.json`) — needed before `config.json` can even be located.
- `SETTINGS_PORT` (default `8868`) — the settings surface's own port; deliberately not a
  `config.json` field (see "Configuration" above).
- `PORT` — optional, overrides `config.json`'s `apiPort` for this run only (e.g. for
  containers/process managers that inject it themselves); never affects `SETTINGS_PORT`.

Editing `config.json` directly also works; it's read fresh on every request, same as the
model routing table.

> **`/settings` has no authentication, by design.** Anyone who can reach its port can open
> it, read/change the model routing, read/change every setting above — including the API
> key that guards `/v1/*` — and (if content capture is on) read full past prompts/responses
> in the activity log. This is an internal/personal-use tool. It listening on its own port
> (see "Configuration" above) means you _can_ expose the API more broadly while keeping this
> port to localhost/a private interface — but that's a mitigation, not a fix: still put this
> port itself behind a network boundary or reverse-proxy with its own auth if it's ever
> reachable beyond a trusted host.

## Usage

`/v1/chat/completions` and `/v1/models` — on the **API port** (`8869` by default) — require
`Authorization: Bearer <apiKey>` (the key shown on `/settings`), unless you've blanked it out
there. `/settings` and `/api/settings/*` — on the separate **settings port** (`8868` by
default) — never require auth.

```sh
curl http://localhost:8869/v1/models \
  -H "Authorization: Bearer $API_KEY"

curl http://localhost:8869/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"Say hi"}]}'
```

Streaming works the same way with `"stream": true` — responses are Server-Sent Events
ending in `data: [DONE]`.

Open `http://localhost:8868/settings` in a browser to edit server configuration and model
mappings. Changes take effect immediately on the next API request — no restart needed
(except **API port**).

The same page has a **Claude process pool** panel (auto-refreshing every 3s, `GET
/api/settings/pool-status`) showing every live warm `claude` process — PID, model,
reasoning effort, web search, busy/idle, and remaining uses before it retires — plus a
summary of how many are running against the pool's cap and how many requests, if any, are
queued waiting for a free one. By default `codex` has no persistent pool (a fresh process
per request, so nothing to show, and the panel says so) — turning on `codexUseWarmPool`
(see "Codex warm pool (experimental)" above) switches this to a **Codex daemon pool** panel
instead, backed by `GET /api/settings/codex-pool-status`, showing each live `codex
app-server` daemon's PID, in-flight turn count, and total turns served.

It also has a **Recent activity** panel (auto-refreshing every 4s) showing the last 200
chat-completion requests — model, provider, streaming, status, duration, token usage, and
error message where relevant. Each row has a **View** button showing the full prompt sent
to the CLI and the full response text. Backed by `GET`/`DELETE /api/settings/logs`; it's
in-memory only by default and resets on server restart — set a log file path on the
settings page to persist it to disk instead (still capped at the last 200 entries, loaded
back on the next start).

> **This means full conversation content can sit in server memory, and optionally on
> disk**, visible to anyone who can reach `/settings` (which, again, has no auth of its
> own) — or, if a log file path is set, anyone with filesystem access to that path. Don't
> run this somewhere sensitive conversations could be exposed by it. Turn off "store full
> prompt/response text" on the settings page to keep the activity log to metadata only
> (model, provider, status, duration, token counts) with no prompt/response text stored
> anywhere, on disk or in memory. The settings page shows which modes are active.

## Shipping to another machine

The target machine needs Node.js and its own logged-in `claude`/`codex` CLIs (the same
prerequisites as above) — this doesn't bundle a Node runtime or the CLIs themselves, only
this wrapper. Either way you get the same thing: a `cli-wrapper-<version>.tgz` tarball you
install with `npm install -g`.

### Option A: download a release

Every tag pushed as `vX.Y.Z` is built and published automatically by this repo's
[Release workflow](.github/workflows/release.yml). Grab the `.tgz` asset from the
[Releases page](../../releases) — no local build toolchain needed on the machine doing the
downloading.

### Option B: build it yourself

```sh
npm run build   # or just `npm pack`, which runs this via its "prepack" script
npm pack        # produces cli-wrapper-<version>.tgz
```

### Install

Copy the `.tgz` (downloaded or built) to the target machine (`scp`, a shared drive, an
internal artifact store, however you move files there) and install it:

```sh
npm install -g ./cli-wrapper-0.1.0.tgz
cli-wrapper
```

That installs a `cli-wrapper` command (from this package's `bin` entry) onto `PATH`. It
creates `config.json`/`.cli-wrapper-workspace/`/log files relative to wherever you run it
from — same as running from a source checkout, just without needing `git clone` + a full
dev toolchain on the target machine. It seeds `config.json` and generates a fresh API key
on first run, same as local `npm run dev` — see "Configuration" above; no `.env` needed
unless you want to override `CONFIG_PATH`, `PORT`, or `SETTINGS_PORT`. `npm install -g` also resolves and
installs this package's own dependencies (`express`, `dotenv`) from the npm registry, so
the target machine needs npm registry access (or an internal mirror/private registry) at
install time — the tarball itself doesn't vendor them.

No Node.js on the target machine at all, or want a single self-contained executable
instead of an npm-installed command? That needs a different approach (bundling with
esbuild + Node's Single Executable Application feature or a packager like `@yao-pkg/pkg`) —
ask if you want that built out; see `AGENTS.md`'s open optimizations for the trade-offs.

## Notes / limitations

- **Stateless from the outside, warm on the inside (claude only)**: every request still
  gets a completely blank conversation and the full message history is still resent and
  reprocessed every call — no client-visible behavior change and no cross-turn caching.
  But under the hood, `claude`-routed requests reuse a small pool of already-running
  `claude` processes instead of spawning a new one each time (each is sent a `/clear`
  before every request, and retired after 20-30 requests so none runs forever). This cuts
  the ~1-3s CLI boot/auth-check overhead most requests would otherwise pay. `codex`-routed
  requests still spawn a fresh subprocess every time by default — see "Codex warm pool
  (experimental)" above for the opt-in alternative, and AGENTS.md for why it isn't the
  default the way claude's pool is.
- **Claude warm-pool cap**: at most 20 `claude` processes run at once, shared across all
  models routed to it (an idle one holds ~300MB RSS). A burst past that cap queues rather
  than failing outright, bounded by the same CLI timeout as any other request — so under
  heavy concurrent load a request may wait for a slot before it starts, rather than erroring
  immediately. `codex`-routed requests have no such cap.
- **Chat-only**: both CLIs run with tools/file/shell access disabled by default. `claude`
  uses `--tools ""`; `codex` uses `--sandbox read-only`. Neither can modify your filesystem
  or run commands via this wrapper. The one opt-in exception is the web search tool below.
- **Unsupported OpenAI fields**: `temperature`, `max_tokens`, `top_p`, etc. are accepted in
  the request body but ignored — the underlying CLIs don't expose equivalent controls
  through this wrapper.
- **Reasoning effort and content**: a model mapping can set a default reasoning effort
  (`minimal` / `low` / `medium` / `high` / `xhigh` / `max`) on the settings page, and
  optionally allow a request's own `reasoning_effort` field (same field name real OpenAI
  reasoning models use) to override it for that call. Off by default — if a mapping hasn't
  enabled the override, a `reasoning_effort` sent to it is silently ignored, same as any
  other unsupported field above. When effort is requested, the response also includes a
  `reasoning_content` field (`message.reasoning_content` non-streaming, `delta
.reasoning_content` chunks streaming — the same field name DeepSeek/LiteLLM/Open WebUI
  already use) whenever the underlying CLI produced any visible reasoning text. Note for
  claude specifically: some accounts/plans redact the actual thinking text while still
  billing the tokens for it — in that case `reasoning_content` just won't appear, even
  though effort/cost was genuinely spent.
- **Web search tool**: a model mapping can set `enableWebSearch: true` to grant its CLI a
  real, built-in web search tool — `claude`'s `WebSearch` (executed server-side by
  Anthropic) or `codex`'s `web_search` (executed server-side by OpenAI). Off by default: no
  tools are available to either CLI unless a mapping opts in. This is a narrow, deliberate
  exception to general tool use below, not a reversal of it — see AGENTS.md's "Web search
  tool" section for the full investigation (why claude specifically needs
  `--permission-mode bypassPermissions`, why codex needs nothing extra, and why neither
  required any change to the response-parsing code to support).
- **General tool use / function calling isn't supported** — not just unimplemented, but not
  possible with these CLIs as invoked here: both run their tool loop to completion
  internally and never hand an unexecuted call back out for a client to run and return a
  result for, which real OpenAI/Anthropic function-calling requires. See AGENTS.md for how
  this was verified.
- **Codex streaming**: the Codex CLI doesn't emit token-level deltas, so a "streaming"
  codex response arrives as a single content chunk followed by the completion signal,
  rather than incremental text.
- A hard timeout (the CLI timeout on the settings page, default 300000ms / 5 minutes) kills
  any subprocess that runs too long, and subprocesses are also killed if the HTTP client
  disconnects early.

## Environment variables

Only three — everything else moved to `config.json`/`/settings`, see "Configuration" above.

| Var             | Default                                                             | Meaning                                                                                                                              |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CONFIG_PATH`   | `./config.json`                                                     | Path to the config file (settings + model routing)                                                                                   |
| `SETTINGS_PORT` | `8868`                                                              | Port the settings surface (`/settings`, `/api/settings/*`) listens on. Not in `config.json`, on purpose — see "Configuration" above. |
| `PORT`          | _(unset — uses `config.json`'s `settings.apiPort`, default `8869`)_ | Overrides the API port for this run only. Never affects `SETTINGS_PORT`.                                                             |

## More docs

- [`AGENTS.md`](./AGENTS.md) — contributor/agent-facing guide: file map, conventions,
  known gotchas hit during development, and open optimization ideas for future work.
  `CLAUDE.md` links to it for Claude Code.
