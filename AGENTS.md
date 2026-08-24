# AGENTS.md

Guidance for anyone (human or AI agent) working on this codebase. See `README.md` for
user-facing setup/usage, and `PLAN.md` for the original design rationale. This file is for
people *changing* the code: what it does, why it's shaped this way, sharp edges that have
already bitten us once, and where the obvious next improvements are.

## What this is

An OpenAI-compatible `chat.completions` HTTP API that shells out to the `claude` (Claude
Code CLI) and `codex` (Codex CLI) binaries as one-shot, chat-only subprocesses — no file
edits, no shell execution, no tool use. Every request is stateless: the full `messages[]`
array is flattened into a single prompt and a brand-new CLI process is spawned per request
(see "Is a new process spawned per request?" below — yes, always).

## File map

```
src/
  server.ts          entrypoint — env (just CONFIG_PATH/PORT), config init, workdir, listen
  app.ts             express app assembly + auth middleware wiring (path-scoped, /v1 only)
  env.ts             process.env -> Env: only CONFIG_PATH and an optional PORT override —
                     everything else moved into config.json's `settings` (see config.ts)
  auth.ts            bearer-token check on a live getter (config.getSettings().apiKey), so
                     a key edited on /settings takes effect on the very next request
  config.ts          config.json load (fresh read every call)/save (atomic tmp+rename)/CRUD
                     for both `settings` (server config) and `models` (routing table);
                     initConfig() also seeds a fresh config.json on first run, migrates a
                     pre-settings (version 1) file in place, and generates a random apiKey
                     if one isn't already set — see the "Settings has no auth" section below
  errors.ts          tagged error classes + toApiError() -> OpenAI-shaped {status, body}
  logs.ts            ring buffer of chat-completion request events (for /settings); optional
                     file persistence via initLogPersistence() at startup, retargetable at
                     runtime via setLogPersistPath() when the settings page changes it
  transcript.ts       flattenMessages(): OpenAI messages[] -> {systemPrompt, transcript}
  types/config.ts    ModelMapping / WrapperSettings / WrapperConfig types
  providers/
    types.ts         CliProvider interface shared by both backends
    claude.ts        spawns `claude -p`, parses its JSON / stream-json output
    codex.ts         spawns `codex exec`, parses its --json JSONL output
    index.ts         getProvider(name) factory
  process/run.ts     spawnManaged(): the ONE place timeout/kill/abort-on-disconnect lives
  routes/
    chat.ts          POST /v1/chat/completions (streaming + non-streaming)
    models.ts        GET /v1/models
    settings.ts       /settings + /api/settings/models CRUD
  openai/
    types.ts         subset of the OpenAI request/response/chunk shapes we implement
    transform.ts     RunResult/StreamChunk -> OpenAI JSON / SSE lines
public/settings.html  the entire settings UI — plain HTML/CSS/vanilla JS, no build step
bin/cli-wrapper.js    uncompiled `bin` entrypoint (shebang + `import "../dist/server.js"`),
                     so `npm pack`/`npm install -g` produces a real `cli-wrapper` command
```

## Packaging / distribution

