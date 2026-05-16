import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { loadingController, onIonViewWillEnter } from "@ionic/vue"
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
import { pollUntilReady } from "@shruti/services/pollUntilReady.js"
import { withProgressLabels, type LabelStep } from "@shruti/services/withProgressLabels.js"
import { useToast } from "@shruti/services/useToast.js"
import { useDebugStore } from "@shruti/stores/useDebugStore.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { useShareJobStore, type ShareJobKind } from "@shruti/stores/useShareJobStore.js"

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
  const { shareService, shareAudioService, shareVideoService, activeServer, haptics } =
    useShruti()
  const toast = useToast()
  const debug = useDebugStore()
  const shareJob = useShareJobStore()

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

  /**
   * Wraps the share work (cache → probe → cut+poll → download → share-sheet)
   * with a 3-second handoff: keep the user blocked behind a spinner while
   * the work might still finish quickly (audio cache-hit / sync cut), then
   * release the UI to the background and let the work continue. When the
   * background work eventually resolves, fire the system share sheet —
   * Capacitor handles cross-tab fine, so the user gets their result even
   * if they've moved on.
   *
   * Single-slot guard via `useShareJobStore`: a second tap while a job
   * runs gets a "wait" toast and no-op. Same noteId or different noteId,
   * audio or video — same behaviour for simplicity.
   *
   * Owns the loading modal directly (not via `useLoading.withLoading`)
   * because the modal lifetime needs to be 3 s, not "the whole work".
   */
  const HANDOFF_MS = 3_000

  async function runShareWorkflow(args: {
    jobKind: ShareJobKind
    noteId: NoteId
    initialLabel: string
    workFn: (ctx: { setLabel: (label: string) => void }) => Promise<string>
    openShareSheet: (localUri: string) => Promise<void>
    errorLabel: string
  }): Promise<void> {
    if (!shareJob.tryStart(args.jobKind, args.noteId)) {
      await toast.info(t("notes.shareAlreadyInProgress"))
      return
    }

    const modal = await loadingController.create({
      message: args.initialLabel,
      spinner: "crescent",
    })
    await modal.present()
    const setLabel = (label: string): void => {
      modal.message = label
    }

    const work = args.workFn({ setLabel })
    let settled: { ok: true; uri: string } | { ok: false; err: unknown } | null = null
    work.then(
      (uri) => {
        settled = { ok: true, uri }
      },
      (err) => {
        settled = { ok: false, err }
      }
    )
    // Suppress unhandled-rejection: every consumer below either reads
    // `settled` or attaches its own .catch in the background branch.
    work.catch(() => undefined)

    // Race vs HANDOFF_MS — early-resolve if work settles first.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, HANDOFF_MS)
      work.finally(() => {
        clearTimeout(t)
        resolve()
      })
    })

    // Branch 1: work finished successfully within 3 s.
    if (settled !== null && (settled as { ok: true; uri: string }).ok === true) {
      await modal.dismiss()
      try {
        await args.openShareSheet((settled as { ok: true; uri: string }).uri)
      } catch {
        await toast.error(args.errorLabel)
      }
      shareJob.finish()
      return
    }

    // Branch 2: work failed within 3 s.
    if (settled !== null && (settled as { ok: false; err: unknown }).ok === false) {
      await modal.dismiss()
      shareJob.finish()
      await toast.error(args.errorLabel)
      return
    }

    // Branch 3: still running. Hand off to background and only NOW show the
    // tab spinner — until this point isInBackground is false so fast paths
    // (Branch 1/2) never flicker the indicator on.
    shareJob.markInBackground()
    await modal.dismiss()
    await toast.info(t("notes.shareInBackground"))
    work
      .then(async (uri) => {
        try {
          await args.openShareSheet(uri)
        } catch (e) {
          // Sheet failed (rare, e.g. app fully backgrounded). Don't toast —
          // file is on the CDN, next tap on the same note is a cache-hit.
          console.warn("background share-sheet failed:", e)
        }
      })
      .catch(async () => {
        await toast.error(args.errorLabel)
      })
      .finally(() => {
        shareJob.finish()
      })
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

    await runShareWorkflow({
      jobKind: "audio",
      noteId: note.id,
      initialLabel: t("notes.shareAudioPreparing"),
      errorLabel: t("notes.shareAudioErrorGeneric"),
      workFn: async () => {
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
          // The cut() returns a sentinel `{ready:false, url:""}` if the
          // server is still processing past the 8 s client-side cap (rare
          // for share-audio); fall back to the predicted URL.
          publicUrl =
            result.url || buildServerUrl(activeServer.value, `public/shares/audio/${note.id}.mp3`)
          if (!result.ready) await pollUntilReady(publicUrl)
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
      },
      openShareSheet: (uri) =>
        shareService.share({
          url: uri,
          title: resolveTrackTitle(track),
          dialogTitle: t("notes.shareAudioDialog"),
        }),
    })
  }

  /** Filesystem path of a previously-shared reel for this note. */
  function localVideoPath(noteId: NoteId): string {
    return `share-video-note-${noteId}.mp4`
  }

  /** Local-cache hit check for a video reel. Mirrors `findLocalExcerpt`. */
  async function findLocalVideo(noteId: NoteId): Promise<string | null> {
    const path = localVideoPath(noteId)
    try {
      await Filesystem.stat({ path, directory: Directory.Cache })
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
      return uri
    } catch {
      return null
    }
  }

  /** CDN warm-probe for a video reel. Mirrors `probeExcerpt`. */
  async function probeVideo(noteId: string): Promise<string | null> {
    const candidate = buildServerUrl(activeServer.value, `public/share/video/${noteId}.mp4`)
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

  async function onShareNoteVideoClicked(): Promise<void> {
    const note: Note | null = currentNote()
    if (!note) return
    const { track } = trackContextFor(note.trackId as TrackId)
    if (!track) {
      await toast.error(t("notes.shareVideoErrorNoAudio"))
      return
    }
    const variant = pickAudioVariant(track)
    if (!variant || !variant.audio) {
      await toast.error(t("notes.shareVideoErrorNoAudio"))
      return
    }
    const audioPath = variant.audio.path

    // Empty-text guard: share-video's `text` field requires non-empty.
    if (!note.text || note.text.trim().length === 0) {
      await toast.error(t("notes.shareVideoErrorGeneric"))
      return
    }

    await runShareWorkflow({
      jobKind: "video",
      noteId: note.id,
      initialLabel: t("notes.shareVideoPreparing"),
      errorLabel: t("notes.shareVideoErrorGeneric"),
      workFn: async (ctx) => {
        // 1. App-cache hit.
        const cached = await findLocalVideo(note.id)
        if (cached) return cached

        // 2. CDN warm hit (someone else's prior render still on the bucket).
        let publicUrl = await probeVideo(note.id)

        // 3. Cold path: trigger the render, wait for the file. Labels
        // progress on a wall clock so YC's server-blocking 120 s wait
        // looks the same to the user as AWS's poll-driven flow.
        if (!publicUrl) {
          const labelSchedule: ReadonlyArray<LabelStep> = [
            { atMs: 5_000, label: t("notes.shareVideoRendering") },
            { atMs: 45_000, label: t("notes.shareVideoAlmostReady") },
            { atMs: 90_000, label: t("notes.shareVideoStillWorking") },
          ]
          const predictedUrl = buildServerUrl(
            activeServer.value,
            `public/share/video/${note.id}.mp4`
          )
          await withProgressLabels(
            (async () => {
              // Tell the server to start. The response body is ignored —
              // useHttpShareVideoService aborts the cut() at 8 s and
              // returns a sentinel `{ready:false}` for slow clouds (YC),
              // so we always end up polling the predicted URL.
              await shareVideoService.cut({
                sourceKey: audioPath,
                startMs: note.timeStart,
                endMs: note.timeEnd,
                text: note.text,
                lang: variant.language,
                theme: "prabhupada",
                videoId: note.id,
              })
              await pollUntilReady(predictedUrl)
            })(),
            labelSchedule,
            ctx.setLabel
          )
          publicUrl = predictedUrl
        }

        await Filesystem.downloadFile({
          url: publicUrl,
          path: localVideoPath(note.id),
          directory: Directory.Cache,
          recursive: true,
        })
        const { uri } = await Filesystem.getUri({
          path: localVideoPath(note.id),
          directory: Directory.Cache,
        })
        return uri
      },
      openShareSheet: (uri) =>
        shareService.share({
          url: uri,
          title: resolveTrackTitle(track),
          dialogTitle: t("notes.shareVideoDialog"),
        }),
    })
  }

  async function onDeleteNoteClicked(): Promise<void> {
    const id = selectedNoteId.value
    if (!id) return
    await store.remove(id)
  }

  const actionSheetButtons = computed<readonly NotesActionSheetButton[]>(() => {
    const buttons: NotesActionSheetButton[] = [
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
    ]
    // Share Video is gated behind debug mode while the feature stabilises
    // (renders are slow, server perf work pending). Settings → tap the
    // BuildInfo row 5× within 3 s to flip useDebugStore().unlocked.
    if (debug.unlocked) {
      buttons.push({
        text: t("notes.shareVideo"),
        handler: () => {
          void onShareNoteVideoClicked()
        },
      })
    }
    buttons.push(
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
      }
    )
    return buttons
  })

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
 * wrapped in `<mark>`. The mark expands to the whole word that
 * contains the match (so a search for "поль" highlights the entire
 * "польза", not just the prefix). Word boundaries are computed against
 * Unicode letter / digit / underscore — punctuation and whitespace end
 * the word. The text is HTML-escaped first so user-supplied characters
 * can't break the `v-html` render in HighlightText.
 */
function highlightMatches(text: string, query: string): string {
  const escaped = escapeHtml(text)
  const needle = escapeHtml(query)
  if (needle.length === 0) return escaped
  // Greedy word match: walk back to the start of the surrounding word
  // and forward to its end, then wrap the whole word. \p{L} keeps
  // Cyrillic/Latin/Greek letters etc. together with digits + `_`.
  const pattern = new RegExp(`[\\p{L}\\p{N}_]*${escapeRegExp(needle)}[\\p{L}\\p{N}_]*`, "giu")
  return escaped.replace(pattern, (match) => `<mark>${match}</mark>`)
}
