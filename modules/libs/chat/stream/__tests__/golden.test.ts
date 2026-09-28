import { describe, expect, it } from "vitest"
import type { ChatStreamEvent, ChatTurn } from "@lib/contracts"
import { parseSseBlock, splitSseBlocks } from "../sseParser.js"
import { createTurnCards } from "../chatActionFold.js"
import { createFoldState, foldChatEvent } from "../chatStreamFold.js"
import type { ChatFoldEvent } from "../chatFoldEvents.js"
import { buildRequestBody } from "../chatRequestBody.js"

/**
 * Recorded SSE streams, decoded and folded, against the output the mobile app
 * produced for the same bytes. The streams cover every event and action kind
 * the server emits, the fields a client with no local catalog reads, and
 * malformed frames the decoder must drop.
 */
const FIXTURES = import.meta.glob("./fixtures/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

function readText(name: string): string {
  const text = FIXTURES[`./fixtures/${name}`]
  if (text === undefined) throw new Error(`no fixture ${name}`)
  return text
}

function readFixture<T>(name: string): T {
  return JSON.parse(readText(name)) as T
}

/** JSON drops `undefined` members, which is how the recorded output was saved. */
function asJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v))
}

/** Decode the stream as it arrives off the socket: in small byte chunks that
 *  split both frames and multi-byte characters. */
function decodeStream(text: string, chunkBytes: number): ChatStreamEvent[] {
  const bytes = new TextEncoder().encode(text)
  const decoder = new TextDecoder()
  const events: ChatStreamEvent[] = []
  let buffer = ""
  for (let at = 0; at < bytes.length; at += chunkBytes) {
    buffer += decoder.decode(bytes.slice(at, at + chunkBytes), { stream: true })
    const { blocks, rest } = splitSseBlocks(buffer)
    buffer = rest
    for (const block of blocks) {
      const event = parseSseBlock(block)
      if (event) events.push(event)
    }
  }
  return events
}

interface StreamGolden {
  events: unknown
  fold: { yielded: unknown; cards: unknown; state: unknown }
}

describe.each(["full-turn", "rate-limited", "tool-rerun"])("recorded stream %s", (name) => {
  const text = readText(`${name}.sse`)
  const golden = readFixture<StreamGolden>(`${name}.golden.json`)

  it.each([1, 7, 4096])("decodes to the recorded events in %i-byte chunks", (chunk) => {
    expect(asJson(decodeStream(text, chunk))).toEqual(golden.events)
  })

  it("folds to the recorded events, cards and state", () => {
    const cards = createTurnCards()
    const state = createFoldState()
    const yielded: ChatFoldEvent[] = []
    for (const event of decodeStream(text, 7)) {
      const folded = foldChatEvent(event, cards, state)
      if (folded) yielded.push(folded)
    }
    expect(asJson({ yielded, cards, state })).toEqual(golden.fold)
  })
})

describe("recorded request body", () => {
  const golden = readFixture<{ history: ChatTurn[]; body: unknown; bare: unknown }>(
    "request-body.golden.json"
  )

  it("builds the recorded body for a long conversation", () => {
    const body = buildRequestBody(golden.history, "ru", {
      translateCitations: true,
      capabilities: { commentary_card: true },
      sessionId: "s1",
      sessionTitle: "Title",
      userContext: { recent: [1] },
      proactive: { ruleKind: "holiday", ruleDate: "2026-09-28", ruleContext: { a: 1 } },
    })
    expect(asJson(body)).toEqual(golden.body)
  })

  it("builds the recorded body for a single question", () => {
    expect(asJson(buildRequestBody([{ role: "user", content: "hi" }], "en", {}))).toEqual(
      golden.bare
    )
  })
})
