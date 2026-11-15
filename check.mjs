// Offline check: the config hook, the request body, and both answer shapes.
// The upstream is faked, so this needs no Perch account.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _internal, PerchAuthPlugin } from "./index.mjs"

let failures = 0
const ok = (cond, what) => {
  if (cond) console.log(`  ok   ${what}`)
  else {
    failures++
    console.log(`  FAIL ${what}`)
  }
}

const hooks = await PerchAuthPlugin({ client: { auth: { set: async () => {} } } })

// ---- config hook -------------------------------------------------------------------
console.log("config")
const cfg = {}
await hooks.config(cfg)
const p = cfg.provider.perchai
ok(p?.npm === "@ai-sdk/openai-compatible", "npm is openai-compatible")
ok(Object.keys(p.models).length === Object.keys(_internal.MODELS).length, "every model is listed")
ok(p.models["claude-opus-5.5"].limit.context === 200_000, "context limit is set")
ok(p.models.auto, "auto is listed")

// a user's own edit survives
const cfg2 = { provider: { perchai: { name: "Mine", models: { mine: { id: "mine", name: "Mine" } } } } }
await hooks.config(cfg2)
ok(cfg2.provider.perchai.name === "Mine", "the user's provider name is kept")
ok(cfg2.provider.perchai.models.mine, "the user's model is kept")
ok(cfg2.provider.perchai.models["auto"], "and the plugin's models are added")

// ---- the request body --------------------------------------------------------------
console.log("callBody")
const body = _internal.callBody(
  { model: "claude-opus-5.5", messages: [{ role: "user", content: "hi" }], max_tokens: 100, temperature: 0.3, stream: true },
  "anthropic-claude-opus-5-5",
)
ok(body.request.messages.length === 2, "the canary is prepended to the caller's messages")
ok(body.request.messages[0].role === "system", "the canary is a system message")
ok(body.request.messages[0].content === _internal.CANARY, "and it is the canary")
ok(body.request.messages[1].content === "hi", "the caller's message follows it")
ok(body.request.maxTokens === 100, "max_tokens becomes maxTokens (the CLI's key)")
ok(!("maxOutputTokens" in body.request), "and not maxOutputTokens")
// The one field that made Perch answer perch_surface_required: a lane on the
// request itself, which the CLI never sends.
ok(!("lane" in body.request), "no lane inside request")
ok(body.lane === "chat", "the lane sits beside request, as the CLI sends it")
ok(body.request.temperature === 0.3, "temperature passes through")
ok(body.request.preferredModelId === "anthropic-claude-opus-5-5", "the option id is pinned in the request")
ok(body.manualModelOptionId === "anthropic-claude-opus-5-5", "and named as the manual pick")
ok(body.clientSurface === "cli", "the surface is the CLI's")
ok(!("stream" in body.request), "stream is not sent upstream")
ok(/^cli-turn-\d+-[a-z0-9]{1,6}$/.test(body.runId), "the run id is the CLI's turn shape")
ok(body.resendAfterOutput === true, "the CLI's resend flag rides along")

const ticketed = _internal.callBody({ messages: [] }, null, null, "tkt-cli-1-abc")
ok(ticketed.runId === "tkt-cli-1-abc", "a minted ticket supplies the run id")
ok(ticketed.attribution === null, "no attribution without a user id")

const auto = _internal.callBody({ model: "auto", messages: [] }, null)
ok(auto.preferredModelId === null && !("manualModelOptionId" in auto), "auto pins nothing")
ok(auto.roostModelChoice === "standard", "auto asks Roost for the standard tier")

const who = { userId: "u-1", workspaceId: "w-1" }
const attributed = _internal.callBody({ messages: [] }, null, who)
ok(attributed.attribution?.userId === "u-1", "attribution carries the user")
ok(attributed.attribution?.workspaceId === "w-1", "attribution carries the workspace")
ok(attributed.attribution?.runId === attributed.runId, "attribution names this turn")
ok(attributed.attribution?.source === "cli", "attribution claims the CLI surface")

