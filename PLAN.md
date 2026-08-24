# Node wrapper: Claude Code / Codex CLIs → OpenAI-compatible API

## Context

The user wants a Node.js service that shells out to the already-installed `claude` (Claude Code CLI, v2.1.241, logged in) and `codex` (Codex CLI, v0.146.0, logged in) binaries and exposes the result as an OpenAI-compatible `chat.completions` HTTP API, so existing OpenAI-client tooling can talk to Claude/Codex through a single local endpoint. Confirmed with the user:

- **Chat-only, no agentic tools** — both CLIs must run as pure text-in/text-out, never touching files or shell.
- **Model routing via a `config.json`**, editable through a small **settings UI** (CRUD page) rather than env vars or code changes.
- **Shared bearer token** (`WRAPPER_API_KEY`) protects both the chat API and the settings UI.
- **TypeScript** on Node (v24.11.1 available), built with `tsc`.

The project directory (`/home/lap16152/Documents/Code/cli-wrapper`) is currently empty — this is a greenfield build. All CLI flags and JSON/JSONL event shapes below were verified by directly invoking `claude` and `codex` on this machine (not guessed from docs), including confirming neither CLI hangs waiting for an interactive approval prompt under the chosen flags.

## Framework choice

**Express 4.x** — minimal, well-typed (`@types/express`), trivial raw SSE via `res.write`, no build-step frontend needed for the tiny settings page. No justification for anything heavier given ~5 routes.

## Verified CLI behavior (do not re-derive — use as-is)

### `claude -p` (non-interactive)
- `--output-format json` → single JSON object on stdout after exit: `result` (final text), `is_error`, `stop_reason`, `usage.input_tokens`/`usage.output_tokens`.
- `--output-format stream-json --include-partial-messages --verbose` → JSONL. Key lines:
  - `{"type":"system","subtype":"init",...}` — ignore.
  - `{"type":"stream_event","event":{"type":"message_start",...}}` — emit OpenAI role-chunk.
  - `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}` — **the** incremental text.
  - `{"type":"assistant","message":{...}}` — full snapshot, **ignore** (would duplicate streamed deltas).
  - `{"type":"result","is_error":bool,"result":"<final text>","usage":{...}}` — last line, authoritative for final text/usage/error.
- **Confirmed (this session)**: `claude -p "hello" --tools "" --permission-mode default --output-format json < /dev/null` exits promptly (exit 0, ~3.5s) with no hang — safe to rely on `--tools "" --permission-mode default` as the chat-only, non-hanging combination. Hard timeout (below) remains a mandatory backstop regardless.
- Auth: inherits ambient OAuth session already on this machine — no key plumbing needed.

### `codex exec` (non-interactive)
- `--json` → JSONL. Key lines:
  - `{"type":"thread.started",...}`, `{"type":"turn.started"}` — ignore.
  - `{"type":"item.completed","item":{"type":"error","message":"..."}}` — can appear as a **transient warning** (e.g. websocket→HTTPS transport fallback) even on a fully successful run; do not treat as fatal by itself.
  - `{"type":"item.completed","item":{"type":"agent_message","text":"..."}}` — the final assistant text. **No token-level deltas observed** — treat as a single chunk (still wrapped in OpenAI streaming-chunk framing for API shape compatibility).
  - `{"type":"turn.completed","usage":{"input_tokens":...,"output_tokens":...,...}}` — final usage.
- **Correction from initial design**: `codex exec` has **no `-a`/`--ask-for-approval` flag** (confirmed via `codex exec --help` and a live test — passing it errors with "unexpected argument"). It's not needed: `exec` is inherently non-interactive and never prompts; `--sandbox read-only` alone is sufficient to prevent writes/exec.
- **Confirmed (this session)**: `codex exec "hello" --json --sandbox read-only --skip-git-repo-check --ephemeral -C /tmp < /dev/null` completes successfully (exit 0) with an `agent_message` and `turn.completed`. Note: this environment's websocket transport gets a 405 and falls back to HTTPS, adding **~15–20s of retry delay** before the real response starts — an environment/network characteristic, not a wrapper bug. Factor this into the default timeout (120s default comfortably covers it).
- Auth: inherits ambient login on this machine.