`package.json`'s `files` field whitelists exactly what ships in `npm pack`/`npm install -g`:
`bin/`, `dist/` (build output — `prepack` runs `npm run build` automatically), `public/`,
`config.example.json`, `.env.example`, `README.md`. Notably NOT `src/`, `PLAN.md`,
`AGENTS.md`, `CLAUDE.md` — those stay in the git repo but don't need to ship to a runtime
install. This assumes the target machine already has Node.js (a safe assumption here since
`claude`/`codex` themselves are npm-distributed CLIs) and npm registry access at install
time (to resolve `express`/`dotenv` — the tarball doesn't vendor `node_modules`). See
README's "Shipping to another machine" for the actual commands.

If a target machine truly has no Node.js and a real standalone native executable is ever
needed instead: bundle with `esbuild` into a single file first (this app's ESM + `NodeNext`
module resolution won't feed directly into most packagers), then either use Node's built-in
Single Executable Application feature (must build per-OS/arch, no cross-compiling — you'd
need CI runners or machines for each target platform) or a maintained fork like
`@yao-pkg/pkg` (can cross-compile from one machine, but historically shakier with ESM than
CJS — may need the esbuild output to target CJS). Not started; nobody has asked for it yet
and it's meaningfully more moving parts than the current `npm pack` approach for no benefit
given the Node.js-is-already-required assumption above.

## Conventions worth preserving

- **Never build CLI argv by string concatenation.** Both providers pass argv as a plain
  string array to `spawn(cmd, args, {shell:false})`. This is what makes arbitrary user
  prompt content (quotes, backticks, `$()`, newlines) safe to pass straight through — don't
  reintroduce a shell anywhere in this path.
- **All timeout/kill/abort logic lives in `process/run.ts`, once.** If you add a third
  provider, route it through `spawnManaged()` rather than calling `child_process.spawn`
  directly — that's the sole backstop against a hung subprocess.
- **`config.ts` reads `config.json` fresh on every call.** No cache, no `fs.watch`. This is
  intentional — the file is tiny and read once per HTTP request, and "always read fresh"
  is simpler to reason about than cache invalidation. Don't add caching without a reason.
  This now applies to `settings` (apiKey/cliTimeoutMs/cliWorkdir/etc.) as much as `models`:
  `chat.ts` calls `getSettings()` at the top of every request rather than reading a value
  captured once at server startup, specifically so edits made on /settings apply to the
  very next request with no restart.
- **Auth is applied by URL path prefix in `app.ts`, never inside a router via a bare
  `router.use(authMw)`.** See the gotcha below for why — this one actually broke auth
  during development and is easy to reintroduce by accident when adding a new route group.
  It's also now scoped to `/v1` only — see "Settings has no auth, by design" below.

## Settings has no auth, by design

`/settings` and `/api/settings/*` are mounted with no auth middleware at all (see `app.ts`)
— this was an explicit request, not an oversight. Only `/v1/*` is guarded, by
`bearerAuth(() => getSettings().apiKey)` in `auth.ts`, which re-reads the key from
`config.json` on every request (not a value captured once at boot) so that changing the key
on the settings page takes effect immediately, with no restart and no way to get locked out
by an in-flight process holding a stale key.

Consequences worth remembering when touching this code:
- The settings page can read *and change* the very API key that protects `/v1/*` — there is
  no separate credential protecting the settings surface itself. Don't add one without
  removing this section; if that ever changes, the "no login required" framing throughout
  the settings UI copy and README needs to change with it.
- `config.ts`'s `initConfig()` never leaves `apiKey` empty on its own — on first run (or
  migrating a pre-settings config) it generates a random one via `crypto.randomBytes` if the
  seed/legacy env didn't supply one, and logs it once to the console. An empty `apiKey` (auth
  fully disabled on `/v1/*`) only ever happens because someone explicitly blanked the field
  on `/settings` and saved — never as a silent default.
- Because there's no token gate, don't add anything to `/api/settings/*` that assumes the
  caller is trusted beyond "can reach this HTTP server" — e.g. don't have it exec anything,
  read arbitrary paths, etc.

## Gotchas already hit (verified live, not hypothetical — read before refactoring nearby code)

These are documented in detail as comments at their fix sites, but the summary:

1. **`req.on('close')` is not "client disconnected."** `req` (`IncomingMessage`) is a
   Readable stream and emits `'close'` once its body has been fully read by
   `express.json()` — which happens almost instantly for any normal request, streaming or
   not. Using it to detect early client disconnect kills every subprocess immediately.
   Use `res.on('close')` guarded by `!res.writableEnded` instead (see `routes/chat.ts`).

2. **Router-scoped middleware via `router.use(mw)` is not path-scoped to that router's
   routes** when the router itself is mounted at app-root `/`. Express runs `mw`
   unconditionally for *any* request that reaches that mount point, before it even checks
   whether the router has a matching route — so the first such router registered
   effectively hijacks every request for every path. Auth must be scoped at the `app.use(path,
   mw)` level (see `app.ts`), where Express's own path matching does the filtering before
   the middleware ever runs.