console.log("the canary")
const sys = (c) => ({ role: "system", content: c })
const own = { role: "system", content: "You are terse." }
const kept = _internal.withCanary([own, { role: "user", content: "hi" }])
ok(kept.length === 3, "a caller's own system prompt is kept")
ok(kept[0].content === _internal.CANARY, "the canary still leads")
ok(kept[1] === own, "and the caller's prompt follows it, unchanged")
const once = _internal.withCanary([sys(_internal.CANARY), { role: "user", content: "hi" }])
ok(once.length === 2, "a message that already carries the canary is not doubled")
ok(_internal.withCanary(undefined).length === 1, "a body with no messages still gets the canary")

console.log("the host's own boilerplate, and only that")
// Every fixed sentence the harness puts in a system prompt, plus the two
// runtime-context lines.
const boilerplate = [
  "You are an AI agent powered by DeepSeek Harness.",
  "The runtime context names the DeepSeek Harness implementation checkout. The checkout location and current working directory are separate values and may differ; never infer the working directory from the checkout path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.",
  'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", they mean this GUI.',
  "The DeepSeek Harness implementation checkout is at \"/opt/dsh\". Use this checkout only to inspect or extend DSH itself.",
  'You are interacting with the user through the DeepSeek Harness Web GUI at "http://127.0.0.1:57457".',
  'Current DeepSeek Harness implementation checkout: "D:\\\\dsh".',
  'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:57457".',
]
for (const text of boilerplate) {
  const out = _internal.stripBoilerplate(text)
  ok(!/DeepSeek Harness/.test(out), `no boilerplate left in: ${text.slice(0, 46)}…`)
  ok(!/\bDSH\b/.test(out), `no bare DSH left in: ${text.slice(0, 46)}…`)
}
ok(_internal.stripBoilerplate('Current DeepSeek Harness implementation checkout: "D:\\\\dsh".').includes('"D:\\\\dsh"'), "the checkout path survives")
ok(_internal.stripBoilerplate('Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:57457".').includes("57457"), "the GUI URL survives")
ok(_internal.stripBoilerplate("Set DSH_HOME, then run pnpm dsh --profile web; window.__DSH_BOOT__ is injected.") === "Set DSH_HOME, then run pnpm dsh --profile web; window.__DSH_BOOT__ is injected.", "identifiers containing DSH are left alone")
ok(_internal.stripBoilerplate("Read AGENTS.md, then run `dsh web`.") === "Read AGENTS.md, then run `dsh web`.", "ordinary text passes through untouched")

// The user's own words are never edited, in any role, and neither are tool schemas.
const userWords = [
  { role: "user", content: "Why does DeepSeek Harness rewrite my prompt? And what is DSH?" },
  { role: "assistant", content: "DeepSeek Harness is the program you are talking to." },
  { role: "tool", content: "DSH_HOME=C:\\dsh\nDeepSeek Harness 0.1.0" },
]
for (const message of userWords) {
  ok(_internal.stripSystemBoilerplate([message])[0] === message, `a message with role ${message.role} is left exactly as it came in`)
}
const toolSchema = [{ type: "function", function: { name: "read", description: "Reads a file. Powered by DeepSeek Harness.", parameters: {} } }]
const toolSent = _internal.callBody({ messages: [{ role: "user", content: "hi" }], tools: toolSchema }, null)
ok(toolSent.request.tools[0].function.description === "Reads a file. Powered by DeepSeek Harness.", "a tool description is not rewritten")
ok(JSON.stringify(toolSent.request.tools) === JSON.stringify(toolSchema), "tool schemas travel byte for byte")

// The rewrite reaches the wire, and only through a system message.
const sent = _internal.callBody(
  {
    messages: [
      { role: "system", content: "You are an AI agent powered by DeepSeek Harness." },
      { role: "user", content: "Which program am I talking to? Is it DeepSeek Harness?" },
    ],
  },
  null,
)
ok(sent.request.messages[0].content.startsWith("Source discrimination:"), "the canary still comes first")
ok(sent.request.messages[1].content === "You are an AI agent.", "the host's opener is rewritten")
ok(sent.request.messages[2].content === "Which program am I talking to? Is it DeepSeek Harness?", "the user's own question reaches Perch unchanged")
const runtime = _internal.callBody(
  {
    messages: [
      { role: "system", content: [{ type: "text", text: 'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:57457".' }] },
    ],
  },
  null,
)
ok(runtime.request.messages[1].content[0].text.startsWith("Current Web GUI URL:"), "a text part is rewritten in place")
ok(runtime.request.messages[1].content[0].text.includes("http://127.0.0.1:57457"), "the URL in the rewritten line is intact")

