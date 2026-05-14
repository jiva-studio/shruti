import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { onIonViewWillEnter } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import type { UiNoteRow } from "@ui/features/notes/index.js"
import type { Author } from "@lib/domain/author.js"
import type { Location } from "@lib/domain/location.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { formatNoteShare } from "@lib/application/formatNoteShare.js"
import { formatReference } from "@lectorium/composables/groupReferences.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useNotesStore } from "@lectorium/stores/useNotesStore.js"

/**
 * Minimum query length that triggers `<mark>` injection in the notes
 * list. The user explicitly asked for "только если больше трёх букв" so
 * single/double/triple-letter queries don't paint half the page yellow.
 */
const MATCH_HIGHLIGHT_MIN_LENGTH = 4

export interface NotesActionSheetButton {
  readonly text: string
  readonly role?: "destructive" | "cancel"
  readonly handler?: () => void
}

export interface NotesControllerReturn {
  rows: ComputedRef<readonly UiNoteRow[]>
  isEmpty: ComputedRef<boolean>
  query: ComputedRef<string>
  isActionSheetOpen: Ref<boolean>
  actionSheetButtons: ComputedRef<readonly NotesActionSheetButton[]>
  onQuery: (next: string) => Promise<void>
  onNoteClicked: (noteId: string) => Promise<void>
}

