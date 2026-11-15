// End-to-end through the loader's fetch: the engine's URL and body go in, an
// OpenAI answer comes out. Perch is faked at globalThis.fetch.
import { PerchAuthPlugin } from "./index.mjs"

let failures = 0
const ok = (cond, what) => {
  if (cond) console.log(`  ok   ${what}`)
  else {
    failures++
    console.log(`  FAIL ${what}`)
  }
}

const sse = (list) => new Response(list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } })

let seen = null
const real = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes("/api/perch-terminal/model-call")) {
    seen = { url: u, headers: init.headers, body: JSON.parse(init.body) }
    return sse([
      { type: "answer_delta", text: "pong" },
      { type: "done", ok: true, text: "pong", usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    ])
  }
  if (u.includes("/cli-auth/config")) {
    return new Response(JSON.stringify({ ok: true, appUrl: "https://app.perchai.app", supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", providers: ["google", "github"] }), { status: 200, headers: { "content-type": "application/json" } })
  }
  throw new Error(`unexpected fetch ${u}`)
}

const saved = []
const hooks = await PerchAuthPlugin({ client: { auth: { set: async (v) => saved.push(v) } } })
const auth = { type: "oauth", access: "tok-1", refresh: "ref-1", expires: Date.now() + 3600_000, accountId: "me@example.com" }
const getAuth = async () => auth
const loader = await hooks.auth.loader(getAuth)

ok(loader.baseURL === "https://app.perchai.app/v1", "the baseURL is Perch's")

console.log("a chat completion")
const res = await loader.fetch("https://app.perchai.app/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "claude-opus-5.5", messages: [{ role: "user", content: "ping" }] }),
})
const body = await res.json()
ok(res.status === 200, "it answers 200")
ok(body.choices[0].message.content === "pong", "the answer is OpenAI-shaped")
ok(seen.url === "https://app.perchai.app/api/perch-terminal/model-call", "it went to Perch's model-call")
ok(seen.headers.Authorization === "Bearer tok-1", "the bearer token rides along")
ok(seen.body.request.messages[0].role === "system", "the canary reached Perch first")
ok(String(seen.body.request.messages[0].content).startsWith("Source discrimination"), "and it is the canary")
ok(seen.body.request.messages[1].content === "ping", "the messages reached Perch")
ok(seen.body.manualModelOptionId === "anthropic-claude-opus-5-5", "the model is pinned by option id")
ok(seen.body.request.maxTokens === undefined, "no limit was invented")
ok(!saved.length, "a live token is not renewed")

console.log("a streamed turn")
seen = null
const res2 = await loader.fetch(new Request("https://app.perchai.app/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "ping" }], stream: true, max_tokens: 64 }),
}))
const text2 = await res2.text()
ok(res2.headers.get("content-type") === "text/event-stream", "it answers an event stream")
ok(text2.includes('"content":"pong"'), "the delta is OpenAI's")
ok(text2.trimEnd().endsWith("[DONE]"), "it ends with [DONE]")
ok(seen.body.preferredModelId === null, "auto pins nothing upstream")
ok(seen.body.request.maxTokens === 64, "max_tokens became maxTokens")

console.log("a URL that is not chat completions")
const res3 = await loader.fetch("https://app.perchai.app/v1/models", { method: "GET" })
ok(res3.status === 404, `it refuses another path (got ${res3.status})`)

console.log("a request with no messages")
const res4 = await loader.fetch("https://app.perchai.app/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "auto" }) })
ok(res4.status === 400, `it refuses a body with no messages (got ${res4.status})`)

console.log("an upstream refusal")
globalThis.fetch = async (url) => {
  if (String(url).includes("/model-call")) {
    return new Response(JSON.stringify({ error: "You need Pro for this model", errorCode: "starter_model_blocked" }), { status: 403, headers: { "content-type": "application/json" } })
  }
  throw new Error("unexpected")
}
const res5 = await loader.fetch("https://app.perchai.app/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "x" }] }) })
ok(res5.status === 403, `a plan gate stays 403 (got ${res5.status})`)
ok((await res5.json()).error.message.includes("paid plan"), "and says why")

console.log("an expired sign-in")
globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid", msg: "invalid refresh token" }), { status: 400, headers: { "content-type": "application/json" } })
const expired = { type: "oauth", access: "old", refresh: "dead", expires: Date.now() - 1000 }
const loader2 = await hooks.auth.loader(async () => expired)
const res6 = await loader2.fetch("https://app.perchai.app/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "x" }] }) })
ok(res6.status === 401, `a dead refresh token is 401 (got ${res6.status})`)
ok(res6.headers.get("X-Magpie-Sign-In") === "expired", "and marks the account")

console.log("renewal")
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes("/cli-auth/config")) {
    return new Response(JSON.stringify({ ok: true, appUrl: "https://app.perchai.app", supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", providers: ["google", "github"] }), { status: 200, headers: { "content-type": "application/json" } })
  }
  if (u.includes("grant_type=refresh_token")) {
    return new Response(JSON.stringify({ access_token: "tok-2", refresh_token: "ref-2", expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200, headers: { "content-type": "application/json" } })
  }
  throw new Error(`unexpected ${u}`)
}
saved.length = 0
const out = await hooks.auth.refresh({ type: "oauth", access: "tok-1", refresh: "ref-1", expires: Date.now() + 1000 })
ok(out.access === "tok-2" && out.refresh === "ref-2", "refresh returns the new pair")
ok(out.expires > Date.now() + 3000_000, "with its new expiry")

console.log("a CLI sign-in already on the machine")
const { _internal } = await import("./index.mjs")
const cli = _internal.fromAuthFile()
ok(cli === null || (typeof cli.refresh === "string" && cli.expires > 0), "a stored CLI session reads back, or there is none")

globalThis.fetch = real
console.log(failures ? `\n${failures} failed` : "\nall passed")
process.exit(failures ? 1 : 0)