console.log("starter models")
const starters = ["deepseek-flash-starter", "glm-5.3-flash-starter", "beam-1.0-starter"]
for (const id of starters) {
  ok(_internal.MODELS[id]?.optionId, `${id} is listed with an option id`)
}
ok(
  _internal.MODELS["deepseek-flash-starter"].optionId === "openrouter-deepseek-deepseek-v4-1-flash-crusoe",
  "the DeepSeek Starter alias pins the crusoe option",
)

// ---- pasting a token ----------------------------------------------------------------
console.log("pasted sign-in")
const claim = (v) => Buffer.from(JSON.stringify(v)).toString("base64url")
const fakeJwt = `x.${claim({ sub: "u-9", exp: 1_800_000_000, email: "me@example.com" })}.y`
const bare = _internal.pastedSignIn({ session: fakeJwt })
ok(bare.access === fakeJwt, "a bare token is the access token")
ok(bare.uid === "u-9", "the uid comes from the token")
ok(bare.accountId === "me@example.com", "the account comes from the token")
ok(bare.expires === 1_800_000_000_000, "the expiry comes from the token")

const whole = _internal.pastedSignIn({
  session: JSON.stringify({ accessToken: fakeJwt, refreshToken: "r-1", expiresAt: 1_700_000_000, email: "a@b.c", userId: "u-1" }),
})
ok(whole.refresh === "r-1", "a pasted session keeps its refresh token")
ok(whole.expires === 1_700_000_000_000, "a pasted session keeps its expiry")
ok(whole.accountId === "a@b.c" && whole.uid === "u-1", "a pasted session keeps its account")

let refused = ""
try {
  _internal.pastedSignIn({ session: "   " })
} catch (e) {
  refused = e.message
}
ok(/nothing was pasted/.test(refused), "an empty paste is refused")

let badJson = ""
try {
  _internal.pastedSignIn({ session: "{ nope" })
} catch (e) {
  badJson = e.message
}
ok(/not valid JSON/.test(badJson), "broken JSON is refused")

