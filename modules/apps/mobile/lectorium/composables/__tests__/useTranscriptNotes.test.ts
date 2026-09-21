// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { LanguageCode, LocationId, NoteId, SourceId, TrackId } from "@lib/domain/core.js"
import type { Location } from "@lib/domain/location.js"
import type { Note } from "@lib/domain/note.js"
import type { Source } from "@lib/domain/source.js"
import type { Track } from "@lib/domain/track.js"
import type { AskRequestParams } from "@lectorium/composables/transcript/useTranscriptSelectionActions.js"

const TRACK_ID = "t1" as TrackId
const SOURCE_ID = "source-bg" as SourceId
const LOCATION_ID = "loc-vrindavan" as LocationId

const openTrackId = ref<TrackId | null>(TRACK_ID)
const appLanguage = ref<LanguageCode>("en")

/** Notes the repository holds, newest last. */
let stored: Note[] = []
let listFails = false
let noteSeq = 0
/** Refresh calls the Notes tab store has seen, as its own row count. */
let notesTabRows = 0
const shared: string[] = []
const copied: string[] = []
const asked: AskRequestParams[] = []
const errors: string[] = []

const noteRepository = {
  getById: async (id: NoteId) => stored.find((n) => n.id === id) ?? null,
  listByTrack: async (trackId: TrackId) => {
    if (listFails) throw new Error("db closed")
    return stored.filter((n) => n.trackId === trackId)
  },
  listRecent: async (limit: number) => stored.slice(0, limit),
  create: async (input: { trackId: TrackId; text: string; timeStart: number; timeEnd: number }) => {
    const note: Note = {
      id: `n-${++noteSeq}` as NoteId,
      trackId: input.trackId,
      text: input.text,
      timeStart: input.timeStart,
      timeEnd: input.timeEnd,
      createdAt: 1,
      meta: null,
    }
    stored = [...stored, note]
    return note
  },
  update: async () => {
    throw new Error("notes are not edited from the transcript")
  },
  delete: async (id: NoteId) => {
    stored = stored.filter((n) => n.id !== id)
  },
  clearAll: async () => {
    stored = []
  },
}

const track: Track = {
  id: TRACK_ID,
  authorId: null,
  locationId: LOCATION_ID,
  date: "2004-03-17",
  hidden: false,
  references: [{ sourceId: SOURCE_ID, tokens: ["2", "13"] }],
  tagIds: [],
  topicIds: [],
  variants: [],
}

const location: Location = {
  id: LOCATION_ID,
  names: new Map<LanguageCode, string>([
    ["en", "Vrindavan"],
    ["ru", "Вриндаван"],
  ]),
}

const source: Source = {
  id: SOURCE_ID,
  names: new Map([["en", { fullName: "Bhagavad-gita", shortName: "BG" }]]),
}

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      notes: noteRepository,
      unitOfWork: { run: async (fn: (tx: unknown) => unknown) => fn({}) },
    }),
    shareService: {
      copyToClipboard: async (text: string) => {
        copied.push(text)
      },
      share: async (input: { text: string }) => {
        shared.push(input.text)
      },
    },
  }),
}))
vi.mock("@lectorium/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({
    get trackId() {
      return openTrackId.value
    },
  }),
}))
vi.mock("@lectorium/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    locationsById: new Map([[LOCATION_ID, location]]),
    sourcesById: new Map([[SOURCE_ID, source]]),
  }),
}))
vi.mock("@lectorium/stores/useNotesStore.js", () => ({
  useNotesStore: () => ({
    refresh: async () => {
      notesTabRows = stored.length
    },
  }),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => appLanguage,
}))
vi.mock("@lectorium/composables/useAskSadhuFromTranscript.js", () => ({
  useAskSadhuFromTranscript: () => async (params: AskRequestParams) => {
    asked.push(params)
  },
}))

import { useTranscriptNotes } from "../useTranscriptNotes.js"

function setup(trackOverride?: Track | null) {
  return useTranscriptNotes({
    getTrack: () => (trackOverride === undefined ? track : trackOverride),
    title: ref("Lecture on surrender"),
    author: ref("Sadhu"),
    onError: (key) => errors.push(key),
  })
}

