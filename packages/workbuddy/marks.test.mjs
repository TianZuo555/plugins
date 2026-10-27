// The marks around a chat the desktop makes that aren't the chat itself:
// who began a send (extra_vars.initiator, the first request of a turn
// only), the title its little model is asked for as a conversation starts
// (one auxiliary request a conversation), and the bridge its requests go
// out through (a sidecar Node, for the wire's TLS is the host's — without
// it they go out as they always did).
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"

const real = globalThis.fetch
const setFetch = (mock) => (globalThis.fetch = mock)

// the tests run without the sidecars: no bridge, no auxiliary title asks
process.env.WORKBUDDY_BRIDGE = "off"
process.env.WORKBUDDY_AUXILIARY = "off"

let WorkBuddyAuthPlugin
beforeAll(async () => ({ WorkBuddyAuthPlugin } = await import("./index.mjs")))
afterAll(() => (globalThis.fetch = real))
afterEach(() => {
  globalThis.fetch = real
  process.env.WORKBUDDY_AUXILIARY = "off"
  process.env.WORKBUDDY_BRIDGE = "off"
})

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CHAT = "https://copilot.tencent.com/v2/chat/completions"

const text = (b) => (typeof b === "string" ? b : gunzipSync(b).toString())
const parse = (b) => JSON.parse(text(b))

async function chat(body) {
  const calls = []
  setFetch(async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body })
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  })
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "", model: { providerID: "workbuddy", id: "glm-5.3" }, provider: { info: { id: "workbuddy" } } }, out)
  const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "tok", uid: "u1", expires: Date.now() + 3600_000 }))
  await loader.fetch(CHAT, { method: "POST", headers: new Headers(out.headers), body: typeof body === "string" ? body : JSON.stringify(body) })
  return calls
}

test("a send's first request says the user began it, the turn's later ones say nothing", async () => {
  const body = { model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hello there" }] }
  const first = await chat(body)
  expect(first.length).toBe(1)
  expect(parse(first[0].body).extra_vars).toEqual({ initiator: "user" })
  // the same send again — same turn — carries no initiator
  const step = await chat(body)
  expect(parse(step[0].body).extra_vars).toBeUndefined()
  // a new send — a new user message — begins as the user's again
  const next = await chat({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "another thing" }] })
  expect(parse(next[0].body).extra_vars).toEqual({ initiator: "user" })
})

test("a conversation's start asks wb-lite for a title, once, as the desktop's auxiliary ask", async () => {
  process.env.WORKBUDDY_AUXILIARY = "on"
  const calls = await chat({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "help me with csv parsing" }] })
  await new Promise((r) => setTimeout(r, 20)) // the ask isn't waited for
  const titles = calls.filter((c) => parse(c.body).model === "wb-lite")
  expect(titles.length).toBe(1)
  const h = titles[0].headers
  expect(h.get("X-Agent-Type")).toBe("auxiliary")
  expect(h.get("X-Agent-Purpose")).toBe("conversation_topic")
  expect(h.get("X-Root-Request-ID")).toBeNull()
  expect(h.get("X-Conversation-Request-ID")).toMatch(UUID7)
  expect(h.get("X-Conversation-Message-ID")).toBe(h.get("X-Conversation-Request-ID"))
  expect(parse(titles[0].body).extra_vars).toEqual({ initiator: "agent" })
  expect(parse(titles[0].body).messages[0].content).toContain("help me with csv parsing")
  // the ask rides the main request's trace, with a span of its own
  const main = calls.find((c) => parse(c.body).model !== "wb-lite")
  expect(h.get("X-B3-TraceId")).toBe(main.headers.get("X-B3-TraceId"))
  expect(h.get("X-B3-SpanId")).not.toBe(main.headers.get("X-B3-SpanId"))
  // the conversation's next chat — same first message, so the same
  // conversation — asks for no second title
  const more = await chat({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "help me with csv parsing" }, { role: "assistant", content: "sure" }, { role: "user", content: "same conversation, later" }] })
  await new Promise((r) => setTimeout(r, 20))
  expect(more.filter((c) => parse(c.body).model === "wb-lite").length).toBe(0)
})

test("with a bridge up, a chat goes out through it; the target rides a header", async () => {
  process.env.WORKBUDDY_BRIDGE = "http://127.0.0.1:19999"
  const calls = await chat({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "through the bridge" }] })
  const forwards = calls.filter((x) => x.url === "http://127.0.0.1:19999/forward")
  expect(forwards.length).toBe(1)
  expect(forwards[0].headers.get("x-wb-bridge-target")).toBe(CHAT)
  expect(forwards[0].headers.get("authorization")).toBe("Bearer tok")
  // and with the bridge off, the chat goes out as it always did
  process.env.WORKBUDDY_BRIDGE = "off"
  const direct = await chat({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "direct again" }] })
  expect(direct.every((c) => c.url === CHAT)).toBe(true)
})