// ---- reading the sign-in this machine already has ------------------------------------
// A Supabase session cookie is `base64-<json>`, split across .0/.1 — the exact
// shape the desktop app leaves in its Chromium jar.
const session = {
  access_token: "access-abc",
  refresh_token: "refresh-xyz",
  expires_at: 1_900_000_000,
  user: { id: "u-7", email: "me@example.com" },
}
const cookieValue = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`
const half = Math.ceil(cookieValue.length / 2)
const rows = [
  { name: "sb-abcdefghij-auth-token.0", value: cookieValue.slice(0, half), host_key: "app.perchai.app" },
  { name: "sb-abcdefghij-auth-token.1", value: cookieValue.slice(half), host_key: "app.perchai.app" },
]
const fromJar = _internal.sessionFromCookie(rows)
ok(fromJar?.access === "access-abc", "a split session cookie joins back into the access token")
ok(fromJar?.refresh === "refresh-xyz", "…and keeps the refresh token")
ok(fromJar?.expires === 1_900_000_000_000, "…and converts expires_at from seconds to ms")
ok(fromJar?.accountId === "me@example.com", "…and carries the account's email")
ok(fromJar?.uid === "u-7", "…and the user id")
ok(fromJar?.source === "desktop", "…and says where it came from")
ok(_internal.sessionFromCookie([]) === null, "an empty jar has no session")
ok(_internal.sessionFromCookie([{ name: "unrelated", value: "x".repeat(64), host_key: "app.perchai.app" }]) === null, "unrelated cookies are ignored")
ok(_internal.sessionFromCookie([{ name: "sb-abcdefghij-auth-token.0", value: "base64-not-json", host_key: "app.perchai.app" }]) === null, "an unreadable value yields no session")
ok(_internal.sessionFromCookie([{ name: "sb-abcdefghij-auth-token.0", value: `base64-${Buffer.from("{}").toString("base64url")}`, host_key: "app.perchai.app" }]) === null, "a session without an access token is refused")
ok(Array.isArray(_internal.cookieStores()), "the cookie stores are enumerable")
// Only Perch's own cookies count: another site's Supabase session in the same
// jar must not be joined, renewed, or sent anywhere.
ok(
  _internal.sessionFromCookie(rows.map((r) => ({ ...r, host_key: "some-other-site.example" }))) === null,
  "another site's session in the same jar is refused",
)
ok(
  _internal.sessionFromCookie(rows.map((r) => ({ ...r, host_key: ".perchai.app" })))?.access === "access-abc",
  "a leading dot still marks Perch's domain",
)
ok(
  _internal.sessionFromCookie([
    { name: "sb-abcdefghij-auth-token.0", value: cookieValue, host_key: "evil-perchai.app" },
  ]) === null,
  "a lookalike host is not Perch",
)
ok(
  _internal.cookieStores().every((p) => /perch/i.test(p)),
  "only Perch's own jars are listed, never a browser profile",
)

// The desktop app writes the same session file into its own user-data folder
// instead of ~/.perch, so both paths have to be read.
const tmp = mkdtempSync(join(tmpdir(), "perch-check-"))
const desktopSession = join(tmp, "cli-auth-session.json")
writeFileSync(desktopSession, JSON.stringify({
  version: 1,
  appUrl: "https://app.perchai.app",
  accessToken: "access-desktop",
  refreshToken: "refresh-desktop",
  expiresAt: 1_900_000_000,
  userId: "u-8",
  email: "desktop@example.com",
}), "utf8")
const readBack = _internal.fromAuthFile(desktopSession)
ok(readBack?.access === "access-desktop", "a session file at an arbitrary path reads back")
ok(readBack?.accountId === "desktop@example.com", "…with its account")
ok(_internal.fromAuthFile(join(tmp, "nope.json")) === null, "a missing session file is null")
rmSync(tmp, { recursive: true, force: true })
ok(_internal.sessionFiles().every((p) => p.endsWith("cli-auth-session.json")), "the session files are all session files")

// ---- Perch SSE -> OpenAI ------------------------------------------------------------
const sse = (list) => new Response(list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } })

const perchStream = sse([
  { type: "reasoning_delta", text: "think" },
  { type: "answer_delta", text: "Hel" },
  { type: "answer_delta", text: "lo" },
  { type: "done", ok: true, text: "Hello", provider: "anthropic", model: "claude-opus-5.5", usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
])

console.log("non-streaming")
const one = await _internal.openai({ model: "claude-opus-5.5" }, _internal.events(perchStream))
const oneBody = await one.json()
ok(oneBody.object === "chat.completion", "it is a chat.completion")
ok(oneBody.choices[0].message.content === "Hello", "the text is the answer")
ok(oneBody.choices[0].message.reasoning_content === "think", "the reasoning is carried")
ok(oneBody.usage.total_tokens === 14, "the usage is carried")
ok(oneBody.choices[0].finish_reason === "stop", "it stops")

console.log("streaming")
const two = await _internal.openai({ model: "claude-opus-5.5", stream: true }, _internal.events(sse([
  { type: "answer_delta", text: "Hi" },
  { type: "tool_call_delta", toolCalls: [{ id: "c1", name: "ls", arguments: "{}", sealed: true }] },
  { type: "done", ok: true, text: "Hi", toolCalls: [{ id: "c1", name: "ls", arguments: "{}" }] },
])))
const text = await two.text()
const frames = text.split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""))
ok(frames.at(-1) === "[DONE]", "the stream ends with [DONE]")
const parsed = frames.slice(0, -1).map((f) => JSON.parse(f))
ok(parsed[0].choices[0].delta.role === "assistant", "it opens with the assistant role")
ok(parsed.some((f) => f.choices[0]?.delta?.content === "Hi"), "the text is a delta")
const call = parsed.find((f) => f.choices[0]?.delta?.tool_calls)
ok(call?.choices[0].delta.tool_calls[0].function.name === "ls", "the tool call is a delta")
ok(call?.choices[0].delta.tool_calls[0].index === 0, "the tool call is indexed")
ok(parsed.find((f) => f.choices[0]?.finish_reason)?.choices[0].finish_reason === "tool_calls", "it finishes on the tool call")

console.log("a failed turn")
const bad = await _internal.openai({ model: "claude-opus-5.5" }, _internal.events(sse([{ type: "done", ok: false, error: "no credit", errorCode: "usage_limit_reached" }])))
ok(bad.status === 429, `an exhausted allowance is 429 (got ${bad.status})`)
ok((await bad.json()).error.type === "rate_limit_error", "as a rate-limit error")

console.log("a restarted turn (streaming)")
const restart = await _internal.openai({ model: "claude-opus-5.5", stream: true }, _internal.events(sse([
  { type: "answer_delta", text: "partial" },
  { type: "stream_restart", reason: "same_model_resend" },
  { type: "answer_delta", text: "final" },
  { type: "done", ok: true, text: "final" },
])))
const rtext = await restart.text()
const rframes = rtext.split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, "")).slice(0, -1).map((f) => JSON.parse(f))
ok(rframes.filter((f) => f.choices[0]?.delta?.content).map((f) => f.choices[0].delta.content).join("") === "partialfinal", "a restart appends rather than retracts")

console.log("the turn record")
ok(/^cli-cwd-[0-9a-f]{16}$/.test(_internal.threadId()), "the thread id is the CLI's cli-cwd shape")
ok(_internal.lastUserText([{ role: "user", content: "hi" }]) === "hi", "the prompt is the last user message")
ok(_internal.lastUserText([{ role: "user", content: "a" }, { role: "assistant", content: "x" }, { role: "user", content: "b" }]) === "b", "…the last one, not the first")
ok(_internal.lastUserText([{ role: "user", content: [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "x" } }, { type: "text", text: "b" }] }]) === "a\nb", "…flattened from content parts")
ok(_internal.lastUserText([]) === "", "no user message is an empty prompt")
ok((await _internal.reportTurn("", { runId: "cli-turn-1-a" })) === false, "no token files nothing")
ok((await _internal.reportTurn("tok", {})) === false, "no runId files nothing")

// a filed turn is what the caller sees nothing of: the answer goes out first
const filed = []
const seen = []
const filedRes = await _internal.openai(
  { model: "claude-opus-5.5", stream: true },
  _internal.events(sse([
    { type: "answer_delta", text: "Hel" },
    { type: "answer_delta", text: "lo" },
    { type: "done", ok: true, text: "Hello" },
  ])),
  undefined,
  (t) => {
    seen.push(t)
    return Promise.resolve(true)
  },
)
await filedRes.text()
ok(seen.length === 1, "a streamed turn files exactly one record")
ok(seen[0].status === "completed", "…as completed")
ok(seen[0].assistantText === "Hello", "…carrying the answer")
ok(typeof seen[0].durationMs === "number", "…and how long it took")

const badSeen = []
await (await _internal.openai({ model: "m" }, _internal.events(sse([{ type: "done", ok: false, error: "nope" }])), undefined, (t) => {
  badSeen.push(t)
  return Promise.resolve(true)
})).text()
ok(badSeen[0]?.status === "error", "a refused turn files as failed")
ok(badSeen[0]?.error === "nope", "…with the reason")

// ---- the quota panel ----------------------------------------------------------------
// The live meter is what the desktop app's account page shows; POST /usage without
// run ids reports zero, so the meter is what the panel is built from.
const meter = {
  monthlyTokens: 81_572,
  monthlyCalls: 9,
  monthlyUsd: 0.006,
  roostRolling: { enabled: true, window5hUsd: 0.002, window5hCapUsd: 2.5, window5hNextFreedAt: "2026-11-15T11:30:00.000Z", window7dUsd: 0.006, window7dCapUsd: 7.5, window7dNextFreedAt: "2026-11-21T13:30:00.000Z" },
}
const panels = _internal.meterWindows(meter, 20)
ok(panels[0]?.display === "81,572 tokens · 9 calls · $0.01", "the meter's month totals are shown")
ok(Math.abs(panels[1]?.used - 0.03) < 0.02, "…as a slice of the monthly allowance")
ok(panels[2]?.name === "Five-hour window" && panels[2]?.resetsAt === "2026-11-15T11:30:00.000Z", "…and the rolling windows keep their reset times")
ok(panels[3]?.name === "Weekly window", "…both of them")
ok(_internal.meterWindows({ monthlyTokens: 10, monthlyUsd: 1 }, 0).length === 1, "a meter without rolling caps shows only its total")
ok(_internal.meterWindows({}, 20).length === 0, "an empty meter shows nothing")

console.log(failures ? `\n${failures} failed` : "\nall passed")
process.exit(failures ? 1 : 0)