function selectionEvent(text: string) {
  return { text, timeStart: 12_000, timeEnd: 18_000, event: new TouchEvent("touchend") }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe("useTranscriptNotes", () => {
  beforeEach(() => {
    stored = []
    noteSeq = 0
    notesTabRows = 0
    listFails = false
    openTrackId.value = TRACK_ID
    appLanguage.value = "en"
    shared.length = 0
    copied.length = 0
    asked.length = 0
    errors.length = 0
  })

  describe("the note list behind the transcript highlights", () => {
    it("holds the saved notes of the open track", async () => {
      await noteRepository.create({
        trackId: TRACK_ID,
        text: "surrender",
        timeStart: 1,
        timeEnd: 2,
      })
      await noteRepository.create({
        trackId: "other" as TrackId,
        text: "elsewhere",
        timeStart: 1,
        timeEnd: 2,
      })
      const notes = setup()

      await notes.refresh()

      expect(notes.notes.value.map((n) => n.text)).toEqual(["surrender"])
    })

    it("is empty while no track is open", async () => {
      openTrackId.value = null
      const notes = setup()

      await notes.refresh()

      expect(notes.notes.value).toEqual([])
    })

    it("falls back to empty when the notes cannot be read", async () => {
      listFails = true
      const notes = setup()

      await notes.refresh()

      expect(notes.notes.value).toEqual([])
    })
  })

  describe("the selection popover", () => {
    it("replaces a tapped highlight when the user drags a fresh selection", () => {
      const notes = setup()
      notes.onNoteTapped({ noteIds: ["n-1" as NoteId], event: new MouseEvent("click") })

      notes.onTextSelected(selectionEvent("first"))

      expect(notes.lastNoteTappedEvent.value).toBeUndefined()
      expect(notes.lastTextSelectedEvent.value?.text).toBe("first")
    })

    it("replaces a drag selection when the user taps a highlight", () => {
      const notes = setup()
      notes.onTextSelected(selectionEvent("first"))

      notes.onNoteTapped({ noteIds: ["n-1" as NoteId], event: new MouseEvent("click") })

      expect(notes.lastTextSelectedEvent.value).toBeUndefined()
      expect(notes.lastNoteTappedEvent.value?.noteIds).toEqual(["n-1"])
    })

    it("closes on dismiss", () => {
      const notes = setup()
      notes.onTextSelected(selectionEvent("first"))

      notes.onSelectionDismissed()

      expect(notes.lastTextSelectedEvent.value).toBeUndefined()
      expect(notes.lastNoteTappedEvent.value).toBeUndefined()
    })

    it("closes before the action it dispatched finishes", async () => {
      const notes = setup()
      notes.onTextSelected(selectionEvent("surrender"))

      const running = notes.onSelectionAction({
        action: "bookmark",
        ...selectionEvent("surrender"),
      })

      expect(notes.lastTextSelectedEvent.value).toBeUndefined()
      await running
    })
  })

  describe("bookmarking a passage", () => {
    it("saves it and shows it on the transcript and the notes tab", async () => {
      const notes = setup()

      await notes.onSelectionAction({ action: "bookmark", ...selectionEvent("surrender") })
      await settle()

      expect(stored.map((n) => n.text)).toEqual(["surrender"])
      expect(notes.notes.value.map((n) => n.text)).toEqual(["surrender"])
      expect(notesTabRows).toBe(1)
    })

    it("reports an empty selection instead of saving it", async () => {
      const notes = setup()

      await notes.onSelectionAction({ action: "bookmark", ...selectionEvent("   ") })
      await settle()

      expect(stored).toEqual([])
      expect(errors).toHaveLength(1)
    })
  })

  describe("deleting a tapped note", () => {
    it("drops it from the transcript and the notes tab", async () => {
      const saved = await noteRepository.create({
        trackId: TRACK_ID,
        text: "surrender",
        timeStart: 1,
        timeEnd: 2,
      })
      const notes = setup()
      await notes.refresh()

      await notes.onSelectionAction({
        action: "delete",
        text: "",
        timeStart: 0,
        timeEnd: 0,
        noteIds: [saved.id],
      })
      await settle()

      expect(stored).toEqual([])
      expect(notes.notes.value).toEqual([])
      expect(notesTabRows).toBe(0)
    })
  })

  describe("sharing a passage", () => {
    it("attaches the lecture's title, author, date, place and reference", async () => {
      const notes = setup()

      await notes.onSelectionAction({ action: "share", ...selectionEvent("surrender") })

      expect(shared).toHaveLength(1)
      expect(shared[0]).toContain("«surrender»")
      expect(shared[0]).toContain("Sadhu — Lecture on surrender")
      expect(shared[0]).toContain("Vrindavan")
      expect(shared[0]).toContain("BG 2.13")
    })

    it("names the place in the interface language", async () => {
      appLanguage.value = "ru"
      const notes = setup()

      await notes.onSelectionAction({ action: "share", ...selectionEvent("surrender") })

      expect(shared[0]).toContain("Вриндаван")
    })

    it("shares a bare quote when the lecture is not loaded", async () => {
      const notes = setup(null)

      await notes.onSelectionAction({ action: "share", ...selectionEvent("surrender") })

      expect(shared[0]).toContain("«surrender»")
      expect(shared[0]).not.toContain("Vrindavan")
    })

    it("copies the passage bare, without the lecture header", async () => {
      const notes = setup()

      await notes.onSelectionAction({ action: "copy", ...selectionEvent("surrender") })

      expect(copied).toEqual(["surrender"])
    })
  })

  describe("asking about a passage", () => {
    it("forwards the selected text and its range", async () => {
      const notes = setup()

      await notes.onSelectionAction({ action: "ask", ...selectionEvent("what is surrender") })

      expect(asked).toEqual([
        { trackId: TRACK_ID, text: "what is surrender", timeStart: 12_000, timeEnd: 18_000 },
      ])
    })
  })
})
