import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { onIonViewWillEnter } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import type { UiNoteRow } from "@ui/features/notes/index.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { useShruti } from "@shruti/shruti.js"
import { renderExcerptHtml } from "@lib/chat/chatMarkers.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { highlightHtml, MATCH_HIGHLIGHT_MIN_LENGTH } from "./highlightHtml.js"
import { useNoteTrackContext } from "./useNoteTrackContext.js"
import { useNoteShare } from "./useNoteShare.js"

export interface NotesActionSheetButton {
  readonly text: string
  readonly role?: "destructive" | "cancel"
  /** Passed straight through to the Ionic action-sheet button (e.g.
   *  `action-sheet-pro` for the Pro pill on Open-in-Studio). */
  readonly cssClass?: string
  readonly handler?: () => void
}

/** The centred message the page shows instead of a list of notes. */
export interface NotesSticker {
  readonly header: string
  readonly message: string
  readonly image?: string
  /** Opaque route echoed back by PageSticker's `navigate` event. */
  readonly to?: string
}

export interface NotesControllerReturn {
  rows: ComputedRef<readonly UiNoteRow[]>
  isEmpty: ComputedRef<boolean>
  /** The read failed — the search box is meaningless until it succeeds. */
  hasError: ComputedRef<boolean>
  /** The one sticker to show, or null when the list speaks for itself. */
  sticker: ComputedRef<NotesSticker | null>
  query: ComputedRef<string>
  /** More matched notes exist than the list has paged in. */
  hasMore: ComputedRef<boolean>
  /** The search capped its results and more notes matched past the cap —
   *  the list ends because the scan stopped, not because the matches did. */
  searchTruncated: ComputedRef<boolean>
  /** The cap that produced it, for the "showing the first N" copy. */
  searchLimit: ComputedRef<number>
  isActionSheetOpen: Ref<boolean>
  actionSheetButtons: ComputedRef<readonly NotesActionSheetButton[]>
  onQuery: (next: string) => Promise<void>
  loadMore: () => void
  onNoteClicked: (noteId: string) => Promise<void>
}

const EMPTY_IMAGE = "/notes-empty.png"

export function useNotesController(): NotesControllerReturn {
  const { t } = useI18n()
  const store = useNotesStore()
  const dictionaries = useDictionariesStore()
  const { haptics } = useShruti()

  const selectedNoteId = ref<NoteId | null>(null)
  const isActionSheetOpen = ref(false)

  const tracks = useNoteTrackContext(() => store.rendered)

  const query = computed(() => store.query)
  const hasMore = computed(() => store.hasMore)
  const searchTruncated = computed(() => store.searchTruncated)
  const searchLimit = computed(() => store.searchLimit)
  // A read failure also empties `all`, so the error has to be excluded here or
  // a broken load reads as "you haven't written any notes yet".
  const hasError = computed(() => !store.isLoading && store.error !== null)
  const isEmpty = computed(() => !store.isLoading && !hasError.value && store.all.length === 0)
  // `appliedQuery`, not `query`: the live text runs ahead of `filtered` by the
  // debounce, and the still-full list would flash "nothing found" for 200 ms.
  const hasNoResults = computed(
    () =>
      !store.isLoading &&
      !hasError.value &&
      store.appliedQuery.trim().length > 0 &&
      store.filtered.length === 0
  )

  const sticker = computed<NotesSticker | null>(() => {
    if (hasError.value) {
      return { header: t("notes.loadFailedTitle"), message: t("notes.loadFailedMessage") }
    }
    if (isEmpty.value) {
      return {
        header: t("notes.notesAreEmpty"),
        message: t("notes.addMoreNotes"),
        image: EMPTY_IMAGE,
        to: "search",
      }
    }
    if (hasNoResults.value) {
      return { header: t("notes.notFoundTitle"), message: t("notes.notFoundMessage") }
    }
    return null
  })

  const rows = computed<readonly UiNoteRow[]>(() => {
    const q = store.appliedQuery.trim()
    const wrap = q.length >= MATCH_HIGHLIGHT_MIN_LENGTH

    return store.rendered.map((n) => {
      const { track, author, location } = tracks.contextFor(n.trackId as TrackId)
      const audioVariant = track ? pickPlayableVariant(track) : null
      // The snippet's inline markdown is rendered the same way the chat
      // citation card renders it, so a saved note reads identically to its
      // origin. The highlight then goes into that HTML's text runs only.
      const html = renderExcerptHtml(n.text)
      return {
        id: n.id,
        text: wrap ? highlightHtml(html, q) : html,
        trackId: n.trackId,
        language: "",
        timeStart: n.timeStart,
        timeEnd: n.timeEnd,
        createdAt: n.createdAt,
        authorName: tracks.authorName(author),
        trackTitle: tracks.trackTitle(track),
        trackDate: tracks.trackDate(track),
        locationName: tracks.locationName(location),
        reference: tracks.reference(track),
        audioPath: audioVariant?.audio?.path,
        trackUnresolved: tracks.isTrackUnresolved(n.trackId as TrackId),
      }
    })
  })

  function currentNote() {
    return store.all.find((n) => n.id === selectedNoteId.value) ?? null
  }

  const share = useNoteShare(currentNote, tracks)

  async function onDeleteNoteClicked(): Promise<void> {
    const id = selectedNoteId.value
    if (!id) return
    await store.remove(id)
  }

  // Top level: copy the text straight to the clipboard, or open the nested
  // share menu that holds the text/audio/video shares and Open in Studio.
  const actionSheetButtons = computed<readonly NotesActionSheetButton[]>(() => [
    {
      text: t("notes.copyText"),
      handler: () => {
        void share.onCopyNoteClicked()
      },
    },
    {
      text: t("app.share"),
      handler: () => {
        void share.presentShareMenu()
      },
    },
    {
      text: t("app.delete"),
      role: "destructive",
      handler: () => {
        void onDeleteNoteClicked()
      },
    },
    { text: t("app.cancel"), role: "cancel" },
  ])

  async function onQuery(next: string): Promise<void> {
    await store.setQuery(next)
  }

  function loadMore(): void {
    store.loadMore()
  }

  async function onNoteClicked(noteId: string): Promise<void> {
    await haptics.impact("light")
    selectedNoteId.value = noteId as NoteId
    isActionSheetOpen.value = true
  }

  onMounted(async () => {
    // The source-context line under each note needs authors / locations /
    // sources, so pre-warm them before the first paint.
    await dictionaries.ensureLoaded()
    await store.refresh()
    await tracks.refreshTracks(true)
  })

  // Ionic keeps a tab mounted, so `onMounted` fires once: without this a note
  // created elsewhere would not show up on return. The duplicate on the first
  // activation is harmless — `refresh()` is idempotent.
  onIonViewWillEnter(async () => {
    await store.refresh()
    await tracks.refreshTracks(true)
  })

  watch(
    () => store.rendered,
    () => {
      void tracks.refreshTracks()
    }
  )

  return {
    rows,
    isEmpty,
    hasError,
    sticker,
    query,
    hasMore,
    searchTruncated,
    searchLimit,
    isActionSheetOpen,
    actionSheetButtons,
    onQuery,
    loadMore,
    onNoteClicked,
  }
}
