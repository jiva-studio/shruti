import { afterEach, describe, expect, it, vi } from "vitest"
import { useChatStream } from "../useChatStream"

vi.mock("../useWebAuth", () => ({
  useWebAuth: () => ({
    getToken: () => "jwt",
    ensureToken: async () => "jwt",
    resetToken: () => undefined,
  }),
}))

/**
 * Recorded SSE streams played through the site's chat, twice in a row, against
 * the bubbles and the request bodies the site produced for the same bytes.
 * The second send carries the first answer's aliases and attributes back, so
 * the round trip is pinned too.
 */
const FIXTURES = import.meta.glob("@lib/chat/stream/__tests__/fixtures/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

function readText(name: string): string {
  const key = Object.keys(FIXTURES).find((k) => k.endsWith(`/fixtures/${name}`))
  if (key === undefined) throw new Error(`no fixture ${name}`)
  return FIXTURES[key]!
}

const GOLDEN = JSON.parse(readText("site.golden.json")) as Record<string, unknown>

/** Maps as entry arrays, as the site stores them. */
function toPlain(v: unknown): unknown {
  if (v instanceof Map) return [...v.entries()].map(([k, x]) => [k, toPlain(x)])
  if (Array.isArray(v)) return v.map(toPlain)
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) o[k] = toPlain(x)
    return o
  }
  return v
}

describe.each(["site-turn", "tool-rerun", "rate-limited"])("recorded stream %s", (name) => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("renders the recorded bubbles and sends the recorded bodies", async () => {
    const text = readText(`${name}.sse`)
    const bodies: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          bodies.push(JSON.parse(String(init.body)))
          return new Response(new TextEncoder().encode(text), { status: 200 })
        }
        return new Response(JSON.stringify({ state: "error", events: [] }))
      })
    )
    const chat = useChatStream({
      chatBase: "https://chat.test",
      lang: "ru",
      trackId: "tr1",
      freeTurns: 10,
      onScroll: () => undefined,
    })
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    for (const q of ["first question", "second question"]) {
      const sending = chat.send(q)
      await vi.runAllTimersAsync()
      await sending
    }

    // The trace id is random per send, so only its presence is recorded.
    const messages = chat.messages.value.map(({ traceId, ...m }) => ({
      ...(toPlain(m) as Record<string, unknown>),
      traceId: typeof traceId,
    }))
    expect(
      JSON.parse(
        JSON.stringify({
          messages,
          bodies,
          srvLimit: chat.srvLimit.value,
          srvCurrent: chat.srvCurrent.value,
          failed: chat.failed.value,
          turns: chat.turns.value,
        })
      )
    ).toEqual(GOLDEN[name])
  })
})
