import { describe, expect, it } from "vitest"
import { runChatTurn, type RunChatTurnEvent } from "../runChatTurn.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ChatMessage } from "@lib/domain/chatMessage.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { ChatStreamEvent, IChatStreamClient, IChatTitleService } from "@lib/contracts"

/* --------------------------------------------------------------------- */
/*                                Stubs                                   */
/* --------------------------------------------------------------------- */

function makeMessagesRepo(): IChatMessageRepository {
  const repo: Partial<IChatMessageRepository> = {
    listBySession: async () => [],
    create: async (input) => ({ ...input }) as unknown as ChatMessage,
    updateActionStates: async () => {},
    updateFollowups: async () => {},
    delete: async () => {},
    deleteBySession: async () => {},
    clearAll: async () => {},
    updateFeedback: async () => {},
  }
  return repo as IChatMessageRepository
}

function makeSessionsRepo(): IChatSessionRepository {
  const repo: Partial<IChatSessionRepository> = {
    create: async (input) => ({
      id: input.id,
      title: input.title ?? null,
      createdAt: 0,
      updatedAt: 0,
    }),
    touch: async () => {},
    updateTitle: async () => {},
  }
  return repo as IChatSessionRepository
}

const noopTitle: IChatTitleService = {
  fetchSessionTitle: async () => null,
}

function makeStream(events: readonly ChatStreamEvent[]): IChatStreamClient {
  return {
    async *streamChat() {
      for (const e of events) yield e
    },
  }
}

let idCounter = 0
function idFactory(): ChatMessageId {
  idCounter += 1
  return `msg-${idCounter}` as ChatMessageId
}