## Project file tree

```
cli-wrapper/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
├── config.example.json              # checked-in seed data
├── config.json                      # created from example on first run (git-ignored)
├── src/
│   ├── server.ts                    # entrypoint: load env, seed config, build app, listen
│   ├── app.ts                       # express app assembly, middleware wiring
│   ├── env.ts                       # env parsing/validation (WRAPPER_API_KEY required-or-exit, PORT, CLI_TIMEOUT_MS, CLI_WORKDIR, CONFIG_PATH)
│   ├── auth.ts                      # bearer-token middleware (header, + ?token= fallback for /settings only)
│   ├── config.ts                    # config.json load (fresh-per-call)/save (atomic tmp+rename), validation
│   ├── errors.ts                    # tagged error classes + toApiError() -> {status, body} OpenAI-style
│   ├── types/config.ts              # ModelMapping, WrapperConfig
│   ├── providers/
│   │   ├── types.ts                 # CliProvider interface, RunOptions, RunResult, StreamChunk
│   │   ├── claude.ts                # ClaudeProvider
│   │   ├── codex.ts                 # CodexProvider
│   │   └── index.ts                 # factory: pick by ModelMapping.provider
│   ├── transcript.ts                # flattenMessages(messages) -> {systemPrompt, transcript}
│   ├── openai/
│   │   ├── types.ts                 # request/response/chunk types (subset used)
│   │   └── transform.ts             # RunResult/StreamChunk -> OpenAI JSON / SSE lines
│   ├── routes/
│   │   ├── chat.ts                  # POST /v1/chat/completions
│   │   ├── models.ts                # GET /v1/models
│   │   └── settings.ts              # GET /settings + /api/settings/models CRUD
│   └── process/run.ts               # spawnManaged(): timeout, SIGTERM->SIGKILL, abort-on-disconnect
├── public/settings.html             # single static page, vanilla JS fetch() CRUD
└── dist/                            # tsc output (git-ignored)
```

## Config schema (`config.json`)

```ts
interface ModelMapping {
  id: string;                 // client-facing model name, e.g. "claude-sonnet-5"
  provider: "claude" | "codex";
  cliModel: string;           // passed to --model / -m
  extraFlags?: string[];      // appended verbatim to argv
  description?: string;
}
interface WrapperConfig { version: 1; models: ModelMapping[]; }
```

`config.example.json` seeds 2-3 mappings (e.g. `claude-sonnet-5`→claude/sonnet, `gpt-5-codex`→codex/gpt-5-codex). `src/config.ts` reads the file fresh on every call (no caching needed — cheap, small file, once per HTTP request) and writes atomically via temp-file + `fs.renameSync`. Validates on save: non-empty unique `id`, `provider` in the allowed set, non-empty `cliModel`; returns a `ValidationError` (400) otherwise.

## Auth (`src/auth.ts`)

