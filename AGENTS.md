# AGENTS.md

Guidance for anyone (human or AI agent) working on this codebase. See `README.md` for
user-facing setup/usage. This file is for people *changing* the code: what it does, why it's
shaped this way, sharp edges that have already bitten us once, and where the obvious next
improvements are.

## What this is

An OpenAI-compatible `chat.completions` HTTP API that shells out to the `claude` (Claude
Code CLI) and `codex` (Codex CLI) binaries as one-shot, chat-only subprocesses — no file
edits, no shell execution, no tool use. Every request is stateless: the full `messages[]`
array is flattened into a single prompt and a brand-new CLI process is spawned per request
(see "Is a new process spawned per request?" below — yes, always).

## File map

```
src/
  server.ts          entrypoint — env (CONFIG_PATH/PORT/SETTINGS_PORT), config init, workdir,
                     builds and listens on two separate apps/ports (see app.ts)
  app.ts             builds two separate express apps — buildApiApp() (/v1/*, auth-guarded)
                     and buildSettingsApp() (/settings, /api/settings/*, no auth) — see "Two
                     ports, by design" below
  env.ts             process.env -> Env: CONFIG_PATH, an optional PORT override (API port
                     only), and SETTINGS_PORT (settings surface's own port, default 8868) —
                     everything else moved into config.json's `settings` (see config.ts)
  auth.ts            bearer-token check on a live getter (config.getSettings().apiKey), so
                     a key edited on /settings takes effect on the very next request
  config.ts          config.json load (fresh read every call)/save (atomic tmp+rename)/CRUD
                     for both `settings` (server config) and `models` (routing table);
                     initConfig() also seeds a fresh config.json on first run, migrates a
                     pre-settings (version 1) file and a pre-port-split (single `port` field)
                     file in place, and generates a random apiKey if one isn't already set —
                     see "Settings has no auth" and "Two ports, by design" below
  errors.ts          tagged error classes + toApiError() -> OpenAI-shaped {status, body}
  logs.ts            ring buffer of chat-completion request events (for /settings); optional
                     file persistence via initLogPersistence() at startup, retargetable at
                     runtime via setLogPersistPath() when the settings page changes it
  transcript.ts       flattenMessages(): OpenAI messages[] -> {systemPrompt, transcript}
  types/config.ts    ModelMapping / WrapperSettings / WrapperConfig types
  providers/
    types.ts         CliProvider interface shared by both backends
    claude.ts        thin adapter — delegates straight to process/claudePool.ts
    codex.ts         default: spawns `codex exec` fresh per request, parses its --json JSONL
                     output; delegates to process/codexAppServer.ts instead when
                     WrapperSettings.codexUseWarmPool is on (opt-in, off by default)
    index.ts         getProvider(name) factory
  process/
    run.ts           spawnManaged(): one-shot subprocess timeout/kill/abort-on-disconnect
                     (still what codex.ts's default exec path uses); killWithGrace() is
                     shared with claudePool.ts and codexAppServer.ts
    claudePool.ts    warm claude process pool — keeps `claude -p --input-format
                     stream-json` processes alive across requests, sends "/clear" before
                     every turn, retires each after a random 20-30 uses — see its top-of-
                     file comment for the full design and the "Warm claude process pool"
                     section below
    codexAppServer.ts warm `codex app-server` daemon pool for codex — EXPERIMENTAL, opt-in
                     via codexUseWarmPool (default false); see its top-of-file comment and
                     the "Warm codex app-server pool" section below
    codexProxyBypass.ts codexBypassProxyForOpenAI's NO_PROXY-widening logic, shared by
                     codex.ts's exec path and codexAppServer.ts's daemon spawn
    asyncEventQueue.ts small callback-to-async-generator bridge shared by claudePool.ts's
                     and codexAppServer.ts's streaming paths
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
`config.example.json`, `.env.example`, `README.md`. Notably NOT `src/`, `AGENTS.md`,
`CLAUDE.md` — those stay in the git repo but don't need to ship to a runtime install. This
assumes the target machine already has Node.js (a safe assumption here since
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
- **All "forcibly kill a child process" logic is `process/run.ts`'s `killWithGrace()`,
  once.** `spawnManaged()` (one-shot processes — codex.ts's default exec path, and anything
  else you add) and `process/claudePool.ts`/`process/codexAppServer.ts` (warm claude workers
  and codex daemons, respectively) all call it rather than each rolling their own
  SIGTERM/SIGKILL timer. If you add a third provider that's one-shot like codex's default
  path, route it through `spawnManaged()` directly rather than calling `child_process.spawn`
  yourself.
- **`config.ts` reads `config.json` fresh on every call, and now backfills missing settings
  fields with `DEFAULT_SETTINGS` on every read (`loadConfig()`), not just at `initConfig()`'s
  one-time migration.** No cache, no `fs.watch` — reading fresh is intentional and simpler
  to reason about than cache invalidation, and the same "always correct, not just at
  startup" reasoning is why the default-backfill lives in the read path too: a config.json
  written before a newer settings field existed (e.g. an upgrade that adds one) would
  otherwise leave that field `undefined` forever, since nothing re-migrates an existing file
  on its own. Verified live to matter, not hypothetical: `codexPoolSize` missing from an old
  config fed straight into `Math.max(1, undefined)` (`NaN`), which would have broken
  `codexAppServer.ts`'s daemon-picking `reduce()` on an empty array. Don't add caching
  without a reason. This applies to `settings` (apiKey/cliTimeoutMs/cliWorkdir/etc.) as much
  as `models`: `chat.ts` calls `getSettings()` at the top of every request rather than
  reading a value captured once at server startup, specifically so edits made on /settings
  apply to the very next request with no restart.
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

See "Two ports, by design" below for the other half of this: since this surface has no auth
of its own, it's now also on its own port, so exposing the API more broadly can't accidentally
expose this too just because they used to share one listener.

## Two ports, by design

The settings surface (`/settings`, `/api/settings/*`) and the OpenAI-compatible API
(`/v1/*`) listen on two separate ports, from two separate express apps (`app.ts`'s
`buildSettingsApp()`/`buildApiApp()`, both `listen()`'d independently in `server.ts`) — not
one app on one port with path-scoped auth, which is how this worked before.

- **Why**: path-scoped auth (still applied to `/v1` — see the gotcha #2 below for why it has
  to be `app.use(path, mw)`) only protects requests that are routed by *this* app's Express
  instance in the first place. It does nothing to stop an operator from exposing the single
  shared port more broadly than intended (a firewall rule, a reverse proxy, a cloud
  provider's default security group) and taking the unauthenticated settings surface along
  with it as a side effect — since "Settings has no auth, by design" above means that surface
  is equivalent to full admin access. Splitting the *port*, not just the URL path, means that
  mistake requires exposing two separate ports instead of one, and each port can be
  bound/firewalled independently (e.g. settings on a loopback/private interface only, API on
  a more broadly reachable one).
- **Defaults**: settings surface on `8868` (env `SETTINGS_PORT`, in `env.ts` — see below for
  why it's env-only, not a `config.json` field); API on `8869` (`WrapperSettings.apiPort`,
  in `config.json`, same "requires restart" caveat the single `port` field always had).
  These used to be one shared default (`8868`, "port"); picked 8869 for the API rather than
  reusing 8868 for either surface so the two new defaults never collide with each other out
  of the box.
- **Why `SETTINGS_PORT` is env-only, not `config.json`'s `settings.settingsPort`**: the
  settings surface is what lets you edit `config.json` in the first place — its own port
  can't sensibly live inside the thing it edits (same bootstrap-ordering reasoning as
  `CONFIG_PATH`). More importantly: keeping it out of the live-editable, unauthenticated
  `/api/settings/*` surface means a request to that same unauthenticated surface can never
  change the port that surface itself listens on.
- **`PORT` env var meaning changed**: previously overrode the one shared port; now overrides
  `apiPort` specifically (`env.ts`'s `apiPortOverride`), same as before — doesn't persist to
  `config.json`, same one-per-run semantics as always. Never controls the settings port.
- **Migration** (`config.ts`'s `initConfig()`): a config predating this split has a `port`
  field instead of `apiPort`. Deliberately does **not** carry the old `port` value straight
  over to the new `apiPort` — for the common case where it was still sitting at the old
  shared default (`8868`), that would collide with the new default `SETTINGS_PORT` on the
  same host the moment both listeners start. Resets to the new default (`8869`) instead,
  silently — no console announcement (an earlier version of this migration printed one; removed
  as unnecessary noise). Operators upgrading a customized old `port` should just double-check
  `apiPort` on `/settings` post-upgrade. Verified live: an old-style config with `port: 9999`
  rewrote the file with `apiPort: 8869` and the stale `port` key removed, no console output.
- **Verified live, both ports**: `/settings`/`/api/settings/config` return `200` on the
  settings port and `404` on the API port; `/v1/models` returns `200` (with a valid bearer
  token) on the API port and `404` on the settings port — genuine cross-port isolation, not
  just a routing convention that happens to not be hit.
- **Settings page UI consequence**: the "API base URL" field on `/settings` used to be
  derived from `location.origin` (the settings page's own address) — that's now wrong, since
  it would show the *settings* port, not the API's. It's derived from `location.hostname`
  plus the loaded/saved `apiPort` value instead (`updateApiHostInput()` in `settings.html`,
  called from `fillSettingsForm()` so it updates on every load and every save) — still
  assumes both surfaces run on the same host, which holds for every deployment shape this
  wrapper currently supports.

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

   **Fixing the slow start**: root-caused to a corporate HTTP(S) proxy (set via the
   process's own `HTTPS_PROXY`/`https_proxy`) that rejects codex's WebSocket upgrade to
   `wss://chatgpt.com/backend-api/codex/responses` with `405 Method Not Allowed`. codex
   retries that handshake 5 times with backoff before falling back to plain HTTPS, and pays
   that retry cost on *every single call*, not just the first. Fix:
   `WrapperSettings.codexBypassProxyForOpenAI` (settings page checkbox, default `false`,
   opt-in) widens `NO_PROXY`/`no_proxy` — merged onto whatever the operator's environment
   already has there, both casings — to also cover `chatgpt.com`/`.chatgpt.com`/
   `openai.com`/`.openai.com`, scoped to just the spawned `codex` subprocess's own env
   (`process/run.ts`'s `spawnManaged` `env` option; never the wrapper server's own process
   env, and no effect on the claude provider) — see `providers/codex.ts`'s
   `proxyBypassEnv()`. Read fresh per call like every other setting, so flipping it on
   `/settings` takes effect on the very next request with no restart.
   Verified live with a real corporate proxy in play (`HTTPS_PROXY` pointed at an internal
   proxy that mishandles this specific upgrade), 4 trials each way, driving the actual
   `codexProvider.runNonStreaming` code path directly (not just the raw `codex` CLI):
   `false` → 21.06s / 18.68s / 20.31s / 22.73s, websocket 405 errors on every single run;
   `true` → 6.80s / 8.95s / 6.04s / 6.82s, zero websocket errors — a clean, non-overlapping
   ~3x speedup, not a fluke. Default stays `false`, not silently on: it only helps when (a)
   a proxy is actually in play and mishandling this upgrade, and (b) the host's network
   allows direct, non-proxied egress to those two domains at all — on a network where only
   the proxy has any route out, forcing a bypass would turn "slow" into "broken" instead.

6. **Both CLIs leak this very repo's own context into chat completions if `cliWorkdir`
   sits inside it (as the default `./.cli-wrapper-workspace` does) — and claude leaks it
   even from a directory outside the repo, whenever a request carries no system prompt.**
   Verified live: a plain chat request with an empty system prompt got answers back citing
   this repo's actual AGENTS.md content and a real `git log` commit hash — not a
   hallucination, and not fixed by `--tools ""` or `--setting-sources ""`, which only gate
   tool *execution* and settings.json, not this.
   - **claude**: an omitted/empty `--system-prompt` doesn't mean "no system prompt" — it
     means "fall back to claude's own default 'Claude Code' system prompt," which bakes in
     cwd, git status, and (via CLAUDE.md auto-discovery walking up to the repo root) this
     repo's own `CLAUDE.md`/`AGENTS.md`. Fix: `claudePool.ts` now passes `--system-prompt
     ""` unconditionally at spawn time (it's spawn-time-only, like `--model`) — this alone
     fully neutralizes the default persona/context, confirmed by direct A/B testing. The
     caller's actual system prompt, if any, still reaches the model via
     `buildTurnText()`'s turn-text folding, unaffected by this.
   - **codex**: separately, `codex exec` auto-discovers and injects the nearest `AGENTS.md`
     up the directory tree (a different mechanism from claude's CLAUDE.md — codex does this
     regardless of system-prompt content, since it has no `--system-prompt` flag at all).
     Fix: `providers/codex.ts` now passes `-c project_doc_max_bytes=0`, confirmed live to
     suppress it.
   - Either leak only reproduces when `cliWorkdir` (or a parent of it) contains a
     `CLAUDE.md`/`AGENTS.md`/`.git` — an operator running this wrapper from inside some
     *other* project's checkout would leak *that* project's context instead. The fixes
     above are general, not specific to this repo.

7. **`initConfig()` used to regenerate the API key on every single startup whenever
   `settings.apiKey` was `""` — even when that `""` was already sitting on disk as a
   deliberate prior choice, not a fresh/migrating config.** The bug: the "generate a key if
   blank" check ran unconditionally after loading `raw.settings`, with no way to distinguish
   "this config predates the settings-page feature entirely" (where generating one is
   correct — see first-run/migration below) from "an operator already blanked the field on
   `/settings` and saved" (where it must be left alone). Verified live: wrote a config.json
   with an explicit `"apiKey": ""`, started the server twice, and got a fresh "Generated a
   new API key" message + a rewritten file both times — meaning restarting after
   deliberately disabling `/v1/*` auth silently turned it back on, directly contradicting the
   documented invariant in "Settings has no auth, by design" above. Fixed: generation now
   only happens in the `!raw.settings` branch (a real version-1-style migration, where
   there's no prior explicit choice to respect) or on genuine first-run (`config.json` didn't
   exist yet) — an existing config's `settings.apiKey`, blank or not, is now always respected
   verbatim. Verified live again post-fix: same explicit-`""` config across two startups, no
   regeneration, no rewrite.

## Is a new CLI process spawned per request?

**codex: yes, by default — no, when `codexUseWarmPool` is on.** Every `POST
/v1/chat/completions` routed to a codex model flattens the full message history into one
prompt (`transcript.ts`). By default that spawns a fresh `codex exec --ephemeral` per
request (`providers/codex.ts`'s `runExecNonStreaming`/`runExecStreaming`) — zero
session-state bookkeeping, no risk of leaking/colliding sessions across concurrent requests,
but pays a full CLI-boot cost (plus the ~15–20s websocket-fallback delay from gotcha #5,
before `codexBypassProxyForOpenAI`) every single call. `WrapperSettings.codexUseWarmPool`
(default **false**, EXPERIMENTAL) routes requests through `process/codexAppServer.ts`'s warm
`codex app-server` daemon pool instead — see "Warm codex app-server pool" below for the full
design and why it's opt-in rather than a full replacement the way claude's pool is.

**claude: no, not anymore — see "Warm claude process pool" below.** `providers/claude.ts`
now delegates to `process/claudePool.ts`, which keeps `claude -p --input-format
stream-json` processes alive across requests and reuses them. The full message history is
still flattened and resent on every call exactly as before (no cross-turn prompt caching,
no client-visible behavior change) — only the *process* is reused, not any conversation
state, which is wiped via `/clear` before every single turn.

## Warm claude process pool (`process/claudePool.ts`)

`claude -p` supports `--input-format stream-json`: instead of exiting after one reply, the
process stays alive reading more turns from stdin. Verified live: a cold `claude -p` call
costs ~1-3s of pure process boot/auth-check/tool-init overhead on top of the actual model
API time; a warm process's 2nd+ turn costs ~30-50ms of overhead. Sending `"/clear"` as a
plain turn resets the conversation in ~30ms — confirmed (by asking the model to recall
something from before the clear) that it actually wipes context, not just cosmetic output.

How it's used here — a pool of these warm processes, keyed by `(cliModel, extraFlags)`,
with **`/clear` sent before every single turn** so every HTTP request gets a genuinely blank
slate regardless of what the process handled before it (same statelessness guarantee as the
old one-process-per-request design, just without paying to boot a process each time). Each
worker is retired — not reused — after a random 20-30 uses (chosen once, at spawn time), so
no single process lives forever accumulating state/memory across hundreds of unrelated
conversations; retirement closes stdin and lets the CLI exit on its own EOF (SIGTERM only as
a fallback if it doesn't exit within 3s), since nothing's actually wrong with the process at
that point. Verified live: watched a worker serve exactly its assigned use-count then get
replaced by a fresh PID, with no old process left behind.

Design constraints worth knowing before touching this file:
- **`--model` and `extraFlags` are spawn-time-only** — can't change them on a live process.
  Pools are keyed by the `(cliModel, extraFlags)` combination, not by model-mapping id, so
  two mappings that happen to share both transparently share one pool.
- **`--system-prompt` is ALSO spawn-time-only.** Rather than one pool per distinct system
  prompt (unbounded cardinality — every client could send a different one), the system
  prompt is folded into the turn text itself (`"System: ...\n\nUser: ..."`), the same
  approach `providers/codex.ts` already uses since codex has no system-prompt flag at all.
  Trade-off worth knowing: a system prompt delivered as part of user-turn text may carry
  less weight with the model than claude's dedicated `--system-prompt` channel. If that ever
  matters in practice, the fix is keying pools by a system-prompt hash too (spawning each
  with a real `--system-prompt`), at the cost of more idle processes when clients send many
  distinct system prompts.
- **A worker that times out, gets aborted (client disconnected mid-turn), or exits
  unexpectedly is never returned to the pool — only ever killed.** Reusing a process we
  can't prove finished cleanly risks a later request reading output that belongs to an
  abandoned turn. Only a clean `result` event (whether `is_error` or not — a model-level
  error doesn't mean the process itself is broken) is considered safe to reuse.
  `Worker.broken` is the flag that routes a finished turn to `hardKill()` instead of
  `releaseOrRetire()`.
- **Changing `cliWorkdir` on the settings page only affects newly spawned workers** —
  already-idle warm workers keep the `--cwd` they were spawned with until they retire
  naturally or the server restarts.
- **Capped at `MAX_TOTAL_WORKERS` (20) live processes, across all keys combined — not per
  key.** An idle warm process measures ~280-320MB RSS, so an uncapped burst (or one spread
  across many distinct `cliModel`/`extraFlags` combinations) could exhaust host memory,
  unlike the pre-pool design where each one-shot process exited the moment its request
  finished. A request that arrives with no idle worker to reuse and no room under the cap
  queues (`claudePool.ts`'s `waiters`) rather than failing outright or bypassing the cap
  with an untracked spawn — bounded by the same `opts.timeoutMs`/`opts.signal` every
  in-flight turn already respects, so a queued request can't hang past the request's normal
  timeout. This also (partially) covers "Per-provider concurrency limits/queuing" below for
  claude specifically; codex still has no such cap.
- **Idle workers are killed after `IDLE_TIMEOUT_MS` (30 min) of not being reused.** The
  per-use retirement above bounds a busy worker's total lifetime, but does nothing for a
  worker that goes idle and just sits there — without this, a traffic burst that fills the
  pool and then goes quiet would leave all of it (up to `MAX_TOTAL_WORKERS` processes)
  resident indefinitely, holding memory for no ongoing benefit.
- **Graceful shutdown matters more now than it used to.** A one-shot process only ever
  lived for the duration of one request, so an abruptly killed server orphaning it was a
  narrow window. Warm workers deliberately outlive individual requests, so `server.ts`
  installs `SIGTERM`/`SIGINT` handlers that call `shutdownClaudePool()` before exiting —
  verified live (sent a real SIGTERM to a running server with an active warm worker,
  confirmed the worker was gone, not orphaned). A `SIGKILL`'d server (or a crash) still
  can't run this hook — same caveat any Node process has.
- **Pool status is visible on the settings page** (`getPoolStatus()`, exposed at `GET
  /api/settings/pool-status`, no auth like every other `/api/settings/*` route). A
  point-in-time snapshot of live module state (`allWorkers`/`waiters`) — nothing cached,
  same convention as `config.ts`. Reports `maxTotalWorkers`/`totalWorkers`/`busyWorkers`/
  `idleWorkers`/`queuedWaiters` plus one row per live worker (`pid`, `cliModel`,
  `extraFlags`, `reasoningEffort`, `enableWebSearch`, `busy`, `usesRemaining`) — the last
  four parsed back out of `poolKeyFor`'s own JSON encoding of `worker.key` rather than
  duplicating those fields onto `Worker` itself. `busy` is just `worker.currentTurn !==
  null`. By default codex has nothing to report here (no persistent pool unless
  `codexUseWarmPool` is on — see "Warm codex app-server pool" below for its own, differently
  shaped status panel); the settings page UI says so directly rather than showing an
  empty/misleading table with no explanation. Verified live: the panel showed `busyWorkers:
  1` while a real turn was in-flight and flipped to idle with `usesRemaining` decremented the
  moment it finished.

## Warm codex app-server pool (`process/codexAppServer.ts`) — EXPERIMENTAL, opt-in

`WrapperSettings.codexUseWarmPool` (default **false**) routes codex requests through a warm
`codex app-server` daemon pool instead of `providers/codex.ts`'s default one-shot `codex exec
--ephemeral` per request. Unlike claude, `codex exec` has no stdin-keep-alive mode to build
on (no `--input-format` flag exists on `exec`), so `process/claudePool.ts`'s approach doesn't
port directly — `codex app-server` is a different thing entirely: a JSON-RPC 2.0 daemon
(newline-delimited JSON over stdio) where one long-lived process can run any number of
independent, isolated "threads" without spawning a new OS process per request.

**Why this is opt-in rather than a full replacement the way claude's pool is** (see the
rollout discussion this shipped from): `codex app-server`'s own upstream README
(`codex-rs/app-server/README.md`) states it's *"the interface Codex uses to power rich
interfaces such as the Codex VS Code extension"* — so the core `thread/*`/`turn/*` methods
this file uses are real production surface, not a throwaway experiment (only newer
sub-features — websocket transport, realtime, paginated history, multi-agent — are
individually flagged experimental in that doc). But nothing in it promises method
names/shapes stay stable across codex releases, there's no official client library, and the
top-level `codex app-server` subcommand itself is still labeled `[experimental]` in the
CLI's own `--help`. Defaulting off means a codex CLI upgrade that changes this protocol
can't silently break an existing deployment; an operator opts in after confirming it works
against their installed codex version.

**Verified live** (see the conversation this shipped from for the full investigation,
including pulling the protocol's JSON schema via `codex app-server generate-json-schema`):
- A cold daemon's first turn: ~7s (includes daemon spawn + `initialize` handshake). A second
  turn on the same warm daemon: ~4-6s — beats a fresh `codex exec` process (~6-9s, even with
  `codexBypassProxyForOpenAI` already on) because the daemon's own CLI-boot/auth/model-catalog
  cost is paid once at spawn, not per request.
- **Real concurrency, not just reuse**: 4 fully concurrent turns issued against one daemon
  completed in ~5s total wall-clock (not ~20s additive), each in its own isolated thread with
  no observed state bleed between them. Reproduced through the actual HTTP API too: 4
  concurrent `POST /v1/chat/completions` requests all returned 200 in ~7s total.
- Reasoning effort/summary (`turn/start`'s `effort`/`summary` fields) and web search
  (`thread/start`'s `config: {tools: {web_search: true}}`, the same raw config.toml-style
  override `-c tools.web_search=true` uses) both work identically to the exec path — confirmed
  live with a real web-search turn producing `item/started`/`item/completed` events of
  `type: "webSearch"` and a cited final answer.
- Streaming is **strictly better** than the exec path here: `item/agentMessage/delta` and
  `item/reasoning/summaryTextDelta` notifications carry real token-level deltas, not
  exec's "whole message as one chunk" (codex's JSONL `item.completed` events have no
  finer granularity — see providers/codex.ts's comment on this).
- Graceful shutdown verified: a real `SIGTERM` to the server with two warm daemons and
  in-flight turns killed both `codex app-server` processes cleanly, none left orphaned.

**Design constraints and gotchas specific to this file:**
- **Nothing here is spawn-time-only, unlike claude.** Model, cwd, sandbox, reasoning
  effort/summary, and web-search are all turn/thread-time JSON-RPC parameters, not CLI
  flags baked in at process spawn. So daemons are **not** keyed by
  `(cliModel, extraFlags, reasoningEffort, enableWebSearch)` the way claude's pool is — any
  daemon can serve any request. The pool is just `codexPoolSize` interchangeable daemons,
  picked by least-in-flight-turns.
- **Every request gets its own ephemeral thread and exactly one turn**
  (`thread/start` with `ephemeral: true`, then one `turn/start`) — this is what gives the
  same statelessness guarantee as a fresh `codex exec` process, without paying to boot one.
  Ephemeral threads are **never explicitly deleted**: verified live that calling
  `thread/delete` on one fails (`"thread is not persisted and cannot be deleted"`) — they're
  in-memory only and the daemon cleans them up on its own once nothing references them.
- **The protocol requires a handshake** (documented in the upstream README, easy to miss
  from the schema alone): a single `initialize` request per connection, awaited, then an
  `initialized` notification (no id) before any other call. Skipping the notification
  happened to still work against the codex version this was built against, but it's a real
  spec requirement — sent regardless (`spawnDaemon`'s `daemon.ready`).
- **No hard per-daemon concurrency cap.** Verified live that several concurrent turns on one
  daemon work fine (isolated ephemeral threads, no shared mutable state to race on).
  `codexPoolSize` bounds the number of OS processes (and the blast radius if one dies — see
  below), not concurrency. The upstream protocol documents a `-32001` JSON-RPC error for
  "request ingress saturated" if a daemon really is overloaded; `startEphemeralTurn` retries
  that on a fresh daemon (`MAX_OVERLOAD_RETRIES`, with a short backoff) rather than failing
  the request outright.
- **Shared blast radius, the real trade-off of multiplexing requests onto one process.** A
  daemon that exits unexpectedly (crash, kill, EOF) takes down every turn currently running
  on it, not just one request — `codexPoolSize > 1` bounds how much traffic that can hit at
  once. A dead daemon's slot is simply respawned lazily the next time `acquireDaemon()` needs
  one; there's no proactive restart timer.
- **A timed-out or aborted turn sends `turn/interrupt` and fails immediately** — it does
  **not** wait for the interrupt to confirm before rejecting, same "never hang past the
  request's own timeout" guarantee every other path in this codebase has. Unlike claude's
  pool, the daemon itself is **never killed** for one turn's timeout, since it's shared
  infrastructure serving other concurrent requests — only that one ephemeral thread is
  affected. Not independently verified live that `turn/interrupt` actually stops
  provider-side model/search work rather than just marking the turn interrupted after the
  fact — a known gap, not a confirmed guarantee.
- **No idle-eviction or per-daemon use-count retirement**, unlike claudePool.ts's
  `IDLE_TIMEOUT_MS`/random-20-30-use retirement. Daemons don't accumulate client-visible
  conversation state the way a claude worker without `/clear` would (every thread is
  isolated and ephemeral, so there's nothing to clear — see the "how to clear context" note
  in the conversation this shipped from), so there's no "went stale" correctness condition
  to guard against, only ordinary long-lived-process memory/fd footprint (~150-180MB RSS per
  idle daemon, measured live) held for no ongoing benefit once traffic drops. **Explicitly
  handed off, not fixed here** — see "Idle eviction for codex app-server daemons" under Open
  optimizations below before picking this up.
- **Toggling `codexUseWarmPool` off does not stop already-running daemons.** They sit idle
  (no idle-eviction — see above) until the server restarts. Not currently considered a
  problem worth fixing given the pool is opt-in and low-traffic by construction, but worth
  knowing if you're chasing down an unexpectedly-alive `codex app-server` process after
  flipping the setting off.
- **Pool status**: `getCodexPoolStatus()`, exposed at `GET /api/settings/codex-pool-status`
  (no auth, same as every other `/api/settings/*` route). Reports `enabled`/`poolSize`/
  `totalDaemons`/`totalInFlightTurns` plus one row per live daemon (`pid`, `inFlightTurns`,
  `turnsServed`) — deliberately a different, simpler shape than claude's `PoolWorkerStatus`
  since there's no per-worker `cliModel`/`reasoningEffort`/etc. to report (see "nothing is
  spawn-time-only" above — those are per-request, not per-daemon).
- `process/codexProxyBypass.ts` holds the `codexBypassProxyForOpenAI` env-widening logic,
  factored out of `providers/codex.ts` so both the legacy exec path and this daemon pool's
  spawn can share it without a `process/*` → `providers/*` dependency (this codebase's
  layering only ever goes the other way). `process/asyncEventQueue.ts` is a similar small
  extraction — the callback-to-async-generator bridge both this file's and claudePool.ts's
  streaming paths need, previously duplicated as a private class inside claudePool.ts.

## Reasoning effort control and content (`ModelMapping.reasoningEffort`/`allowReasoningEffortOverride`)

A model mapping can set a default reasoning effort and optionally let a per-request
`reasoning_effort` field (OpenAI's own chat.completions field name for reasoning models)
override it — verified live end-to-end (config round-trip, both providers' spawn args, and
that requests actually landed on the right warm claude process by effort level). When effort
is requested, the actual reasoning/thinking content (when the CLI produces any) is also
captured and returned as `message.reasoning_content` (non-streaming) or `delta
.reasoning_content` chunks (streaming) — the de facto OpenAI-compatible field name several
tools already read (DeepSeek, LiteLLM, Open WebUI), not an official OpenAI field since
chat.completions has no standard one. `RunResult.reasoningText`/`StreamChunk`'s `"reasoning"`
kind carry it internally (`providers/types.ts`); it's `undefined`, never `""`, when nothing
was captured, so "no reasoning happened" and "reasoning happened but content was empty" stay
distinguishable up to the OpenAI response shape, which simply omits the key in the former
case (see `openai/transform.ts`).

- **Shared six-value enum** (`REASONING_EFFORT_VALUES`/`ReasoningEffort` in
  `types/config.ts`): `minimal`/`low`/`medium`/`high`/`xhigh`/`max`. Neither CLI accepts all
  six — claude's `--effort` has no `minimal`, codex's `-c model_reasoning_effort=` has
  neither `xhigh` nor `max` — but same as `cliModel` (gotcha #4), this is validated only for
  typos, not provider/account correctness. Picking a value the mapping's actual provider
  doesn't support surfaces as a CLI-level error at request time, not a config-save-time
  rejection.
- **codex** (`providers/codex.ts`): trivial — it's already a one-shot spawn per request, so
  `-c model_reasoning_effort=<value>` is appended fresh to that request's argv when resolved,
  bundled with `-c model_reasoning_summary=detailed -c show_raw_agent_reasoning=true` (all
  three together — verified live that any one or two alone produce nothing) so its
  `item.completed` events of type `"reasoning"` actually appear. Each is a short summary (not
  raw chain-of-thought — codex/GPT-5 don't expose that), and a turn can emit several before
  its `agent_message`; `consume()` yields each as its own `{type: "reasoning"}` event, joined
  with `\n\n` for the non-streaming `reasoningText`, or forwarded as individual `"reasoning"`
  StreamChunks (each one whole, no token-level deltas — same as `agent_message`) when
  streaming. These overrides are only added when `reasoningEffort` is set, not unconditionally
  — a plain request that never asks for reasoning shouldn't pay for the extra
  summary-generation latency by default.
- **claude** (`process/claudePool.ts`): `--effort` is spawn-time-only like `--model`, so it's
  folded into the pool key — `PoolKeyParts` and `poolKeyFor()` now include `reasoningEffort`.
  Unlike system prompt (deliberately *not* keyed — unbounded cardinality), this is a safe key
  to add: only 6 legal values, a small bounded multiplier on pool size, still capped overall
  by `MAX_TOTAL_WORKERS`. Verified live: two mappings resolving to the same effective
  `(cliModel, extraFlags, reasoningEffort)` tuple shared one warm process; a third mapping
  resolving to a different tuple got its own. A request with no effort resolved gets no
  `--effort` flag at all — identical to pre-this-feature behavior.
- **claude's reasoning content** (`process/claudePool.ts`'s `waitForResult`/
  `TurnDeltaCallbacks`): real `content_block_start`(`type:"thinking"`)/`content_block_delta`
  (`delta.type:"thinking_delta"`) stream-json events exist and are wired up (only possible
  when `--effort` was passed, i.e. `reasoningEffort` was set). **Caveat verified live**: even
  at `--effort max` on opus, the actual `thinking` text came back as an empty string on every
  delta while `usage.output_tokens_details.thinking_tokens` was still non-zero and billed —
  some accounts/plans redact the content but not the cost. `onReasoningDelta` skips empty
  deltas rather than forwarding a stream of no-op `reasoning_content` chunks (verified live:
  without this, a single turn emitted three empty-string `reasoning_content` SSE chunks before
  any real content); whether real thinking text ever comes through depends on the account/
  plan, not on this wrapper's code.
- **Request-time resolution** (`routes/chat.ts`): the mapping's `reasoningEffort` is the
  default; a request's `reasoning_effort` field only overrides it if the mapping has
  `allowReasoningEffortOverride: true`. If that's false, an incoming `reasoning_effort` is
  **silently ignored** — same convention as `temperature`/`max_tokens`/etc. (unsupported
  fields are ignored, not errored) — rather than a 400, since sending it isn't necessarily a
  mistake (some client libraries set it by default). If override *is* allowed but the value
  isn't one of the six, that's a real 400 `invalid_request` — the mapping opted into this
  field being meaningful, so a garbage value is a genuine client error, not a passthrough.
- **Settings page**: the model routing table/form now has a "Default reasoning effort"
  select and an "Allow per-request override" checkbox alongside the existing fields. The
  select's options are rebuilt per-provider client-side (`REASONING_EFFORT_BY_PROVIDER`/
  `populateReasoningEffortOptions()` in `settings.html`) — claude's 5, codex's 4 — purely as
  a UI nicety pointed at the right subset; the server-side validation stays the shared
  6-value enum regardless (see above), so this never blocks a value the API itself would
  accept. Two behaviors that are easy to get backwards if touching this: switching the
  provider dropdown *drops* a previously-selected value that isn't valid for the new
  provider (no `allowExtra`, defaults to the select's current value as "previous"); loading
  an existing mapping for edit instead calls it with `allowExtra: true` so a legacy value
  that's off-list for its own provider (possible since the server never rejected it) is kept
  as an extra option rather than silently disappearing — and reverting to a blank default —
  the moment you open that mapping and save again without touching the field.

## Web search tool (`ModelMapping.enableWebSearch`, both providers)

A model mapping can grant its CLI a real, built-in web search tool — the first (and, as of
this writing, only) exception to claude's blanket `--tools ""`, and codex's first tool grant
of any kind beyond its always-on shell/patch tools. This does **not** reverse the "Tool use
... is an intentional non-goal" stance in the Features section below — that note is about
real function-calling/local-exec tools (Bash/Edit/Write) reopening shell/filesystem access.
Both providers' web search tools are executed **server-side** (Anthropic's own backend for
claude, OpenAI's for codex), not as a local subprocess — claude's shows up as
`server_tool_use.web_search_requests` in the turn's `usage`; codex's as `item.completed`
events of `type:"web_search"` — nothing either CLI's *host* runs, so granting it doesn't
reopen the local-exec risk. It does add a new, narrower one worth knowing for both: the model
can turn conversation content into outbound search queries sent to that provider's search
backend.

### claude

`--strict-mcp-config`/`--setting-sources ""` are untouched, so `WebSearch` is the *only* tool
that can ever become available on a claude mapping, regardless of `enableWebSearch`.

- **How it's spawned** (`process/claudePool.ts`'s `spawnWorker`): when `enableWebSearch` is
  true, `--tools "WebSearch" --permission-mode "bypassPermissions"` is appended to the argv
  *after* the base `--tools "" --permission-mode "default"` every worker gets. claude's CLI
  parser is last-flag-wins (verified live), so this cleanly overrides the base flags rather
  than needing a branch that omits them. `extraFlags` is appended after that, so an
  operator's own explicit flags can still override this too if they need finer control.
- **Why `bypassPermissions` specifically** — verified live against all six
  `--permission-mode` values with `--tools "WebSearch"` and a prompt that reliably triggers a
  search:
  - `bypassPermissions` and `auto` — the tool actually executes; the CLI folds the search
    result back in as a synthetic `tool_result` and continues to a final answer with cited
    sources, all within the same turn (`num_turns: 2` internally). Picked `bypassPermissions`
    as the more literal/explicit "there is no approval gate for what `--tools` already
    allowlists" choice.
  - `default` (what every other worker uses), `dontAsk`, `acceptEdits`, `manual` — all
    silently/explicitly **deny** WebSearch (no TTY to approve from) and the model gracefully
    falls back to a text-only answer. No hang in any of these — useful to know if `default`
    is ever reused with `--tools` set to something non-empty for some other reason.
  - `plan` — **hangs indefinitely**, confirmed live (had to be killed by the test harness'
    own timeout). It waits for an interactive plan-approval round trip that never arrives
    over stdin-only `--input-format stream-json`. `raceWithTimeoutAndAbort` would eventually
    kill a worker stuck here (bounded by `opts.timeoutMs`, same as any other turn), so this
    wouldn't violate the "never hangs past the request timeout" guarantee, but it'd burn the
    full timeout on every single search — never pick this mode for anything spawned here.
- **Pool key**: `enableWebSearch` is part of `PoolKeyParts`/`poolKeyFor`, same reasoning as
  `reasoningEffort` — it's spawn-time-only (can't grant/revoke a tool on a live process), and
  it's a boolean (bounded multiplier on pool size, not unbounded cardinality like system
  prompt). A search-enabled and a non-search-enabled mapping that otherwise share
  `(cliModel, extraFlags, reasoningEffort)` get two separate pools, never one shared worker.
- **No changes needed in the streaming/non-streaming event handling.** `waitForResult` only
  acts on `text_delta`/`thinking_delta` content and resolves on the final `"result"` event —
  every event in between a tool call and the final answer (`content_block_start`
  `type:"tool_use"`, the tool's `input_json_delta`s, the intermediate `system:"requesting"`,
  the synthetic `user` `tool_result` message, a `system:"permission_denied"` if the mode
  denies it) was already covered by the existing catch-all comment on that function and
  required zero code changes — confirmed live by running an actual WebSearch-augmented turn
  through the exact same event-parsing path unmodified.
- **Cost/latency**: only paid on turns where the model actually decides to search (not every
  request) — adds one real Anthropic-billed search call (separate line item from tokens) plus
  the round-trip latency of a second internal model turn, on the order of several extra
  seconds observed live, on top of a plain turn's usual latency.

### codex

- **How it's passed** (`providers/codex.ts`'s `args()`): `enableWebSearch` appends `-c
  tools.web_search=true` — the one-off-override form of a `config.toml` `[tools]` block
  (found by pulling the config schema strings out of the actual codex native binary: a
  `ToolsToml` struct has a `web_search` field). Unlike claude, there's no permission-mode
  fight to have — `codex exec` never prompts for approval regardless of what tools are
  enabled (see gotcha #3) — so this is the only flag needed.
- **Verified live**: `codex exec --json -c tools.web_search=true "..."` produced real
  `item.started`/`item.completed` events of `type:"web_search"` (with the actual query and,
  in one run, a cited article URL suggesting the tool fetches content, not just snippet
  links), followed by an `agent_message` confirming it used the tool and citing sources.
  Reproduced through the actual HTTP wrapper too (a codex mapping with `enableWebSearch:
  true`), both streaming and non-streaming.
- **No changes needed in `consume()`'s event loop either** — same shape as claude's finding:
  the loop only pattern-matches `agent_message`/`reasoning`/`error`/`turn.completed`, and
  silently ignores anything else (see its trailing "ignore" comment) — `web_search` items
  fell through harmlessly with zero code changes required to discover this worked.
- **Not model/account-validated.** The binary's own strings reference
  `supports_standalone_web_search` as a per-model-provider capability flag, and there's an
  `under development` `standalone_web_search` feature flag in `codex features list` that
  wasn't needed to make this work on the account tested here (gpt-5.5, ChatGPT-plan auth) —
  plausible this doesn't work identically on every account/model, same as gotcha #4's
  `gpt-5-codex` situation. Not re-verified across accounts.
- **Settings page**: model routing form/table gained an "Enable web search" checkbox/column
  next to the reasoning-effort controls, applying to either provider.

## Open optimizations for future development

Roughly ordered by likely value; the warm process pool is the main one of these shipped so
far — fully for claude, and experimentally (opt-in, off by default) for codex — see the
bullet below.

### Performance / cost
- **Session reuse for multi-turn conversations.** Keep a server-side map of some
  client-supplied conversation key (OpenAI's API has no native field for this — would need
  a custom header, or reuse of the `user` field, or an extension field) → the CLI's own
  session id, and use `claude --resume <id>` / `codex exec resume <id>` instead of
  re-flattening and re-sending the whole history every time. Would recover cross-turn
  prompt caching and cut the growing-transcript cost, at the price of real session
  lifecycle management (expiry, cleanup, concurrent-use-of-one-session handling).
- **Warm process pool — done for claude (default), and for codex behind an opt-in flag.**
  See "Warm claude process pool" and "Warm codex app-server pool" above. `codex exec` itself
  has no equivalent stdin-keep-alive mode (confirmed live — no `--input-format` flag exists
  on `exec`), so `WrapperSettings.codexUseWarmPool` uses a different mechanism entirely
  (`codex app-server`'s JSON-RPC daemon) rather than an extension of claudePool.ts's
  approach — verified working, meaningfully faster, and handles real concurrency on one
  daemon, but stays opt-in/default-off (unlike claude's pool, which fully replaced the old
  path) because that protocol has no documented backwards-compatibility guarantee across
  codex versions. Remaining gap: no idle-eviction or long-uptime resource bounding on codex
  daemons yet (claude's pool has both) — see that section's gotchas list, and the next bullet
  for the handoff.
- **Idle eviction for codex app-server daemons.** Explicitly deferred, not done.
  `process/codexAppServer.ts` has no equivalent to claudePool.ts's `IDLE_TIMEOUT_MS` (kill an
  idle worker after 30 min of not being reused) or its random 20-30-use retirement — once
  spawned, a daemon lives until the server restarts, whether or not `codexUseWarmPool` is
  still even on (turning it off doesn't stop already-running daemons either). Each idle
  daemon holds ~150-180MB RSS (measured live) for no ongoing benefit once traffic drops.
  Fixing it: `Daemon` already tracks `inFlightTurns`, so the shape would mirror claude's
  `evictIdleWorker` — start a timer when a daemon's `inFlightTurns` reaches 0, clear it on
  reacquire, retire (close stdin, `killWithGrace` fallback) on fire; `acquireDaemon()`
  already respawns lazily on demand, so nothing else needs to change. Low complexity, just
  not done yet because the pool itself is opt-in/low-traffic by construction and this hasn't
  bitten anyone in practice — pick it up whenever codex daemon memory footprint actually
  becomes a real operational concern for whoever's running this.
- **Per-provider concurrency limits / queuing — done for claude via a hard cap+queue; codex
  takes a different, softer approach when its warm pool is on, and has none at all when it's
  off (the default).** `claudePool.ts` caps total warm workers at `MAX_TOTAL_WORKERS` and
  queues requests beyond that. `codexAppServer.ts` doesn't cap concurrency the same way —
  verified live that one daemon handles several simultaneous turns fine — instead
  `codexPoolSize` bounds OS process count/blast-radius, and an upstream-documented `-32001`
  "ingress saturated" error triggers a bounded retry on a fresh daemon rather than a hard
  reject. With the codex pool off (still the default), `codex exec` remains a fresh one-shot
  `spawnManaged` process per request with no cap at all — a burst of codex-routed requests
  spawns a matching burst of `codex` processes. Fine for a personal/internal wrapper, not
  fine if this is ever exposed more broadly with the pool left off.

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
- **Tool use / function calling is an intentional non-goal, not a gap** — verified live, not
  just assumed. Gave `claude -p` `--tools "Bash"` in its default non-interactive permission
  mode and asked it to run a shell command: it auto-executed the tool itself with no prompt
  (`num_turns: 2` internally, a synthetic `tool_result` folded back in, then final text) —
  there's no point where either CLI's `-p`/`exec` invocation stops and hands an unexecuted
  tool call back to an external caller to run and return a result for, which is the entire
  contract OpenAI/Anthropic's real function-calling API depends on. This isn't a missing
  flag; it's how the CLIs' one-shot agent loop is structured. Enabling `--tools` at all would
  also reopen real shell/file execution, conflicting with this wrapper's core "chat-only, no
  agentic tools" guarantee. Not planned; see the conversation this was verified in if
  revisiting — a prompt-based simulation (describe the client's tools in-prompt, parse a
  structured reply back into `tool_calls`) is the only halfway-plausible route found, and
  it's unreliable, not real tool-use semantics.
- **Optional agentic/tool mode** was explicitly scoped out of v1 in favor of pure chat
  completions. If ever revisited: needs a real sandboxing
  decision (per-request temp workdir at minimum, likely a container or VM boundary given
  HTTP exposure), a way to surface tool-call events in OpenAI's `tool_calls` response
  shape, and a hard rethink of the "never hangs" guarantee once approval prompts become a
  real possibility again.
- **Graceful shutdown — partially done.** `server.ts` now has `SIGTERM`/`SIGINT` handlers,
  but they only call `shutdownClaudePool()` (kills warm claude workers — see above). A
  one-shot `spawnManaged` process (codex, currently) that's mid-request when the server
  exits still isn't tracked or terminated — it'll become orphaned or die with its parent
  depending on OS behavior, same as before this change. Closing that gap would mean
  `spawnManaged` registering each process in a shared in-flight set that the shutdown
  handler also drains.
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
