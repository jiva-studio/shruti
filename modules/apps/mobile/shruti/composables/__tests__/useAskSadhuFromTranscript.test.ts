import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { LanguageCode, LocationId, TrackId } from "@lib/domain/core.js"
import type { Location } from "@lib/domain/location.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackAudio, TrackVariant } from "@lib/domain/trackVariant.js"
import type { ChatFocusPayload } from "@lib/domain/chatMessage.js"

interface RouteTarget {
  name: string
  query: Record<string, string>
}

const chat = {
  openOrCreateFocusedSession: vi.fn<(trackId: string) => Promise<string>>(),
  appendFocusMessage: vi.fn<(focus: ChatFocusPayload) => Promise<string>>(),
  requestSuggestions: vi.fn<(messageId: string, focus: ChatFocusPayload) => Promise<void>>(),
  requestInputFocus: vi.fn<() => void>(),
}

const locationsById = new Map<LocationId, Location>()
const appLanguage = ref<LanguageCode>("en" as LanguageCode)
const pushed: RouteTarget[] = []
const closed: number[] = []
let pushFails: Error | null = null

vi.mock("@shruti/stores/useChatStore.js", () => ({ useChatStore: () => chat }))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({ locationsById }),
}))
vi.mock("@shruti/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({
    close: () => {
      closed.push(pushed.length)
    },
  }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => appLanguage,
}))
vi.mock("@shruti/router/index.js", () => ({
  default: {
    push: async (target: RouteTarget) => {
      if (pushFails) throw pushFails
      pushed.push(target)
    },
  },
}))

import { useAskSadhuFromTranscript, type AskSadhuDeps } from "../useAskSadhuFromTranscript.js"

const TRACK_ID = "t-1" as TrackId
const MOSCOW = "loc-msk" as LocationId

function audio(path: string): TrackAudio {
  return { path, filesize: null, duration: null, kind: "original" }
}

function variant(over: Partial<TrackVariant> = {}): TrackVariant {
  return {
    trackId: TRACK_ID,
    language: "en" as LanguageCode,
    title: "A lecture",
    audios: [],
    audio: null,
    transcript: null,
    outline: null,
    description: null,
    ...over,
  }
}

function track(over: Partial<Track> = {}): Track {
  return {
    id: TRACK_ID,
    authorId: null,
    locationId: MOSCOW,
    date: "2026-01-02",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [variant({ audio: audio("public/tracks/t-1/audio/original.mp3") })],
    ...over,
  }
}

const SHARE_CONTEXT = {
  title: "A lecture",
  authorName: "The author",
  date: "2026-01-02",
}

const PARAMS = { trackId: TRACK_ID, text: "the quoted passage", timeStart: 1_000, timeEnd: 4_000 }

function deps(over: Partial<AskSadhuDeps> = {}): AskSadhuDeps & { errors: string[] } {
  const errors: string[] = []
  return {
    getTrack: () => track(),
    getShareContext: () => SHARE_CONTEXT,
    onError: (key: string) => errors.push(key),
    errors,
    ...over,
  }
}

