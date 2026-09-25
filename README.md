# cli-wrapper

Use your logged-in `claude` (Claude Code) and `codex` CLIs as an **OpenAI-compatible API**.
Point any OpenAI SDK or tool at it and it just works. Model calls go through the
`claude`/`codex` login already on the machine, so you don't need an Anthropic or OpenAI API
key. Your apps only need this wrapper's own API key, which it generates on first run. Chat
only: the CLIs can't edit files or run commands through it.

> [!WARNING]
> **Experimental, for personal use only.** This is an unofficial side project, not
> affiliated with or endorsed by Anthropic or OpenAI. Use it only with your own account,
> for yourself. Don't sell access, share your `claude`/`codex` login through it, or run it
> as a public service. That can violate Anthropic's and OpenAI's terms of service and get
> your account suspended. You're responsible for following the terms of the accounts you
> use. Provided as-is, with no warranty.

## Quick start (5 minutes)

### 1. Check you have the prerequisites

- **Node.js** (v24 tested) — `node --version`
- **`claude` and/or `codex` CLI, installed and logged in.** You only need the one(s) you
  plan to use. Check with `claude -p "hi"` / `codex exec "hi"` — if those answer, you're set.

### 2. Install

```bash
npm install -g https://github.com/tdpi95/cli-wrapper/releases/latest/download/cli-wrapper.tgz
```

