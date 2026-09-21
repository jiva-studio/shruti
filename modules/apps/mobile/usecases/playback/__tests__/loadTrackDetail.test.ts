import { describe, expect, it } from "vitest"
import { loadTrackDetail, type LoadTrackDetailDeps } from "../loadTrackDetail.js"
import type { Author } from "@lib/domain/author.js"
import type { AuthorId, LanguageCode, TrackId } from "@lib/domain/core.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"
import type { Track } from "@lib/domain/track.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { IAuthorRepository } from "@lib/domain/ports/authorRepository.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import type { ILibraryItemRepository } from "@lib/domain/ports/libraryItemRepository.js"

const TRACK_ID = "t-1" as TrackId
const AUTHOR_ID = "a-1" as AuthorId

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: TRACK_ID,
    authorId: AUTHOR_ID,
    locationId: null,
    date: "2020-01-01",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [],
    ...over,
  }
}

function makeAuthor(): Author {
  return { id: AUTHOR_ID, names: new Map<LanguageCode, string>([["en", "Sadhu"]]) }
}

function makeLibraryItem(over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "membership-1",
    trackId: TRACK_ID,
    status: "ready",
    origin: "private",
    titleRaw: "A talk on the Gita",
    authorRaw: "Unlisted Speaker",
    locationRaw: "Vrindavan",
    dateRaw: "2020",
    langHint: "en",
    authorId: null,
    locationId: null,
    date: "2020-01-01",
    lang: "en",
    error: null,
    audioKey: "private/audio.mp3",
    transcriptKey: "private/en.json",
    variants: [],
    duration: 60_000,
    coverKey: null,
    references: [],
    sourceUrl: "https://example.test/talk",
    createdAt: null,
    updatedAt: null,
    ...over,
  }
}

interface Fakes {
  deps: LoadTrackDetailDeps
  transcriptLookups: TrackId[]
}

function makeDeps(opts: {
  corpusTrack?: Track | null
  libraryItem?: LibraryItem | null
  author?: Author | null
  languages?: readonly LanguageCode[]
}): Fakes {
  const transcriptLookups: TrackId[] = []
  const tracks: Pick<ITrackRepository, "getById"> = {
    getById: async () => opts.corpusTrack ?? null,
  }
  const authors: Pick<IAuthorRepository, "getById"> = {
    getById: async () => opts.author ?? null,
  }
  const transcripts: Pick<ITranscriptRepository, "availableLanguages"> = {
    availableLanguages: async (id) => {
      transcriptLookups.push(id)
      return opts.languages ?? []
    },
  }
  const libraryItems: Pick<ILibraryItemRepository, "getByTrackId"> = {
    getByTrackId: async () => opts.libraryItem ?? null,
  }
  return {
    transcriptLookups,
    deps: {
      tracks: tracks as ITrackRepository,
      authors: authors as IAuthorRepository,
      transcripts: transcripts as ITranscriptRepository,
      libraryItems: libraryItems as ILibraryItemRepository,
    },
  }
}

describe("loadTrackDetail, for a corpus track", () => {
  it("returns the track with its author and transcript languages", async () => {
    const track = makeTrack()
    const { deps, transcriptLookups } = makeDeps({
      corpusTrack: track,
      author: makeAuthor(),
      languages: ["en", "ru"],
    })

    const result = await loadTrackDetail({ trackId: TRACK_ID }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.track).toBe(track)
    expect(result.value.author?.id).toBe(AUTHOR_ID)
    expect(result.value.availableLanguages).toEqual(["en", "ru"])
    expect(transcriptLookups).toEqual([TRACK_ID])
  })

  it("renders with no author rather than failing when the track has none", async () => {
    const { deps } = makeDeps({ corpusTrack: makeTrack({ authorId: null }), author: makeAuthor() })

    const result = await loadTrackDetail({ trackId: TRACK_ID }, deps)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.author).toBeNull()
  })

  it("keeps the author null when the referenced author is missing", async () => {
    const { deps } = makeDeps({ corpusTrack: makeTrack(), author: null })

    const result = await loadTrackDetail({ trackId: TRACK_ID }, deps)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.author).toBeNull()
  })

  it("carries no raw metadata, so the view shows resolved entities only", async () => {
    const { deps } = makeDeps({ corpusTrack: makeTrack(), author: makeAuthor() })

    const result = await loadTrackDetail({ trackId: TRACK_ID }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.authorRaw).toBeNull()
    expect(result.value.locationRaw).toBeNull()
  })

  it("does not consult the personal library once the corpus answers", async () => {
    let libraryReads = 0
    const { deps } = makeDeps({ corpusTrack: makeTrack() })
    const libraryItems: Pick<ILibraryItemRepository, "getByTrackId"> = {
      getByTrackId: async () => {
        libraryReads += 1
        return makeLibraryItem()
      },
    }

    await loadTrackDetail(
      { trackId: TRACK_ID },
      { ...deps, libraryItems: libraryItems as ILibraryItemRepository }
    )

    expect(libraryReads).toBe(0)
  })
})

describe("loadTrackDetail, for a user-added lecture", () => {
  it("resolves it from the personal library when the corpus has nothing", async () => {
    const { deps } = makeDeps({ corpusTrack: null, libraryItem: makeLibraryItem() })

    const result = await loadTrackDetail({ trackId: TRACK_ID }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.track.id).toBe(TRACK_ID)
    expect(result.value.track.variants[0]?.title).toBe("A talk on the Gita")
  })

  it("surfaces the raw author and location the pipeline could not match", async () => {
    const { deps } = makeDeps({ corpusTrack: null, libraryItem: makeLibraryItem() })

    const result = await loadTrackDetail({ trackId: TRACK_ID }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.author).toBeNull()
    expect(result.value.authorRaw).toBe("Unlisted Speaker")
    expect(result.value.locationRaw).toBe("Vrindavan")
  })

  it("is not found while the item is still waiting for its content hash", async () => {
    const { deps } = makeDeps({
      corpusTrack: null,
      libraryItem: makeLibraryItem({ trackId: null }),
    })

    const result = await loadTrackDetail({ trackId: TRACK_ID }, deps)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("not-found")
  })
})

describe("loadTrackDetail, when nothing holds the track", () => {
  it("reports not-found so the view can show an error state", async () => {
    const { deps } = makeDeps({ corpusTrack: null, libraryItem: null })

    const result = await loadTrackDetail({ trackId: TRACK_ID }, deps)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("not-found")
  })

  it("does not look up an author or transcripts for a track it cannot find", async () => {
    let authorReads = 0
    const { deps, transcriptLookups } = makeDeps({ corpusTrack: null, libraryItem: null })
    const authors: Pick<IAuthorRepository, "getById"> = {
      getById: async () => {
        authorReads += 1
        return makeAuthor()
      },
    }

    await loadTrackDetail({ trackId: TRACK_ID }, { ...deps, authors: authors as IAuthorRepository })

    expect(authorReads).toBe(0)
    expect(transcriptLookups).toEqual([])
  })
})

describe("loadTrackDetail, when the track has no transcripts", () => {
  it("returns an empty language list instead of failing", async () => {
    const { deps } = makeDeps({ corpusTrack: makeTrack(), languages: [] })

    const result = await loadTrackDetail({ trackId: TRACK_ID }, deps)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.availableLanguages).toEqual([])
  })
})