3. **`codex exec` has no `-a`/`--ask-for-approval` flag** (that flag exists on the
   top-level interactive `codex` command, not `exec`). `exec` never prompts by nature;
   `--sandbox read-only` alone is what prevents writes/exec.

4. **Model ids are account-dependent, not universal.** `gpt-5-codex` errors as unsupported
   on a ChatGPT-plan Codex login (`"The 'gpt-5-codex' model is not supported when using
   Codex with a ChatGPT account"`); the actual default for such an account was `gpt-5.5`
   from `~/.codex/config.toml`. Don't hardcode model ids into code or docs as if they were
   universal — `config.json`/`config.example.json` are the only place they should live, and
   they should be re-verified against `codex features list` / the account in use before
   shipping a default.

5. **`codex`'s stderr is noisy on success.** A websocket→HTTPS transport fallback (`405
   Method Not Allowed` on `wss://chatgpt.com/...`) logs several ERROR lines to stderr on
   *every* call in some network environments, adding ~15–20s of latency before the real
   response starts, even when the run succeeds. Never treat non-empty stderr, or a
   `item.completed`/`type:"error"` JSONL event, as fatal by itself for codex — only "no
   `agent_message` ever arrived" is failure (see `providers/codex.ts`).

## Is a new CLI process spawned per request?

Yes, always — see the answer already given in conversation. No pooling, no session resume,
no persistent worker. Every `POST /v1/chat/completions` call flattens the full message
history into one prompt (`transcript.ts`) and spawns a fresh `claude -p` or `codex exec`
with `--no-session-persistence`/`--ephemeral`. This trades away cross-turn prompt caching
and pays a fresh CLI-boot cost every call, in exchange for zero session-state bookkeeping
and no risk of leaking/colliding sessions across concurrent requests. See "Open
optimizations" below for what changing this would look like.

## Open optimizations for future development

Roughly ordered by likely value; none of these are started.

### Performance / cost
- **Session reuse for multi-turn conversations.** Keep a server-side map of some
  client-supplied conversation key (OpenAI's API has no native field for this — would need
  a custom header, or reuse of the `user` field, or an extension field) → the CLI's own
  session id, and use `claude --resume <id>` / `codex exec resume <id>` instead of
  re-flattening and re-sending the whole history every time. Would recover cross-turn
  prompt caching and cut the growing-transcript cost, at the price of real session
  lifecycle management (expiry, cleanup, concurrent-use-of-one-session handling).
- **Warm process pool** to avoid paying CLI boot cost (auth check, MCP/tool init even
  though tools are disabled, and codex's ~15–20s websocket-fallback delay in some network
  environments) on every single call. Much harder than session reuse to do safely given
  `-p`/`exec`'s one-shot-per-invocation design — would likely need the CLIs' own
  server/daemon modes (e.g. `codex mcp-server`/`app-server`) rather than repeated `exec`.
- **Per-provider concurrency limits / queuing.** There's currently no cap on how many
  subprocesses can run at once — a burst of requests spawns a matching burst of `claude`/
  `codex` processes. Fine for a personal/internal wrapper, not fine if this is ever exposed
  more broadly.

### Correctness / robustness
- **Concurrent `config.json` writes aren't mutex'd.** The atomic tmp-file+rename in
  `config.ts` prevents corruption, but two near-simultaneous writes — `PUT
  /api/settings/config` racing a `POST`/`PUT`/`DELETE` on `/api/settings/models`, or two of
  either — can still race (last-write-wins, one edit silently lost). A simple in-process
  promise-chain mutex around `saveConfig` would close this; low cost, currently skipped
  because the settings UI is single-operator by design.