export function useNotesController(): NotesControllerReturn {
  const { t } = useI18n()
  const app = useLectorium()
  const store = useNotesStore()
  const dictionaries = useDictionariesStore()
  const appLanguage = useAppLanguage()
  const { shareService, haptics } = useLectorium()

  const selectedNoteId = ref<NoteId | null>(null)
  const isActionSheetOpen = ref(false)
  /**
   * Cache of Track entities for every note currently in `store.filtered`.
   * Populated by `refreshTracks` whenever the filtered list changes.
   * Authors and locations are read from the dictionaries store, which is
   * a one-shot full load — no per-row fetch needed.
   */
  const tracksById = ref<ReadonlyMap<TrackId, Track>>(new Map())

  const query = computed(() => store.query)
  const isEmpty = computed(() => !store.isLoading && store.all.length === 0)

  async function refreshTracks(): Promise<void> {
    const ids = Array.from(new Set(store.filtered.map((n) => n.trackId as TrackId)))
    if (ids.length === 0) {
      tracksById.value = new Map()
      return
    }
    try {
      tracksById.value = await app.repositories().tracks.getByIds(ids)
    } catch {
      tracksById.value = new Map()
    }
  }

  function trackContextFor(trackId: TrackId): {
    track?: Track
    author?: Author
    location?: Location
  } {
    const track = tracksById.value.get(trackId)
    if (!track) return {}
    const author = track.authorId ? dictionaries.authorsById.get(track.authorId) : undefined
    const location = track.locationId ? dictionaries.locationsById.get(track.locationId) : undefined
    return { track, author, location }
  }

  function resolveAuthorName(author: Author | undefined): string | undefined {
    if (!author) return undefined
    const name = author.names.get(appLanguage.value) ?? author.names.values().next().value
    return name && name.length > 0 ? name : undefined
  }

  function resolveLocationName(location: Location | undefined): string | undefined {
    if (!location) return undefined
    const name = location.names.get(appLanguage.value) ?? location.names.values().next().value
    return name && name.length > 0 ? name : undefined
  }

  function resolveTrackTitle(track: Track | undefined): string | undefined {
    if (!track || track.variants.length === 0) return undefined
    const variant =
      track.variants.find((v) => v.language === appLanguage.value) ?? track.variants[0]
    return variant?.title && variant.title.length > 0 ? variant.title : undefined
  }

  function resolveReference(track: Track | undefined): string | undefined {
    if (!track || track.references.length === 0) return undefined
    return formatReference(track.references[0]!, dictionaries.sourcesById, appLanguage.value)
  }

  const rows = computed<readonly UiNoteRow[]>(() => {
    const q = store.query.trim()
    const wrap = q.length >= MATCH_HIGHLIGHT_MIN_LENGTH

    return store.filtered.map((n) => {
      const { track, author, location } = trackContextFor(n.trackId as TrackId)
      return {
        id: n.id,
        text: wrap ? highlightMatches(n.text, q) : escapeHtml(n.text),
        trackId: n.trackId,
        language: "",
        timeStart: n.timeStart,
        timeEnd: n.timeEnd,
        createdAt: n.createdAt,
        authorName: resolveAuthorName(author),
        trackTitle: resolveTrackTitle(track),
        trackDate: track?.date || undefined,
        locationName: resolveLocationName(location),
        reference: resolveReference(track),
      }
    })
  })

  function currentNote() {
    return store.all.find((n) => n.id === selectedNoteId.value) ?? null
  }

  function buildShareTextForCurrent(): string | null {
    const note = currentNote()
    if (!note) return null
    const { track, author, location } = trackContextFor(note.trackId as TrackId)
    return formatNoteShare({
      text: note.text,
      timeStart: note.timeStart,
      timeEnd: note.timeEnd,
      track: track
        ? {
            title: resolveTrackTitle(track),
            authorName: resolveAuthorName(author),
            date: track.date || undefined,
            locationName: resolveLocationName(location),
            reference: resolveReference(track),
          }
        : undefined,
    })
  }

  async function onCopyNoteClicked(): Promise<void> {
    const payload = buildShareTextForCurrent()
    if (!payload) return
    await shareService.copyToClipboard(payload)
  }

  async function onShareNoteClicked(): Promise<void> {
    const payload = buildShareTextForCurrent()
    if (!payload) return
    await shareService.share({ text: payload })
  }

  async function onDeleteNoteClicked(): Promise<void> {
    const id = selectedNoteId.value
    if (!id) return
    await store.remove(id)
  }

  const actionSheetButtons = computed<readonly NotesActionSheetButton[]>(() => [
    {
      text: t("app.share"),
      handler: () => {
        void onShareNoteClicked()
      },
    },
    {
      text: t("app.copy"),
      handler: () => {
        void onCopyNoteClicked()
      },
    },
    {
      text: t("app.delete"),
      role: "destructive",
      handler: () => {
        void onDeleteNoteClicked()
      },
    },
    {
      text: t("app.cancel"),
      role: "cancel",
    },
  ])

  async function onQuery(next: string): Promise<void> {
    await store.setQuery(next)
  }

  async function onNoteClicked(noteId: string): Promise<void> {
    await haptics.impact("light")
    selectedNoteId.value = noteId as NoteId
    isActionSheetOpen.value = true
  }

  onMounted(async () => {
    // The notes page needs dictionaries (authors / locations / sources)
    // for the source-context line under each item; pre-warm so the first
    // paint already has them.
    await dictionaries.ensureLoaded()
    await store.refresh()
    await refreshTracks()
  })

  // Ionic Tabs не размонтируют вкладку — `onMounted` стреляет один раз.
  // Без этого хука после создания заметки и возврата на вкладку список
  // мог не обновляться. Дубль с `onMounted` на первой активации безобиден:
  // store.refresh() идемпотентна, словари уже закешированы.
  onIonViewWillEnter(async () => {
    await store.refresh()
    await refreshTracks()
  })

  watch(
    () => store.filtered,
    () => {
      void refreshTracks()
    }
  )

  return {
    rows,
    isEmpty,
    query,
    isActionSheetOpen,
    actionSheetButtons,
    onQuery,
    onNoteClicked,
  }
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Returns `text` with every case-insensitive occurrence of `query`
 * wrapped in `<mark>`. The text is HTML-escaped first so user-supplied
 * characters can't break the `v-html` render in HighlightText, and the
 * substring match runs against the escaped string with the query also
 * escaped — so a query like "a<b" still highlights the same characters
 * after they're rewritten to `a&lt;b`.
 */
function highlightMatches(text: string, query: string): string {
  const escaped = escapeHtml(text)
  const needle = escapeHtml(query)
  if (needle.length === 0) return escaped
  const pattern = new RegExp(escapeRegExp(needle), "gi")
  return escaped.replace(pattern, (match) => `<mark>${match}</mark>`)
}