describe("useAskSadhuFromTranscript", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    chat.openOrCreateFocusedSession.mockReset().mockResolvedValue("sess-1")
    chat.appendFocusMessage.mockReset().mockResolvedValue("msg-1")
    chat.requestSuggestions.mockReset().mockResolvedValue(undefined)
    chat.requestInputFocus.mockReset()
    locationsById.clear()
    locationsById.set(MOSCOW, {
      id: MOSCOW,
      names: new Map([
        ["en" as LanguageCode, "Moscow"],
        ["ru" as LanguageCode, "Москва"],
      ]),
    })
    appLanguage.value = "en" as LanguageCode
    pushed.length = 0
    closed.length = 0
    pushFails = null
  })

  it("carries the quoted text and the track span into the focus message", async () => {
    await useAskSadhuFromTranscript(deps())(PARAMS)

    expect(chat.appendFocusMessage.mock.calls[0][0]).toMatchObject({
      trackId: TRACK_ID,
      text: "the quoted passage",
      startMs: 1_000,
      endMs: 4_000,
    })
  })

  it("pins the bibliography and the source audio at insert time", async () => {
    await useAskSadhuFromTranscript(deps())(PARAMS)

    expect(chat.appendFocusMessage.mock.calls[0][0]).toMatchObject({
      trackTitle: "A lecture",
      authorName: "The author",
      date: "2026-01-02",
      location: "Moscow",
      sourceKey: "public/tracks/t-1/audio/original.mp3",
    })
  })

  it("names the location in the app language", async () => {
    appLanguage.value = "ru" as LanguageCode

    await useAskSadhuFromTranscript(deps())(PARAMS)

    expect(chat.appendFocusMessage.mock.calls[0][0].location).toBe("Москва")
  })

  it("leaves the location out when the track has none", async () => {
    await useAskSadhuFromTranscript(deps({ getTrack: () => track({ locationId: null }) }))(PARAMS)

    expect(chat.appendFocusMessage.mock.calls[0][0].location).toBeUndefined()
  })

  it("leaves the location out when the id is not in the dictionary", async () => {
    locationsById.clear()

    await useAskSadhuFromTranscript(deps())(PARAMS)

    expect(chat.appendFocusMessage.mock.calls[0][0].location).toBeUndefined()
  })

  it("still asks, with no source audio, when the track is unavailable", async () => {
    const d = deps({ getTrack: () => null, getShareContext: () => undefined })

    await useAskSadhuFromTranscript(d)(PARAMS)

    expect(chat.appendFocusMessage.mock.calls[0][0]).toMatchObject({
      text: "the quoted passage",
      sourceKey: undefined,
      trackTitle: undefined,
      location: undefined,
    })
    expect(d.errors).toEqual([])
  })

  it("leaves sourceKey unset when no variant has audio", async () => {
    await useAskSadhuFromTranscript(deps({ getTrack: () => track({ variants: [variant()] }) }))(
      PARAMS
    )

    expect(chat.appendFocusMessage.mock.calls[0][0].sourceKey).toBeUndefined()
  })

  it("navigates to the session it opened and only then dismisses the modal", async () => {
    await useAskSadhuFromTranscript(deps())(PARAMS)

    expect(chat.openOrCreateFocusedSession).toHaveBeenCalledWith(TRACK_ID)
    expect(pushed).toEqual([{ name: "chat", query: { session: "sess-1" } }])
    expect(closed).toEqual([1])
  })

  it("asks for suggestion chips on the focus message it just inserted", async () => {
    await useAskSadhuFromTranscript(deps())(PARAMS)

    expect(chat.requestSuggestions.mock.calls[0][0]).toBe("msg-1")
    expect(chat.requestSuggestions.mock.calls[0][1]).toEqual(
      chat.appendFocusMessage.mock.calls[0][0]
    )
    expect(chat.requestInputFocus).toHaveBeenCalled()
  })

  it("keeps the modal open and reports when the session cannot be opened", async () => {
    chat.openOrCreateFocusedSession.mockRejectedValue(new Error("db closed"))
    const d = deps()

    await useAskSadhuFromTranscript(d)(PARAMS)

    expect(d.errors).toEqual(["errors.askFailed"])
    expect(chat.appendFocusMessage).not.toHaveBeenCalled()
    expect(pushed).toEqual([])
    expect(closed).toEqual([])
  })

  it("reports when the focus message cannot be written", async () => {
    chat.appendFocusMessage.mockRejectedValue(new Error("SQLITE_BUSY"))
    const d = deps()

    await useAskSadhuFromTranscript(d)(PARAMS)

    expect(d.errors).toEqual(["errors.askFailed"])
    expect(closed).toEqual([])
  })

  it("reports, and leaves the modal open, when navigation fails", async () => {
    pushFails = new Error("route missing")
    const d = deps()

    await useAskSadhuFromTranscript(d)(PARAMS)

    expect(d.errors).toEqual(["errors.askFailed"])
    expect(closed).toEqual([])
  })

  it("does not fail the hand-off when the suggestion request rejects", async () => {
    chat.requestSuggestions.mockRejectedValue(new Error("offline"))
    const d = deps()

    await useAskSadhuFromTranscript(d)(PARAMS)

    expect(d.errors).toEqual([])
    expect(pushed).toHaveLength(1)
  })
})
