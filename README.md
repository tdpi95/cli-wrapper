# cli-wrapper

An OpenAI-compatible HTTP API backed by the `claude` (Claude Code) and `codex` CLIs, run as
chat-only subprocesses (no file/shell tool access). Includes a settings page — open to
anyone who can reach the server, no login — for editing model routing and all server
configuration live, without touching env vars or restarting.

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
```

You can also view/change it (or any other setting) any time at `/settings` — see
"Configuration" below.

> **Check your model ids before relying on the seed config.** `cliModel` values are passed
> straight through to `--model`/`-m`, and which ones work depends on your login (e.g. a
> ChatGPT-plan Codex account may reject `gpt-5-codex` with "not supported when using Codex
> with a ChatGPT account" — check `~/.codex/config.toml` or `codex features list` for what's
> actually available to you, and `claude --model` aliases like `sonnet`/`opus` for Claude).

## Configuration

Everything that used to be an env var now lives in `config.json` and is editable live from
`http://localhost:8868/settings` — no restart needed (except for `port`):

- **API key** — the bearer token required on `/v1/*`. Leave it blank on the settings page
  to disable auth on `/v1/*` entirely (an explicit, visible opt-out — the server never
  starts with a blank key on its own; see the callout below about `/settings` itself).
- **Port**, **CLI timeout**, **CLI working directory**.
- **Activity log**: whether full prompt/response text is captured, and an optional file
  path to persist the last 200 entries to disk (see "Recent activity" below).

Only two things remain env vars, because they're needed before `config.json` can even be
located: `CONFIG_PATH` (default `./config.json`) and an optional `PORT` override for
deployments that inject it themselves (e.g. containers/process managers) — see
`.env.example`. Editing `config.json` directly also works; it's read fresh on every request,
same as the model routing table.

> **`/settings` has no authentication, by design.** Anyone who can reach this server over
> the network can open it, read/change the model routing, read/change every setting above
> — including the API key that guards `/v1/*` — and (if content capture is on) read full
> past prompts/responses in the activity log. This is an internal/personal-use tool; bind it
> to localhost or put it behind a network boundary/reverse-proxy with its own auth if it's
> ever reachable beyond a trusted host.

## Usage

`/v1/chat/completions` and `/v1/models` require `Authorization: Bearer <apiKey>` (the key
shown on `/settings`), unless you've blanked it out there. `/settings` and `/api/settings/*`
never require auth.

```sh
curl http://localhost:8868/v1/models \
  -H "Authorization: Bearer $API_KEY"

curl http://localhost:8868/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"Say hi"}]}'
```

Streaming works the same way with `"stream": true` — responses are Server-Sent Events
ending in `data: [DONE]`.

Open `http://localhost:8868/settings` in a browser to edit server configuration and model
mappings. Changes take effect immediately on the next API request — no restart needed
(except `port`). The same page has a **Recent activity** panel (auto-refreshing every 4s)
showing the last 200 chat-completion requests — model, provider, streaming, status,
duration, token usage, and error message where relevant. Each row has a **View** button
showing the full prompt sent to the CLI and the full response text. Backed by
`GET`/`DELETE /api/settings/logs`; it's in-memory only by default and resets on server
restart — set a log file path on the settings page to persist it to disk instead (still
capped at the last 200 entries, loaded back on the next start).

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
this wrapper.

```sh
npm run build   # or just `npm pack`, which runs this via its "prepack" script
npm pack        # produces cli-wrapper-<version>.tgz
```

Copy the `.tgz` to the other machine (`scp`, a shared drive, an internal artifact store,
however you move files there) and install it:

```sh
npm install -g ./cli-wrapper-0.1.0.tgz
cli-wrapper
```

That installs a `cli-wrapper` command (from this package's `bin` entry) onto `PATH`. It
creates `config.json`/`.cli-wrapper-workspace/`/log files relative to wherever you run it
from — same as running from a source checkout, just without needing `git clone` + a full
dev toolchain on the target machine. It seeds `config.json` and generates a fresh API key
on first run, same as local `npm run dev` — see "Configuration" above; no `.env` needed
unless you want to override `CONFIG_PATH` or `PORT`. `npm install -g` also resolves and
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
  requests still spawn a fresh subprocess every time — see AGENTS.md if you're curious why
  the same trick doesn't apply there.
- **Claude warm-pool cap**: at most 20 `claude` processes run at once, shared across all
  models routed to it (an idle one holds ~300MB RSS). A burst past that cap queues rather
  than failing outright, bounded by the same CLI timeout as any other request — so under
  heavy concurrent load a request may wait for a slot before it starts, rather than erroring
  immediately. `codex`-routed requests have no such cap.
- **Chat-only**: both CLIs run with tools/file/shell access disabled. `claude` uses
  `--tools ""`; `codex` uses `--sandbox read-only`. Neither can modify your filesystem or
  run commands via this wrapper.
- **Unsupported OpenAI fields**: `temperature`, `max_tokens`, `top_p`, etc. are accepted in
  the request body but ignored — the underlying CLIs don't expose equivalent controls
  through this wrapper.
- **Codex streaming**: the Codex CLI doesn't emit token-level deltas, so a "streaming"
  codex response arrives as a single content chunk followed by the completion signal,
  rather than incremental text.
- A hard timeout (the CLI timeout on the settings page, default 120000ms) kills any
  subprocess that runs too long, and subprocesses are also killed if the HTTP client
  disconnects early.

## Environment variables

Only two — everything else moved to `config.json`/`/settings`, see "Configuration" above.

| Var | Default | Meaning |
|---|---|---|
| `CONFIG_PATH` | `./config.json` | Path to the config file (settings + model routing) |
| `PORT` | *(unset — uses `config.json`'s `settings.port`)* | Overrides the configured port for this run |

## More docs

- [`PLAN.md`](./PLAN.md) — the original design plan (architecture, verified CLI flag/event
  shapes, verification steps) written before this was built.
- [`AGENTS.md`](./AGENTS.md) — contributor/agent-facing guide: file map, conventions,
  known gotchas hit during development, and open optimization ideas for future work.
  `CLAUDE.md` links to it for Claude Code.