- `WRAPPER_API_KEY` env var, **required — refuse to start if unset** (fail loudly rather than silently allow unauthenticated access; document `WRAPPER_API_KEY=dev-secret npm run dev` for local use).
- Compare `Authorization: Bearer <token>` using `crypto.timingSafeEqual` (hash both sides to fixed length first to avoid length-mismatch throws/timing leaks).
- Applies to `/v1/chat/completions`, `/v1/models`, `/settings`, `/api/settings/*`.
- `/settings` and `/api/settings/*` additionally accept `?token=` as a fallback credential (browsers can't set custom headers when navigating) — documented as an accepted internal-tool tradeoff.

## Providers

Shared interface (`src/providers/types.ts`):
```ts
interface RunOptions { cliModel: string; extraFlags?: string[]; systemPrompt: string; transcript: string; timeoutMs: number; workdir: string; signal?: AbortSignal; }
interface RunResult { text: string; usage: {promptTokens:number; completionTokens:number; totalTokens:number}; stopReason: "stop"|"length"|"error"; }
type StreamChunk = {kind:"role"} | {kind:"delta"; text:string} | {kind:"done"; usage; stopReason} | {kind:"error"; message:string};
interface CliProvider { runNonStreaming(opts): Promise<RunResult>; runStreaming(opts): AsyncIterable<StreamChunk>; }
```

**Transcript flattening** (`src/transcript.ts`, shared by both providers): concatenate all `system` messages (joined `\n\n`) into `systemPrompt`; format remaining messages as `User: <content>` / `Assistant: <content>` lines joined by `\n\n` into `transcript` (a stray `tool`-role message — shouldn't occur since tools are disabled — is defensively folded in as `User: [tool result]: <content>` with a server-side warning log, not an error).

- **Claude argv**: `claude -p "<transcript>" --output-format json|stream-json --include-partial-messages --verbose --tools "" --permission-mode default --system-prompt "<systemPrompt>" --model "<cliModel>" --no-session-persistence --strict-mcp-config --setting-sources "" ...extraFlags` (omit `--system-prompt` if empty; use `stream-json` variant only when streaming).
- **Codex argv** (identical for streaming/non-streaming — codex has no per-mode flag; only stdout consumption differs): `codex exec "<prompt>" --json --sandbox read-only --skip-git-repo-check --ephemeral -m "<cliModel>" -C "<workdir>" ...extraFlags`, where `<prompt>` = `System: <systemPrompt>\n\n<transcript>\n\nAssistant:` (omit the `System:` line if empty).
- All argv built as plain string arrays passed to `child_process.spawn(cmd, args, {shell:false, ...})` — never shell-interpolated, so prompt content is injection-safe regardless of quotes/backticks/newlines.
- **Claude parsing**: non-streaming `JSON.parse(stdout)` → map `result`/`usage`/`is_error`/`stop_reason` as shown above. Streaming: `readline` over stdout, forward `content_block_delta` text, ignore `assistant`/`rate_limit_event`, treat the final `result` line as authoritative for usage/stop/error.
- **Codex parsing**: `readline` over stdout regardless of mode; accumulate `agent_message` text (yield as one delta chunk in streaming mode), collect `item.completed` `error` items as non-fatal warnings, use `turn.completed.usage` for final usage. Only fail if the process exits with no `agent_message` ever seen (then surface the last captured warning, or a generic "no output" error). Non-empty stderr alone is never treated as failure (this CLI logs transport retries there even on success, per verified behavior).

## Process execution wrapper (`src/process/run.ts`)

Single `spawnManaged()` helper used by both providers:
- `spawn(cmd, args, {cwd, shell:false, stdio:['ignore','pipe','pipe']})`.
- Hard timeout (`CLI_TIMEOUT_MS`, default `120000`): on fire, `SIGTERM`, then `SIGKILL` after a 3s grace period; surfaces a `TimeoutError`.
- Kills the same way if `opts.signal` (wired to `req.on('close')` via `AbortController`) fires — cleans up on early client disconnect.
- This is the sole place the "never hang" requirement is enforced, independent of CLI-side flags — belt and suspenders.

## OpenAI-shaped I/O (`src/openai/*`)

- Request: `{model, messages[], stream?}` — other OpenAI fields (temperature, max_tokens, etc.) accepted but ignored, documented in README as unsupported passthroughs.
- Non-streaming response: standard `chat.completion` object with `choices[0].message`, `finish_reason`, `usage.{prompt_tokens,completion_tokens,total_tokens}`.
- Streaming: `Content-Type: text/event-stream`; `data: {...}\n\n` chunks — first with `delta:{role:"assistant"}`, subsequent with `delta:{content:"..."}`, final with `finish_reason` set — then literal `data: [DONE]\n\n`. Same `id`/`created` reused across a response's chunks. If an error occurs before any content was sent, respond with a normal HTTP error instead of opening the stream; if it occurs mid-stream (headers already sent), end with `finish_reason:"stop"` and log server-side (HTTP status can't change once streaming started).

## Error mapping (`src/errors.ts`)

| Condition | Status | code |
|---|---|---|
| Missing/bad bearer token | 401 | `invalid_api_key` |
| Unknown `model` | 404 | `model_not_found` |
| Missing `messages`/`model` in body | 400 | `invalid_request` |
| CLI timeout | 504 | `provider_timeout` |
| CLI non-zero exit / crash | 502 | `provider_error` |
| CLI stdout not valid JSON/JSONL | 502 | `provider_bad_response` |
| Claude `is_error` / Codex no `agent_message` | 502 | `provider_error` |

Body shape: `{"error":{"message","type","code"}}`.

## Routes

- `POST /v1/chat/completions` — auth → validate body → look up `ModelMapping` (404 if missing) → `flattenMessages` → pick provider by `mapping.provider` → run (streaming or not) → transform to OpenAI shape.
- `GET /v1/models` — auth → list mappings from `config.json` as `{object:"list", data:[{id, object:"model", owned_by: provider}]}`.
- `GET /settings` — auth (header or `?token=`) → serves `public/settings.html`.
- `GET/POST/PUT/DELETE /api/settings/models[/:id]` — auth → CRUD over `config.json` via `src/config.ts`, atomic writes, 404 on unknown `:id`, 400 on validation failure.
- `public/settings.html` — one static page: table of mappings + add/edit form (id, provider select, cliModel, comma-separated extraFlags, description), delete buttons, vanilla-JS `fetch()` against the API above, re-fetching the full list after each mutation. Reads `?token=` from the page URL and reuses it on all API calls.

## npm scripts / deps

- Deps: `express`, `dotenv`. Dev deps: `typescript`, `@types/node`, `@types/express`, `tsx`.
- `dev`: `tsx watch src/server.ts`; `build`: `tsc -p tsconfig.json`; `start`: `node dist/server.js`; `typecheck`: `tsc --noEmit`.
- `tsconfig.json`: `target: ES2022`, `module`/`moduleResolution: NodeNext`, `outDir: dist`, `rootDir: src`, `strict: true`, `esModuleInterop: true`.
- `.gitignore`: `node_modules/`, `dist/`, `.env`, `config.json`.

## Verification plan (after implementation)

Run with `WRAPPER_API_KEY=test123 npm run dev`, then:
1. `curl -o /dev/null -w '%{http_code}' localhost:8787/v1/models` → `401` (no auth).
2. `curl -H "Authorization: Bearer test123" localhost:8787/v1/models` → seeded model list.
3. Non-streaming chat completion against `claude-sonnet-5` → `choices[0].message.content` populated, `usage` populated, `finish_reason:"stop"`.
4. Streaming chat completion (`stream:true`) against `claude-sonnet-5` via `curl -N` → multiple `data:` lines with incremental `delta.content`, then `finish_reason` chunk, then `data: [DONE]`.
5. Non-streaming and streaming chat completion against a codex-backed model id → single-chunk content (per verified no-token-deltas behavior), completes within default timeout despite the ~15-20s websocket-fallback delay.
6. Unknown `model` → `404 model_not_found`.
7. Set `CLI_TIMEOUT_MS=2000` temporarily, send a request, confirm a `504` arrives around 2s and no orphaned `claude`/`codex` process remains (`ps aux | grep -E 'claude|codex'`).
8. `/settings?token=test123` in a browser: confirm table renders, add/edit/delete a mapping, confirm `GET /v1/models` and `config.json` on disk reflect each change.
9. Start a streaming request, kill the client mid-stream, confirm the spawned subprocess is reaped (no orphan).
