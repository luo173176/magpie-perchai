# Perch for magpie

Runs [Perch](https://perchai.app) accounts as a magpie provider, so `perchai/*` models show up in
the gateway's model list and answer OpenAI chat-completions calls.

## Install

```
magpie plugin add ./            # from this directory
magpie plugin login perchai
```

The provider is `perchai`; the models are `perchai/auto`, the three Starter aliases
(`perchai/deepseek-flash-starter`, `perchai/glm-5.3-flash-starter`, `perchai/beam-1.0-starter`),
the promo model, and every public model Perch lists — 42 in all.

## Signing in

Three methods, and the first one is the usual answer:

- **Use this machine's sign-in** — no prompt, no browser. The plugin reads the Perch session this
  machine already has and stores it. Try this first.
- **Login with Perch** — Supabase PKCE over a loopback listener on `127.0.0.1`. Opens the
  authorization page, catches the code on `/callback`, exchanges it for a session.
- **Paste a Perch token** — paste an access token, or a whole `cli-auth-session.json`. The last
  resort, for a session that lives on another machine.

### Where the machine's sign-in is read from

Three sources, and the freshest one wins:

- `~/.perch/cli-auth-session.json` — written by `perch login` (override the directory with
  `PERCH_CLI_AUTH_DIR`).
- `%APPDATA%\Perch AI Desktop\cli-auth-session.json` — the desktop app writes the very same file
  shape into its own user-data folder. It never touches `~/.perch`, so a sign-in started in the
  desktop app only shows up here. `Perch Terminal` and `perch-desktop` folders are checked too.
- The Perch desktop app's Chromium cookie jar,
  `%APPDATA%\Perch AI Desktop\Network\Cookies`. Perch keeps its Supabase session there as
  `sb-<ref>-auth-token.0` + `.1`; the values are plaintext, so the two halves are joined,
  base64-decoded, and used as the token pair. The same scan also covers Chrome, Edge, Brave and
  Chromium profiles that have signed in to `perchai.app`.

Because the freshest session wins, signing into a different account in the desktop app and then
picking **Use this machine's sign-in** switches the provider to that account. **Login with Perch**
does not do that: picking a provider there means "sign in as this provider's account", so it always
opens the authorization page rather than reusing whatever is already on disk.

Nothing is decrypted and nothing leaves the machine. The jar is copied to a temp file before it is
read (another process holds it open), and the read is skipped when the host has no SQLite module.
The desktop app does not need to be running.

Once found, the pair is stored as the provider's sign-in, so the gateway sees a signed-in account
without any prompt. If a stored sign-in is later dropped, the next request adopts the machine's
sign-in again instead of failing.

`*.supabase.co` hosts are unreachable from some networks: the TLS handshake is reset by SNI. When
that happens the plugin falls back to `bridge.py`, which retries the request through `curl_cffi`
with a Chrome TLS fingerprint until one attempt gets through. That needs Python with `curl_cffi`
installed (`pip install curl_cffi`); set `PERCH_BRIDGE_PYTHON` if `python` is not the right name.
Without it, sign-in and token refresh fail with the connection error and nothing else changes.

## How a call is made

`POST {app}/api/perch-terminal/model-call` with Perch's own request shape, then Perch's SSE events
are translated into OpenAI's:

| Perch event | becomes |
| --- | --- |
| `answer_delta` | `delta.content` |
| `reasoning_delta` | `delta.reasoning_content` |
| `tool_call_delta` / `tool_use_end` | one `delta.tool_calls` with complete arguments |
| `done` | the `finish_reason`, the usage frame, and `[DONE]` |
| `stream_restart` | the text restarts (streaming can only append, so a restart continues) |
| `error` / `done.ok:false` | an `error` frame |

Four details of the request shape are load-bearing, and all four are what the CLI sends:

- **No `lane` inside `request`.** `lane` sits beside `request`. A `lane` on the request itself makes
  Perch answer `perch_surface_required` — it reads that as a call from something other than Perch.
- **A system prompt Perch recognises.** The same gate also fires on a call whose messages it does not
  recognise as its own, and it does not matter how long they are: a 20,000-character prompt of your
  own passes, while a two-line one can be refused. Every request therefore opens with the `CANARY`
  message — a sentence taken from Perch's own prompt — and the caller's own system prompt follows it
  untouched. That is why a request with no system prompt at all still gets an answer.
- **A turn ticket.** Each turn mints one at `/api/perch-terminal/turn-ticket`, runs the call under
  the ticket's `runId`, and sends the ticket back as `x-perch-turn-ticket`. A turn without one still
  goes out, the way the CLI sends it when no ticket can be minted.
- **A `cli-turn` record per turn.** After every call — answered or refused, streaming or not — the
  turn is filed at `POST /api/perch-terminal/cli-turn` with the prompt, the answer, the thread id
  (`cli-cwd-<sha256(cwd)[:16]>`), the run id and the duration. The CLI never runs a model call
  without filing one, so a client that calls `model-call` and files nothing is exactly what an
  outside app replaying Perch's requests looks like from the server — which is the thing accounts
  get suspended for. The record is filed after the answer has gone out, so a caller never waits on
  it, and a failed filing never fails the turn.

## What the caller's host name is replaced with

The harness that drives this plugin writes its own product name into the system prompt — an opener,
a paragraph about its source checkout, a paragraph about its web GUI, and two runtime-context lines
carrying the checkout path and the GUI URL. None of that is anything Perch needs to read, so every
string that leaves for Perch goes through `unbrand()` first: messages, tool descriptions, and the
prompt filed with the turn record.

Only the product name is rewritten. Paths, URLs, commands and identifiers are left exactly as they
are — `dsh web`, `pnpm dsh`, `DSH_HOME` and `window.__DSH_BOOT__` all survive untouched, because the
rewrite matches whole phrases and, for the bare acronym, requires a word boundary that an underscore
does not satisfy. The full list of replacements is the `BRAND` table in `index.mjs`; anything it does
not match passes through byte for byte.

## Accounts Perch has suspended

Perch suspends accounts it believes are being driven through another app or tool. A suspended
account authenticates fine and every hosted model answers `403 not_authorized`; the usage panel says
so instead of showing an empty month, and signing in again does not clear it. The ban is visible at
`GET /api/perch-terminal/account-deletion` as `blockedReason: "banned"`, and the account's
`perch_ai_org_memberships.status` flips to `revoked`. Lifting it is a support matter
(`support@perchai.app`) — nothing on this side can.

That `revoked` row is also why the web app's plan picker locks. The picker renders only when
`useAuth().hasAccess` is true, and `hasAccess` counts memberships whose `status` is `active`; the
select-Starter call it would make (`rpc("perch_ai_select_starter_with_data_notice")`) answers
`{ok:false,error:"banned"}` anyway. So "I can't pick a plan" and "every model 403s" are one
condition, not two, and a new account has to be picked before it is ever used — afterwards it is
already too late.

The evidence Perch acts on is the shape of a session, not a single request. Three accounts were
suspended while this plugin was being built, at the exact timestamps of its first real calls, and
the rule they were suspended under reads "banned for using Perch through another app or tool". The
four details in [How a call is made](#how-a-call-is-made) are what makes a session look like Perch's
own; a turn record in particular is something the real CLI files on every turn and the web app never
files. Whether that is enough is not something this repository can promise — treat a fresh account
as something to spend carefully, not as a supply.

## Making the models show up in an agent

A newly added provider is not automatically ticked for every agent. The gateway lists the models
(`GET /v1/models`) but an agent that is narrowed to "only models picked" will not offer them:

```
magpie provider models perchai deepseek-flash-starter glm-5.3-flash-starter beam-1.0-starter auto
```

Each id is its own argument — a comma-joined list is taken as one unknown id. The ids given replace
the exposed list; prefix an id with `+` to add one and keep the rest. Afterwards `magpie models dsh`
should list the `perchai/*` entries, and the gateway answers them.

## Tests

Two files, both offline — neither touches the network or needs a signed-in account:

```
node --no-warnings check.mjs   # request shape, response translation, cookie joining, the meter
node --no-warnings e2e.mjs     # the loader end to end against a stand-in Perch
```

## Layout

- `index.mjs` — the plugin. `PerchAuthPlugin` is the only export magpie calls; everything else is
  collected in `_internal` so it is not mistaken for a second plugin.
- `opencode.mjs` — re-export only: OpenCode 1.x refuses an entry point that exports anything else.
- `bridge.py` — the TLS fallback described above.
- `check.mjs` — offline checks of the request shape and the response translation.
- `e2e.mjs` — the loader end to end against a stand-in Perch.