async function collect(iter: AsyncIterable<RunChatTurnEvent>): Promise<RunChatTurnEvent[]> {
  const out: RunChatTurnEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

function baseDeps(stream: IChatStreamClient) {
  return {
    sessions: makeSessionsRepo(),
    messages: makeMessagesRepo(),
    stream,
    title: noopTitle,
    buildUserContext: async () => ({}) as never,
    extractFollowups: () => [],
  }
}

function baseInput(signal: AbortSignal) {
  return {
    sessionId: "sess-1" as ChatSessionId,
    text: "hi",
    lang: "en" as const,
    history: [],
    isFirstAssistantTurn: false,
    newMessageId: idFactory,
    signal,
  }
}

/* --------------------------------------------------------------------- */
/*                                Tests                                   */
/* --------------------------------------------------------------------- */

describe("runChatTurn — abort after done (finding #13)", () => {
  it("does NOT relabel a completed answer as stopped when the abort lands after `done`", async () => {
    // The server emits `usage` AFTER the terminal `done`, so the loop
    // reads past `done`. Simulate a user abort firing in that
    // post-terminal window: the stream emits delta + done, then we abort
    // the signal, then a trailing `usage` frame arrives.
    const ctl = new AbortController()
    const stream: IChatStreamClient = {
      async *streamChat() {
        yield { type: "delta", text: "Hello world" } as ChatStreamEvent
        yield { type: "done" } as ChatStreamEvent
        // User taps stop in the gap before the usage frame.
        ctl.abort()
        yield {
          type: "usage",
          scope: "chat",
          current: 1,
          limit: 50,
          resetsAtEpoch: 9999999999,
        } as ChatStreamEvent
      },
    }

    const events = await collect(runChatTurn(baseInput(ctl.signal), baseDeps(stream)))

    const finalised = events.find((e) => e.kind === "finalised")
    expect(finalised).toBeDefined()
    if (finalised && finalised.kind === "finalised") {
      // The answer completed (sawDone) — the abort in the usage wait
      // must NOT mark it stopped/truncated.
      expect(finalised.message.error).toBeUndefined()
      expect(finalised.message.content).toBe("Hello world")
    }
  })

  it("still marks a genuine pre-done abort as stopped", async () => {
    // Abort BEFORE any `done` — the real user-stop case.
    const ctl = new AbortController()
    const stream: IChatStreamClient = {
      async *streamChat() {
        yield { type: "delta", text: "Partial" } as ChatStreamEvent
        ctl.abort()
        // No `done` — the loop breaks on the aborted signal.
        yield { type: "delta", text: " more" } as ChatStreamEvent
      },
    }

    const events = await collect(runChatTurn(baseInput(ctl.signal), baseDeps(stream)))

    const finalised = events.find((e) => e.kind === "finalised")
    expect(finalised).toBeDefined()
    if (finalised && finalised.kind === "finalised") {
      expect(finalised.message.error).toEqual({ kind: "stopped" })
    }
  })
})

describe("runChatTurn — tool re-run resets accumulators (finding #12)", () => {
  it("drops actions/outlines emitted before a tool_start re-run", async () => {
    const stream = makeStream([
      // First pass emits an interactive action…
      {
        type: "action",
        payload: {
          kind: "upgrade_to_pro",
          id: "act-1",
          payload: { reason: "x" },
        },
      } as unknown as ChatStreamEvent,
      // …then the agent re-runs a tool, discarding the first pass.
      { type: "tool_start" } as ChatStreamEvent,
      { type: "delta", text: "Final answer" } as ChatStreamEvent,
      { type: "done" } as ChatStreamEvent,
    ])

    const ctl = new AbortController()
    const events = await collect(runChatTurn(baseInput(ctl.signal), baseDeps(stream)))

    const finalised = events.find((e) => e.kind === "finalised")
    expect(finalised).toBeDefined()
    if (finalised && finalised.kind === "finalised") {
      // The orphaned action from the abandoned pass must not survive.
      expect(finalised.message.actions ?? {}).toEqual({})
      expect(finalised.message.content).toBe("Final answer")
    }
  })
})

/* Wire-shaped `action` SSE frames for the four card kinds, snake_case as
 * the server sends them (the fold maps these onto the finalised message). */
const verseAction = {
  type: "action",
  payload: {
    kind: "verse",
    payload: {
      source_id: "bg",
      tokens: "2.13",
      addr_label: "BG 2.13",
      sanskrit: "dehino 'smin",
      transliteration: "dehino 'smin",
      transliteration_original: undefined,
      translation: { en: "As the embodied soul…" },
      audio_url: "https://cdn/bg_2_13.mp3",
      mt: false,
    },
  },
} as unknown as ChatStreamEvent
const citeAction = {
  type: "action",
  payload: {
    kind: "cite_transcript",
    payload: {
      track_id: "track_x",
      start_ms: 1000,
      end_ms: 2000,
      text: "the soul is eternal",
      mt: true,
      text_original: "душа вечна",
    },
  },
} as unknown as ChatStreamEvent
const commentaryAction = {
  type: "action",
  payload: {
    kind: "commentary",
    payload: {
      ref: 3,
      text: "purport text",
      author_name: "Prabhupada",
      addr_label: "BG 2.13",
      kind: "commentary",
      mt: false,
    },
  },
} as unknown as ChatStreamEvent
const chapterAction = {
  type: "action",
  payload: {
    kind: "chapter",
    payload: {
      source_id: "bg",
      region_token: "1",
      region_label: "Canto 1",
      chapters: [{ tokens: "1", title: "Creation" }],
    },
  },
} as unknown as ChatStreamEvent

describe("runChatTurn — card bodies persisted onto the finalised message", () => {
  it("accumulates verse/cite/chapter/commentary maps under their join keys", async () => {
    const stream = makeStream([
      verseAction,
      citeAction,
      commentaryAction,
      chapterAction,
      { type: "delta", text: "answer" } as ChatStreamEvent,
      { type: "done" } as ChatStreamEvent,
    ])
    const ctl = new AbortController()
    const events = await collect(runChatTurn(baseInput(ctl.signal), baseDeps(stream)))

    const finalised = events.find((e) => e.kind === "finalised")
    expect(finalised).toBeDefined()
    if (finalised && finalised.kind === "finalised") {
      const m = finalised.message
      expect(m.verses?.["bg|2.13"]).toMatchObject({ addrLabel: "BG 2.13", mt: false })
      expect(m.cites?.["track_x|1000-2000"]).toEqual({
        text: "the soul is eternal",
        mt: true,
        textOriginal: "душа вечна",
      })
      expect(m.commentaries?.["3"]).toMatchObject({
        authorName: "Prabhupada",
        commentaryKind: "commentary",
      })
      expect(m.chapters?.["bg|1"]).toEqual({
        regionLabel: "Canto 1",
        chapters: [{ tokens: "1", title: "Creation" }],
      })
    }
  })

  it("maps a media wire payload (snake_case) to the camelCase domain shape", async () => {
    const mediaAction = {
      type: "action",
      payload: {
        kind: "media",
        id: "a1",
        payload: {
          id: "vid1",
          url: "public/media/vid1.mp4",
          type: "video",
          title: "Prabhupada · 1977",
          text: "transcript",
          mt: true,
          text_original: "оригинал",
        },
      },
    } as unknown as ChatStreamEvent
    const stream = makeStream([
      mediaAction,
      { type: "delta", text: "see [media:vid1]" } as ChatStreamEvent,
      { type: "done" } as ChatStreamEvent,
    ])
    const ctl = new AbortController()
    const events = await collect(runChatTurn(baseInput(ctl.signal), baseDeps(stream)))

    const finalised = events.find((e) => e.kind === "finalised")
    expect(finalised).toBeDefined()
    if (finalised && finalised.kind === "finalised") {
      // Wire `text_original` → domain `textOriginal`; no snake_case leaks.
      expect(finalised.message.media?.["vid1"]).toEqual({
        id: "vid1",
        url: "public/media/vid1.mp4",
        type: "video",
        title: "Prabhupada · 1977",
        text: "transcript",
        mt: true,
        textOriginal: "оригинал",
      })
    }
  })

  it("tool_start resets the card maps too — a verse from the abandoned pass is dropped", async () => {
    const stream = makeStream([
      verseAction,
      { type: "tool_start" } as ChatStreamEvent,
      { type: "delta", text: "Final answer" } as ChatStreamEvent,
      { type: "done" } as ChatStreamEvent,
    ])
    const ctl = new AbortController()
    const events = await collect(runChatTurn(baseInput(ctl.signal), baseDeps(stream)))

    const finalised = events.find((e) => e.kind === "finalised")
    expect(finalised).toBeDefined()
    if (finalised && finalised.kind === "finalised") {
      expect(finalised.message.verses ?? {}).toEqual({})
      expect(finalised.message.content).toBe("Final answer")
    }
  })
})

describe("runChatTurn — settled conversation attributes", () => {
  it("persists it on the finalised message so the next turn can ship it back", async () => {
    const stream = makeStream([
      { type: "delta", text: "Хорошо." } as ChatStreamEvent,
      {
        type: "done",
        attributes: { reply_language: { value: "ru", label: "Русский", explicit: true } },
      } as ChatStreamEvent,
    ])
    const ctl = new AbortController()
    const events = await collect(runChatTurn(baseInput(ctl.signal), baseDeps(stream)))

    const finalised = events.find((e) => e.kind === "finalised")
    expect(finalised).toBeDefined()
    if (finalised && finalised.kind === "finalised") {
      expect(finalised.message.attributes).toEqual({
        reply_language: { value: "ru", label: "Русский", explicit: true },
      })
    }
  })

  it("leaves it unset when the server settled nothing", async () => {
    const stream = makeStream([
      { type: "delta", text: "answer" } as ChatStreamEvent,
      { type: "done" } as ChatStreamEvent,
    ])
    const ctl = new AbortController()
    const events = await collect(runChatTurn(baseInput(ctl.signal), baseDeps(stream)))

    const finalised = events.find((e) => e.kind === "finalised")
    if (finalised && finalised.kind === "finalised") {
      expect(finalised.message.attributes).toBeUndefined()
    }
  })
})

describe("runChatTurn — session title language", () => {
  function titleSpy(): { service: IChatTitleService; langs: string[] } {
    const langs: string[] = []
    return {
      langs,
      service: {
        fetchSessionTitle: async (_turns, lang) => {
          langs.push(lang)
          return "A title"
        },
      },
    }
  }

  it("titles in the language the server answered in, not the one asked in", async () => {
    // English question typed in a Russian-set app: the server settles the
    // reply as English, so the title that names that reply is English too.
    const stream = makeStream([
      { type: "delta", text: "Karma is…" } as ChatStreamEvent,
      {
        type: "done",
        attributes: { reply_language: { value: "en", label: "English", explicit: false } },
      } as ChatStreamEvent,
    ])
    const spy = titleSpy()
    const ctl = new AbortController()
    await collect(
      runChatTurn(
        { ...baseInput(ctl.signal), lang: "ru", isFirstAssistantTurn: true },
        {
          ...baseDeps(stream),
          title: spy.service,
        }
      )
    )
    expect(spy.langs).toEqual(["en"])
  })

  it("falls back to the requested language when nothing was settled", async () => {
    const stream = makeStream([
      { type: "delta", text: "ответ" } as ChatStreamEvent,
      { type: "done" } as ChatStreamEvent,
    ])
    const spy = titleSpy()
    const ctl = new AbortController()
    await collect(
      runChatTurn(
        { ...baseInput(ctl.signal), lang: "ru", isFirstAssistantTurn: true },
        {
          ...baseDeps(stream),
          title: spy.service,
        }
      )
    )
    expect(spy.langs).toEqual(["ru"])
  })
})
