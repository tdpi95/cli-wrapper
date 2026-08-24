# cli-wrapper

An OpenAI-compatible HTTP API backed by the `claude` (Claude Code) and `codex` CLIs, run as
chat-only subprocesses (no file/shell tool access). Includes a small settings page for
editing which client-facing model names route to which CLI + underlying model.

## Prerequisites

- Node.js (tested on v24.11.1)
- `claude` and `codex` CLIs installed and already logged in (this wrapper inherits their
  ambient auth — it does not manage API keys itself)

## Setup

```sh
npm install
cp .env.example .env   # edit WRAPPER_API_KEY to a long random string
npm run dev
```

On first run, `config.json` is seeded from `config.example.json` if it doesn't already exist.

`WRAPPER_API_KEY` is required — the server refuses to start without it, since it's meant to
be reachable over HTTP.

> **Check your model ids before relying on the seed config.** `cliModel` values are passed
> straight through to `--model`/`-m`, and which ones work depends on your login (e.g. a
> ChatGPT-plan Codex account may reject `gpt-5-codex` with "not supported when using Codex
> with a ChatGPT account" — check `~/.codex/config.toml` or `codex features list` for what's
> actually available to you, and `claude --model` aliases like `sonnet`/`opus` for Claude).

## Usage

All of `/v1/chat/completions`, `/v1/models`, `/settings`, and `/api/settings/*` require
`Authorization: Bearer <WRAPPER_API_KEY>`. `/settings` and its API additionally accept the
token as `?token=...` in the URL, since a browser navigating directly can't set headers.

```sh
curl http://localhost:8787/v1/models \
  -H "Authorization: Bearer $WRAPPER_API_KEY"

curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $WRAPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"Say hi"}]}'
```

Streaming works the same way with `"stream": true` — responses are Server-Sent Events
ending in `data: [DONE]`.

Open `http://localhost:8787/settings?token=$WRAPPER_API_KEY` in a browser to add, edit, or
remove model mappings. Changes take effect immediately on the next API request — no restart
needed. The same page has a **Recent activity** panel (auto-refreshing every 4s) showing the
last 200 chat-completion requests — model, provider, streaming, status, duration, token
usage, and error message where relevant. Each row has a **View** button showing the full
prompt sent to the CLI and the full response text. Backed by `GET`/`DELETE
/api/settings/logs`; it's in-memory only by default and resets on server restart — set
`LOG_FILE_PATH` to persist it to a JSON file instead (still capped at the last 200 entries,
loaded back on the next start).

> **This means full conversation content can sit in server memory, and optionally on
> disk**, visible to anyone who has (or guesses/leaks) `WRAPPER_API_KEY` — or, if
> `LOG_FILE_PATH` is set, anyone with filesystem access to that path. Don't run this
> somewhere sensitive conversations could be exposed by it, and treat the token (and the
> log file, if enabled) accordingly. Set `LOG_CAPTURE_CONTENT=false` to keep the activity
> log to metadata only (model, provider, status, duration, token counts) with no
> prompt/response text stored anywhere, on disk or in memory. The settings page shows which
> modes are active.

## Notes / limitations

- **Stateless**: each request spawns a fresh CLI subprocess; there is no session
  continuity between requests (matches the OpenAI API's own stateless chat-completions
  semantics — clients resend full history each call).
- **Chat-only**: both CLIs run with tools/file/shell access disabled. `claude` uses
  `--tools ""`; `codex` uses `--sandbox read-only`. Neither can modify your filesystem or
  run commands via this wrapper.
- **Unsupported OpenAI fields**: `temperature`, `max_tokens`, `top_p`, etc. are accepted in
  the request body but ignored — the underlying CLIs don't expose equivalent controls
  through this wrapper.
- **Codex streaming**: the Codex CLI doesn't emit token-level deltas, so a "streaming"
  codex response arrives as a single content chunk followed by the completion signal,
  rather than incremental text.
- A hard timeout (`CLI_TIMEOUT_MS`, default 120000ms) kills any subprocess that runs too
  long, and subprocesses are also killed if the HTTP client disconnects early.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `WRAPPER_API_KEY` | *(required)* | Shared bearer token for all endpoints |
| `PORT` | `8787` | HTTP port |
| `CLI_TIMEOUT_MS` | `120000` | Hard per-request subprocess timeout |
| `CONFIG_PATH` | `./config.json` | Path to the model-routing config |
| `CLI_WORKDIR` | `./.cli-wrapper-workspace` | Working directory passed to the CLIs |
| `LOG_CAPTURE_CONTENT` | `true` | Whether the activity log stores full prompt/response text (`false`/`0`/`no`/`off` to disable, metadata-only) |
| `LOG_FILE_PATH` | *(unset — in-memory only)* | If set, persists the last 200 activity-log entries to this JSON file and reloads them on startup |

## More docs

- [`PLAN.md`](./PLAN.md) — the original design plan (architecture, verified CLI flag/event
  shapes, verification steps) written before this was built.
- [`AGENTS.md`](./AGENTS.md) — contributor/agent-facing guide: file map, conventions,
  known gotchas hit during development, and open optimization ideas for future work.
  `CLAUDE.md` links to it for Claude Code.
