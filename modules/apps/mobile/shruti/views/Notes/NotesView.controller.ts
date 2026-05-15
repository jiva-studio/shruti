import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { onIonViewWillEnter } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import { Directory, Filesystem } from "@capacitor/filesystem"
import type { UiNoteRow } from "@ui/features/notes/index.js"
import type { Author } from "@lib/domain/author.js"
import type { Location } from "@lib/domain/location.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"
import { formatNoteShare } from "@lib/application/formatNoteShare.js"
import { formatReference } from "@shruti/composables/groupReferences.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLoading } from "@shruti/services/useLoading.js"
import { useToast } from "@shruti/services/useToast.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"

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
  const app = useShruti()
  const store = useNotesStore()
  const dictionaries = useDictionariesStore()
  const appLanguage = useAppLanguage()
  const { shareService, shareAudioService, activeServer, haptics } = useShruti()
  const toast = useToast()
  const loading = useLoading()

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

  /**
   * Pick the audio source for cutting: prefer the `original` variant, fall
   * back to the first variant whose `audio` is non-null. Returns `null` if
   * the track has no audio at all (translation-only).
   */
  function pickAudioVariant(track: Track): TrackVariant | null {
    const original = track.variants.find((v) => v.audio !== null && v.audio.kind === "original")
    if (original) return original
    return track.variants.find((v) => v.audio !== null) ?? null
  }

  /**
   * Filesystem path of a previously-shared excerpt for this note in
   * Capacitor's app cache. Identical to the `path` we feed to
   * `Filesystem.downloadFile` below; centralised so the cache-check
   * and the download stay in lock-step.
   *
   * Flat (no subdir) because `@capacitor/filesystem`'s legacy
   * `downloadFile` on Android does NOT create intermediate directories
   * (iOS does — see iOS LegacyFilesystemImplementation.downloadFile).
   * A subdir would make the first share on Android fail with
   * `FileNotFoundException`.
   */
  function localExcerptPath(noteId: NoteId): string {
    return `share-audio-note-${noteId}.mp3`
  }

  /**
   * Local-cache hit check. Returns the `file://...` URI when the
   * excerpt is already in `Directory.Cache` from a prior share; `null`
   * otherwise. Same `stat → catch → null` pattern as
   * `useDatabaseToFsFetcher.exists` — Capacitor's stat throws for
   * missing files rather than returning a flag.
   */
  async function findLocalExcerpt(noteId: NoteId): Promise<string | null> {
    const path = localExcerptPath(noteId)
    try {
      await Filesystem.stat({ path, directory: Directory.Cache })
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
      return uri
    } catch {
      return null
    }
  }

  /**
   * Tries the public excerpt URL on the active CDN first (no compute
   * needed if the file is still there from a prior share). Returns the
   * URL on hit; resolves to `null` on miss / timeout / network error.
   */
  async function probeExcerpt(noteId: string): Promise<string | null> {
    const candidate = buildServerUrl(activeServer.value, `public/shares/audio/${noteId}.mp3`)
    try {
      const response = await fetch(candidate, {
        method: "HEAD",
        signal: AbortSignal.timeout(1500),
      })
      return response.ok ? candidate : null
    } catch {
      return null
    }
  }

  async function onShareNoteAudioClicked(): Promise<void> {
    const note: Note | null = currentNote()
    if (!note) return
    const { track } = trackContextFor(note.trackId as TrackId)
    if (!track) {
      await toast.error(t("notes.shareAudioErrorNoAudio"))
      return
    }
    const variant = pickAudioVariant(track)
    if (!variant || !variant.audio) {
      await toast.error(t("notes.shareAudioErrorNoAudio"))
      return
    }
    const audioPath = variant.audio.path

    try {
      const localPath = await loading.withLoading(t("notes.shareAudioPreparing"), async () => {
        // 1. Already in app cache? Skip everything (no HTTP at all).
        const cached = await findLocalExcerpt(note.id)
        if (cached) return cached

        // 2. Already on the CDN from someone else's prior share? Skip the
        // cutter, just download.
        let publicUrl = await probeExcerpt(note.id)

        // 3. Cold path: cut, then download.
        if (!publicUrl) {
          const result = await shareAudioService.cut({
            sourceKey: audioPath,
            startMs: note.timeStart,
            endMs: note.timeEnd,
            excerptId: note.id,
          })
          publicUrl = result.url
        }

        await Filesystem.downloadFile({
          url: publicUrl,
          path: localExcerptPath(note.id),
          directory: Directory.Cache,
          recursive: true,
        })
        // Normalize via getUri so cold and warm paths return the same
        // `file://...` shape. Android's downloadFile returns a raw
        // absolute path (`/data/user/0/.../cache/...`) without a scheme,
        // which `@capacitor/share` can't pipe through FileProvider — the
        // share sheet silently no-ops. iOS returns `file://...` here
        // already, but getUri is cheap and keeps both platforms aligned.
        const { uri } = await Filesystem.getUri({
          path: localExcerptPath(note.id),
          directory: Directory.Cache,
        })
        return uri
      })

      await shareService.share({
        url: localPath,
        title: resolveTrackTitle(track),
        dialogTitle: t("notes.shareAudioDialog"),
      })
    } catch {
      await toast.error(t("notes.shareAudioErrorGeneric"))
    }
  }

  async function onDeleteNoteClicked(): Promise<void> {
    const id = selectedNoteId.value
    if (!id) return
    await store.remove(id)
  }

  const actionSheetButtons = computed<readonly NotesActionSheetButton[]>(() => [
    {
      text: t("notes.shareText"),
      handler: () => {
        void onShareNoteClicked()
      },
    },
    {
      text: t("notes.shareAudio"),
      handler: () => {
        void onShareNoteAudioClicked()
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