This always installs the newest release. To pin a specific version instead, use its file
from the [Releases page](https://github.com/tdpi95/cli-wrapper/releases), e.g.
`.../releases/download/v0.2.1/cli-wrapper-0.2.1.tgz`.

### 3. Run it

```bash
cli-wrapper
```

On first run it creates `~/.cli-wrapper/config.json` and prints a generated API key:

```
  Generated a new API key for /v1/*: 3f9c2a1e7b...
  View or change it any time at /settings (no login required to open that page).

cli-wrapper API listening on http://localhost:8869
settings (no auth required): http://localhost:8868/settings
```

Two ports: **8869** is the API your apps talk to, **8868** is the settings page for you.

### 4. Configure in the browser

Open **http://localhost:8868/settings**. Everything saves live, no restart needed:

1. **Copy the API key and the API base URL** — that's all your apps need.
2. **Check the model routing table.** It comes pre-filled with example models. Delete the
   ones for a CLI you don't use, and make sure each `cliModel` is one your account can
   actually use (e.g. `sonnet`/`opus` for claude; for codex, the model in
   `~/.codex/config.toml` is a safe bet). The `id` column is the model name your apps send.

### 5. Test it

```bash
curl http://localhost:8869/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"Say hi"}]}'
```

### 6. Point your app at it

Anything that speaks the OpenAI API works. Set the base URL to `http://localhost:8869/v1`
and the API key to the one from step 4:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8869/v1", api_key="YOUR_API_KEY")
reply = client.chat.completions.create(
    model="claude-sonnet-5",
    messages=[{"role": "user", "content": "Say hi"}],
)
print(reply.choices[0].message.content)
```

Many tools also pick these up from the environment:

```bash
export OPENAI_BASE_URL=http://localhost:8869/v1 OPENAI_API_KEY=YOUR_API_KEY
```

Done. Everything below is optional.

## Everyday tasks

| I want to...                  | Do this                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Add or rename a model         | Settings page → Model routing → add a row (or edit `models` in `~/.cli-wrapper/config.json`) |
| Change / disable the API key  | Settings page → API key (blank = no auth on the API)                                         |
| Change the API port           | Settings page → API port, then restart `cli-wrapper`                                         |
| Change the settings page port | `SETTINGS_PORT=9000 cli-wrapper`                                                             |
| Enable web search for a model | Settings page → Model routing → edit the row → tick "Enable web search"                      |
| Turn on reasoning / thinking  | Settings page → Model routing → edit the row → "Default reasoning effort"                    |
| Stop prompts being logged     | Settings page → untick "Store full prompt/response text in the activity log"                 |
| Upgrade                       | Re-run the install command from step 2. Your config is kept.                                 |
| Uninstall                     | `npm uninstall -g cli-wrapper` (then delete `~/.cli-wrapper/` to remove config too)          |

## Troubleshooting

| Symptom                                                                     | Fix                                                                                                                   |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `401` from the API                                                          | Wrong or missing `Authorization: Bearer <key>` — copy the key from the settings page.                                 |
| `404` on `/v1/...` or on `/settings`                                        | Wrong port: the API is on **8869**, settings on **8868**.                                                             |
| `Unknown model: ...` (404)                                                  | The `model` you sent isn't an `id` in the model routing table.                                                        |
| Error like `model is not supported when using Codex with a ChatGPT account` | That `cliModel` isn't available on your login — pick another (see step 4).                                            |
| `EADDRINUSE` on startup                                                     | Port taken. Change the API port on the settings page, or run with `PORT=... SETTINGS_PORT=... cli-wrapper`.           |
| codex requests take ~20s behind a corporate proxy                           | Settings page → tick "Bypass HTTP proxy for OpenAI hosts" (details in [Codex behind a proxy](#codex-behind-a-proxy)). |
| Can't find the config file                                                  | The startup log prints `config: <path>`. Usually `~/.cli-wrapper/config.json`.                                        |

> **Security:** the settings page has **no login**, by design — anyone who can reach port
> 8868 can read and change everything, including the API key and (if logging is on) past
> conversations. Keep that port on localhost or behind your own firewall/auth. See
> [Security notes](#security-notes).

---

# Reference

Details for when you need them.

- [Features](#features)
- [Configuration](#configuration) · [Model routing](#model-routing) ·
  [Environment variables](#environment-variables)
- [Using the API](#using-the-api) · [Attachments](#attachments)
- [Settings page panels](#settings-page-panels)
- [Codex warm pool (experimental)](#codex-warm-pool-experimental) ·
  [Codex behind a proxy](#codex-behind-a-proxy)
- [Security notes](#security-notes)
- [Notes / limitations](#notes--limitations)
- [Building from source](#building-from-source)
- [More docs](#more-docs)

## Features

- **Drop-in OpenAI API** — `/v1/chat/completions` (streaming + non-streaming) and
  `/v1/models`, backed by a routing table you define.
- **Live settings page** — model routing, API key, timeout, working directory, activity log,
  all editable without restarting. On its own port, so exposing the API doesn't expose it.
- **Warm process pool for `claude`** — reuses running `claude` processes instead of booting
  one per request, while every request still starts from a blank conversation.
- **Optional warm pool for `codex`** (opt-in) — long-lived `codex app-server` daemons
  instead of a fresh `codex` process per call.
- **Reasoning effort control** — per model default, optional per-request override, and
  thinking content returned as `reasoning_content`.
- **Image and file attachments** — OpenAI-style `image_url` and `file` content parts.
- **Optional built-in web search** per model, without opening up shell/file tools.
- **Recent-activity log** — last 200 requests, optional content capture and disk persistence.

## Configuration

Everything lives in `config.json` (usually `~/.cli-wrapper/config.json`) and is editable
live at `http://localhost:8868/settings`. The file is read fresh on every request, so
editing it by hand works too. Only **API port** needs a restart.

| Setting                                                          | Default                     | Meaning                                                                                                                                 |
| ---------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| API key (`apiKey`)                                               | random, generated first run | Bearer token required on `/v1/*`. Blank disables auth on `/v1/*` (never happens on its own).                                            |
| API port (`apiPort`)                                             | `8869`                      | Port for `/v1/*`. Restart required.                                                                                                     |
| CLI timeout (`cliTimeoutMs`)                                     | `300000` (5 min)            | Hard limit per request; the CLI process is killed after this.                                                                           |
| CLI working directory (`cliWorkdir`)                             | `~/.cli-wrapper/workspace`  | Where the CLIs run. Kept outside any project so they don't pick up a project's `CLAUDE.md`/`AGENTS.md`.                                 |
| Store full prompt/response text (`logCaptureContent`)            | on                          | Whether the activity log keeps request/response content, or only metadata.                                                              |
| Log file path (`logFilePath`)                                    | none (in memory)            | Persist the last 200 log entries to disk. Relative paths resolve against `~/.cli-wrapper/`.                                             |
| Bypass HTTP proxy for OpenAI hosts (`codexBypassProxyForOpenAI`) | off                         | See [Codex behind a proxy](#codex-behind-a-proxy).                                                                                      |
| Codex warm pool (`codexUseWarmPool`, `codexPoolSize`)            | off, `2`                    | See [Codex warm pool](#codex-warm-pool-experimental).                                                                                   |
| Local file roots (`localFileRoots`)                              | empty (disabled)            | Absolute directories requests may attach files from by path. Empty means only base64 attachments work. See [Attachments](#attachments). |

The settings surface and the API use **two separate ports, on purpose**: the settings page
has no auth, so you can keep it on localhost while exposing the API more widely.

| Surface                                   | Default port | Configured via                                                            |
| ----------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| Settings (`/settings`, `/api/settings/*`) | `8868`       | env `SETTINGS_PORT` only — not in `config.json`                           |
| OpenAI API (`/v1/*`)                      | `8869`       | `config.json`'s `settings.apiPort`, or env `PORT` to override for one run |

### Model routing

The `models` array (the "Model routing" table on `/settings`) maps a client-facing `model`
name to a CLI invocation:

| Field                          | Required | Meaning                                                                                                                                                                                                                                            |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                           | yes      | The name clients send as `model`.                                                                                                                                                                                                                  |
| `provider`                     | yes      | `claude` or `codex`.                                                                                                                                                                                                                               |
| `cliModel`                     | yes      | Passed straight to `--model`/`-m` — e.g. `sonnet`/`opus` for claude, `gpt-5.6-sol` for codex. Depends on your login: not every account can use every model.                                                                                        |
| `extraFlags`                   | no       | Raw argv appended verbatim to the CLI invocation — an escape hatch.                                                                                                                                                                                |
| `reasoningEffort`              | no       | Default effort: `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`. Not every value suits every model; an unsupported one isn't rejected, the CLI silently falls back (claude to its default, codex to a level the model supports). |
| `allowReasoningEffortOverride` | no       | Let a request's `reasoning_effort` field override the default. Off by default.                                                                                                                                                                     |
| `enableWebSearch`              | no       | Grant the CLI its built-in web search tool (`claude`'s `WebSearch`, `codex`'s `web_search`).                                                                                                                                                       |
| `description`                  | no       | Free text, shown on the settings page only.                                                                                                                                                                                                        |

[`config.example.json`](./config.example.json) (what a fresh `config.json` is seeded from)
has working examples of each.

### Environment variables

Only three, all optional — everything else is in `config.json`. See `.env.example`.

| Var             | Default                                                                       | Meaning                                                                                      |
| --------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `CONFIG_PATH`   | `./config.json` if one exists and is valid, else `~/.cli-wrapper/config.json` | Path to the config file.                                                                     |
| `SETTINGS_PORT` | `8868`                                                                        | Settings page port. Deliberately not in `config.json`, so the settings page can't change it. |
| `PORT`          | _(unset — uses `apiPort`, default `8869`)_                                    | Overrides the API port for this run only. Never affects `SETTINGS_PORT`.                     |

## Using the API

`/v1/chat/completions` and `/v1/models` are on the **API port** (`8869`) and need
`Authorization: Bearer <apiKey>` unless you've blanked the key.

```bash
curl http://localhost:8869/v1/models -H "Authorization: Bearer $API_KEY"
```

Streaming works with `"stream": true` — Server-Sent Events ending in `data: [DONE]`.

`temperature`, `max_tokens`, `top_p` and similar fields are accepted but ignored. With
reasoning effort set, responses include `message.reasoning_content` (or
`delta.reasoning_content` when streaming) whenever the CLI produced visible reasoning text.

### Attachments

User messages can use OpenAI's array-of-parts `content` shape to attach images and files:

```json
{
  "model": "claude-sonnet-5",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in these?" },
        {
          "type": "image_url",
          "image_url": { "url": "data:image/png;base64,iVBORw0..." }
        },
        {
          "type": "image_url",
          "image_url": { "url": "/srv/shared/photo.jpg" }
        },
        {
          "type": "file",
          "file": {
            "filename": "report.pdf",
            "file_data": "data:application/pdf;base64,JVBERi0..."
          }
        },
        {
          "type": "file",
          "file": { "file_data": "file:///srv/shared/notes.md" }
        }
      ]
    }
  ]
}
```

- `image_url.url`: a base64 `data:` URL, a `file://` URL, or an absolute path. Remote
  `http(s)` URLs are not fetched.
- `file.file_data`: a base64 `data:` URL, raw base64, or a `file://` URL. `file_id` (OpenAI's
  Files API) isn't supported.
- **Local paths only work under `localFileRoots`** (empty = disabled). Symlinks are resolved
  before the check. Anyone holding the API key can have the model read any file under these
  directories, so keep them narrow.
- The type is detected from the file's bytes, not its name or declared mime type:

  | Type                      | `claude`                | `codex`                 |
  | ------------------------- | ----------------------- | ----------------------- |
  | PNG / JPEG / GIF / WebP   | native image input      | native image input      |
  | PDF                       | native document         | rejected (400)          |
  | Any other UTF-8 text file | inlined into the prompt | inlined into the prompt |
  | Other binary files        | rejected (400)          | rejected (400)          |

- Limit is 20 MB per attachment, 64 MB for the whole request body. Each CLI's own per-image
  limits are lower and show up as that CLI's own error.
- Attachments are only allowed on `user` messages; other roles may use the array shape with
  text parts only.
- The activity log records an `[Image 1: name]` label for each attachment, never its bytes.
  Inlined text files are logged in full, like any other prompt text.

## Settings page panels

Besides the settings and model routing forms, `http://localhost:8868/settings` shows:

- **Claude process pool** (refreshes every 3s, `GET /api/settings/pool-status`) — every live
  warm `claude` process: PID, model, reasoning effort, web search, busy/idle, uses left
  before it retires, plus how many requests are queued for a free slot.
- **Codex daemon pool** (only when the codex warm pool is on,
  `GET /api/settings/codex-pool-status`) — each `codex app-server` daemon's PID, in-flight
  turns and turns served. With the pool off, codex runs a fresh process per request, so
  there's nothing to show.
- **Recent activity** (refreshes every 4s, `GET`/`DELETE /api/settings/logs`) — the last
  200 requests: model, provider, streaming, status, duration, token usage, errors. **View**
  on a row shows the full prompt and response (if content capture is on). In memory only
  unless a log file path is set.

## Codex warm pool (experimental)

By default each `codex` request spawns a fresh `codex exec` process. Turning on
`codexUseWarmPool` routes requests through a small pool of long-lived `codex app-server`
daemons instead (`codexPoolSize`, default `2`). Each request still gets its own isolated,
ephemeral thread, so nothing bleeds between requests; only the boot cost is saved. It also
gives real token-by-token streaming, which the default path can't.

It's opt-in because `codex app-server`'s protocol has no compatibility promise across codex
versions (the subcommand is still labeled `[experimental]`), so a codex upgrade could break
it. Turning it off doesn't stop already-running daemons; they sit idle until restart. See
`AGENTS.md`'s "Warm codex app-server pool" for the design.

## Codex behind a proxy

If `HTTPS_PROXY` is set and your proxy rejects codex's WebSocket connection, every codex
request wastes ~15–20s on retries before falling back to HTTPS. **Bypass HTTP proxy for
OpenAI hosts** on the settings page adds `chatgpt.com`/`openai.com` to `NO_PROXY` for the codex process
only (measured ~3x faster). Leave it off if your network only allows outbound traffic
through the proxy — then bypassing it would break codex instead of speeding it up.

## Security notes

- **`/settings` has no authentication, by design.** Anyone who can reach its port can read
  and change the model routing and every setting — including the API key that guards
  `/v1/*` — and read past prompts/responses in the activity log if capture is on. This is an
  internal/personal-use tool. Its separate port lets you expose the API while keeping
  settings on localhost, but that's a mitigation: put the settings port behind a network
  boundary or an authenticating reverse proxy if it's ever reachable beyond a trusted host.
- **Conversation content can sit in server memory, and optionally on disk.** Untick "Store
  full prompt/response text in the activity log" to keep the activity log to metadata only. If a log file path
  is set, treat that file as a secret.
- **`localFileRoots`** lets anyone with the API key read files under those directories via
  the model. Keep the list narrow, or empty.

## Notes / limitations

- **Stateless from the outside.** Every request starts a blank conversation and the full
  message history is resent each call — no cross-turn caching. `claude` requests reuse warm
  processes (sent `/clear` before each request, retired after 20–30 uses), which saves the
  ~1–3s CLI boot. `codex` requests spawn a fresh process each time unless the codex warm pool
  is on.
- **Claude pool cap:** at most 20 `claude` processes at once across all models (~300MB RSS
  each when idle). Bursts beyond that queue, bounded by the CLI timeout. `codex` has no cap.
- **Chat-only.** `claude` runs with `--tools ""`; `codex` with `--sandbox read-only`.
  Neither can change your filesystem or run commands through this wrapper. The one opt-in
  exception is web search, which both providers run server-side. `codex` requests also
  switch off everything from your own `~/.codex` setup (plugins, skills, MCP servers,
  connected ChatGPT apps, hooks) and codex's own default-on extras — see AGENTS.md gotcha
  #8, and re-check it after upgrading codex.
- **No function calling / tool use.** Not just unimplemented — both CLIs run their tool
  loop internally and never hand a call back to the client, which OpenAI function calling
  requires. See AGENTS.md.
- **Reasoning content on claude** may be redacted by some accounts/plans even though the
  thinking tokens are billed; `reasoning_content` then just doesn't appear.
- **Codex streaming (default path)** arrives as one content chunk per message rather than
  token by token. The codex warm pool streams real token deltas.
- A hard timeout (CLI timeout, default 5 min) kills any run that takes too long, and the CLI
  process is also killed if the HTTP client disconnects early.

## Building from source

```bash
git clone https://github.com/tdpi95/cli-wrapper.git
cd cli-wrapper
npm install
npm run dev        # runs from source with auto-reload; uses ./config.json
```

To produce the same installable tarball the Releases page ships:

```bash
npm pack           # builds, then writes cli-wrapper-<version>.tgz
npm install -g ./cli-wrapper-<version>.tgz
```

Copy that `.tgz` to a machine without internet access to GitHub and install it the same way
(it still needs npm registry access, or a mirror, to fetch `express`/`dotenv`). Every
`vX.Y.Z` tag is built and attached to a GitHub Release automatically by
[`.github/workflows/release.yml`](.github/workflows/release.yml).

A single self-contained executable (for machines with no Node.js) isn't provided; it would
need bundling with esbuild plus Node's Single Executable Application feature or
`@yao-pkg/pkg`.

## More docs

- [`AGENTS.md`](./AGENTS.md) — contributor guide: file map, conventions, gotchas hit during
  development, and open ideas for future work. `CLAUDE.md` links to it for Claude Code.