- **No automated tests.** `transcript.flattenMessages` and both providers' JSONL parsers
  are pure-ish and highly testable against recorded fixture output (several real JSONL
  transcripts are in this conversation's history and could seed fixtures) — currently only
  manually curl-verified. Would catch regressions like gotcha #1/#2 above before they reach
  a live test.
- **Mid-stream error framing is a pragmatic hack.** OpenAI has no standard shape for "an
  error happened after the stream already started" — `routes/chat.ts` currently writes a
  non-standard `data: {"error": {...}}` line and ends the stream. Worth checking what
  actual OpenAI-client SDKs do when they receive that, and adjusting if it's mishandled
  (e.g. some clients may expect the stream to just end abruptly, or expect an `error`
  field alongside a `chat.completion.chunk` shape rather than instead of one).
- **Shared `settings.cliWorkdir` across all concurrent requests.** Both CLIs are
  read-only/no-tools so this hasn't caused an actual collision, but if tool access is ever
  enabled for either provider (see below) this needs to become a per-request temp directory
  instead.

### Features
- **Model discovery instead of hand-maintained `config.json`.** Could shell out to `codex
  features list` / introspect `claude`'s available model aliases at startup (or on-demand
  from the settings UI) to suggest valid `cliModel` values instead of requiring the
  operator to already know them — would have caught gotcha #4 automatically.
  Note: as of Codex CLI 0.146.0, `features list` only enumerates feature flags, not model
  ids — this would need a different introspection point (or scraping `config.toml`) to be
  useful for model discovery.
- **`stream_options.include_usage` support** — currently not implemented; usage is only
  returned in non-streaming responses, matching baseline OpenAI behavior but not the
  opt-in extension some clients use.
- **Optional agentic/tool mode** was explicitly scoped out of v1 (see `PLAN.md`'s Context
  section) in favor of pure chat completions. If ever revisited: needs a real sandboxing
  decision (per-request temp workdir at minimum, likely a container or VM boundary given
  HTTP exposure), a way to surface tool-call events in OpenAI's `tool_calls` response
  shape, and a hard rethink of the "never hangs" guarantee once approval prompts become a
  real possibility again.
- **Graceful shutdown.** `server.ts` has no `SIGTERM`/`SIGINT` handler — in-flight
  subprocesses aren't given a chance to finish or be cleanly killed on process exit today;
  they'd just become orphaned or die with their parent depending on OS behavior. Worth
  adding an explicit shutdown hook that tracks in-flight `spawnManaged` processes and
  terminates them.
- **`logs.ts`'s event log is intentionally minimal** (ring buffer capped at 200,
  chat-completions only, no filtering/search in the UI). It stores full request/response
  content (`input`/`output` on `LogEntry`, viewable per-row in the settings UI via a "View"
  button) by default, meaning **sensitive conversation content sits in server memory** and
  is readable by anyone who can reach `/settings` at all — see "Settings has no auth" above
  and the callout in README.md. Turning off `settings.logCaptureContent` (settings page
  checkbox, or `PUT /api/settings/config`) disables this: `chat.ts` still logs full metadata
  (model/provider/status/duration/usage) but omits `input`/`output` entirely rather than
  truncating or redacting them.
  Persistence is opt-in via `settings.logFilePath` (settings page field, or `PUT
  /api/settings/config`): `null`/unset (default), the buffer is exactly as before —
  in-memory only, nothing touches disk. Set at startup, `logs.ts` loads the file
  (`initLogPersistence`, called once from `server.ts`) and rewrites the whole (still
  ≤200-entry) buffer to it — atomically, tmp+rename like `config.ts` — after every
  `addLogEntry`/`clearLogEntries` call. Changed later at runtime via the settings page,
  `settings.ts`'s PUT handler calls `setLogPersistPath()` instead, which switches the target
  path and writes the current buffer there immediately, deliberately *without* loading
  that file's prior contents (avoids double-counting entries — see the comment on
  `setLogPersistPath`). A write failure is logged and swallowed (`persist()` never throws
  into the request path); a corrupt/unreadable file at startup logs a warning and starts
  from an empty log rather than crashing. Both settings surface via `GET
  /api/settings/meta`, shown live on the settings page. **If both are on, the log file
  contains full plaintext conversation content on disk** — treat it like any other secret,
  keep it out of version control (already in `.gitignore` for the suggested default name).
  Reasonable next steps if this needs to grow further: rotate/cap the file by size instead
  of only entry count, move to SQLite if query/filter needs grow, add filtering by
  model/provider/status/time-range in the settings UI instead of scanning the raw table,
  and consider Server-Sent Events for the UI instead of 4s polling if activity volume grows
  enough for polling lag to matter.
