import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { actionSheetController, loadingController, onIonViewWillEnter } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import router from "@shruti/router/index.js"
import type { UiNoteRow } from "@ui/features/notes/index.js"
import type { Author } from "@lib/domain/author.js"
import type { Location } from "@lib/domain/location.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import type { Track } from "@lib/domain/track.js"
import { formatNoteShare } from "@usecases/notes/formatNoteShare.js"
import { formatReference } from "@lib/domain/services/references.js"
import { formatTrackDate } from "@lib/domain/services/trackDate.js"
import {
  resolveLocalizedName,
  resolveTrackTitle as resolveTitleForLang,
} from "@lib/domain/services/localizedName.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { escapeHtml } from "@lib/chat/utils/escapeHtml.js"
import { SHORT_POLL_TIMEOUT_MS } from "@lib/chat/utils/pollUntilReady.js"
import { renderExcerptHtml } from "@lib/chat/chatMarkers.js"
import { resolveShareArtifact } from "@shruti/services/resolveShareArtifact.js"
import { useToast } from "@kit/composables"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useShareJobStore, type ShareJobKind } from "@shruti/stores/useShareJobStore.js"
import { useStudioHandoffStore } from "@shruti/stores/useStudioHandoffStore.js"

/**
 * Minimum query length that triggers `<mark>` injection in the notes
 * list. The user explicitly asked for "только если больше трёх букв" so
 * single/double/triple-letter queries don't paint half the page yellow.
 */
const MATCH_HIGHLIGHT_MIN_LENGTH = 4

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
  // Direct singleton import (not `useRouter()`): IonActionSheet handlers
  // sometimes fire from a Vue tree context where the router injection
  // is no longer reachable (the sheet portals its content), and Vite
  // dev exposes this fragility too. The singleton from `@shruti/router`
  // is the same instance and is always defined.
  const app = useShruti()
  const store = useNotesStore()
  const dictionaries = useDictionariesStore()
  const appLanguage = useAppLanguage()
  const { shareService, shareAudioService, activeServer, haptics, excerptCache } = useShruti()
  const toast = useToast()
  const shareJob = useShareJobStore()
  const purchases = usePurchasesStore()
  const studioHandoff = useStudioHandoffStore()

  const selectedNoteId = ref<NoteId | null>(null)
  const isActionSheetOpen = ref(false)
  /**
   * Cache of Track entities for every note currently in `store.rendered`.
   * Populated by `refreshTracks` whenever the rendered window changes — the
   * full match set is unbounded, so it is the window that drives the join.
   * Authors and locations are read from the dictionaries store, which is
   * a one-shot full load — no per-row fetch needed.
   */
  const tracksById = ref<ReadonlyMap<TrackId, Track>>(new Map())
  /**
   * Track ids the current `tracksById` was built for, including ids the
   * content DB had no row for. A narrowing filter is fully covered by it, so
   * a query change skips the content-DB roundtrip entirely; paging in more
   * rows widens the set and does hit the DB.
   */
  const cachedTrackIds = ref<ReadonlySet<TrackId>>(new Set())

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

  /**
   * Loads the Track entities behind the rendered notes. Pass `force` when
   * the underlying data may have moved (view entry, after a refresh); the
   * filter-driven path relies on the id cache above to stay quiet.
   */
  async function refreshTracks(force = false): Promise<void> {
    const ids = Array.from(new Set(store.rendered.map((n) => n.trackId as TrackId)))
    if (ids.length === 0) {
      tracksById.value = new Map()
      cachedTrackIds.value = new Set()
      return
    }
    if (!force && ids.every((id) => cachedTrackIds.value.has(id))) return
    try {
      tracksById.value = await app.repositories().tracks.getByIds(ids)
      cachedTrackIds.value = new Set(ids)
    } catch {
      tracksById.value = new Map()
      cachedTrackIds.value = new Set()
    }
  }

  /**
   * The content DB was asked about this track and had no row for it — the
   * lecture is hidden or gone from the catalog. Distinct from "not looked up
   * yet" (first paint, or a failed read, which empties both), where the row
   * must stay optimistic rather than flash a degraded card.
   */
  function isTrackUnresolved(trackId: TrackId): boolean {
    return cachedTrackIds.value.has(trackId) && !tracksById.value.has(trackId)
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
    return resolveLocalizedName(author, appLanguage.value)
  }

  function resolveLocationName(location: Location | undefined): string | undefined {
    return resolveLocalizedName(location, appLanguage.value)
  }

  function resolveTrackTitle(track: Track | undefined): string | undefined {
    return resolveTitleForLang(track, appLanguage.value)
  }

  // ExcerptCard prints whatever it is handed, so the localization happens
  // here — same as every other lecture surface.
  function resolveTrackDate(track: Track | undefined): string | undefined {
    if (!track?.date) return undefined
    return formatTrackDate(track.date, appLanguage.value)
  }

  function resolveReference(track: Track | undefined): string | undefined {
    if (!track || track.references.length === 0) return undefined
    return formatReference(track.references[0]!, dictionaries.sourcesById, appLanguage.value)
  }

  const rows = computed<readonly UiNoteRow[]>(() => {
    // `appliedQuery`, not `query`: the live query runs ahead of `filtered` by
    // the search debounce, and marking the previous result set against the
    // newer text drops or adds `<mark>`s for those 200 ms.
    const q = store.appliedQuery.trim()
    const wrap = q.length >= MATCH_HIGHLIGHT_MIN_LENGTH

    return store.rendered.map((n) => {
      const { track, author, location } = trackContextFor(n.trackId as TrackId)
      const audioVariant = track ? pickPlayableVariant(track) : null
      // Render the snippet's inline markdown (`*em*`, `**bold**`, `> śloka`)
      // the SAME way the chat citation card does (renderExcerptHtml), so a
      // saved note reads identically to its chat origin instead of printing
      // literal asterisks. Search highlighting then injects `<mark>` into the
      // rendered HTML's text runs only (never inside the generated tags).
      const html = renderExcerptHtml(n.text)
      return {
        id: n.id,
        text: wrap ? highlightHtml(html, q) : html,
        trackId: n.trackId,
        language: "",
        timeStart: n.timeStart,
        timeEnd: n.timeEnd,
        createdAt: n.createdAt,
        authorName: resolveAuthorName(author),
        trackTitle: resolveTrackTitle(track),
        trackDate: resolveTrackDate(track),
        locationName: resolveLocationName(location),
        reference: resolveReference(track),
        audioPath: audioVariant?.audio?.path,
        trackUnresolved: isTrackUnresolved(n.trackId as TrackId),
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
      locale: appLanguage.value,
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
   * Canonical filename of a previously-shared excerpt for this note,
   * stored flat in the excerpt directory by {@link excerptCache.download}.
   * Centralised here so the cache lookup and the download stay in
   * lock-step.
   */
  function localExcerptPath(noteId: NoteId): string {
    return `share-audio-note-${noteId}.mp3`
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
      const stop = (): void => {
        clearTimeout(t)
        resolve()
      }
      // `then(stop, stop)`, not `finally(stop)`: `finally` returns a derived
      // promise that re-raises the rejection, and nothing here consumes it.
      work.then(stop, stop)
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
    const variant = pickPlayableVariant(track)
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
      workFn: () =>
        resolveShareArtifact({
          cache: excerptCache,
          filename: localExcerptPath(note.id),
          predictedUrl: buildServerUrl(activeServer.value, `public/shares/audio/${note.id}.mp3`),
          cut: () =>
            shareAudioService.cut({
              sourceKey: audioPath,
              startMs: note.timeStart,
              endMs: note.timeEnd,
              excerptId: note.id,
            }),
          // An audio cut takes seconds. Without this it inherited the
          // 8-minute Studio-video default, so a dead URL held the app-wide
          // single share slot for that long; the sibling transcript path
          // (`useShareTranscript`) has always passed the short budget.
          pollTimeoutMs: SHORT_POLL_TIMEOUT_MS,
        }),
      openShareSheet: (uri) =>
        shareService.share({
          url: uri,
          title: resolveTrackTitle(track),
          dialogTitle: t("notes.shareAudioDialog"),
        }),
    })
  }

  /**
   * Second-level "Share" sheet (Text / Audio / Video), mirroring the
   * per-track share sub-menu in {@link useShareTrack}. Opened imperatively
   * via the controller so it can stack on top of the top-level note sheet.
   */
  async function presentShareMenu(): Promise<void> {
    void haptics.impact("light")
    const sheet = await actionSheetController.create({
      header: t("notes.share"),
      buttons: [
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
          text: t("notes.shareVideo"),
          cssClass: "action-sheet-pro",
          handler: () => {
            onOpenInStudioClicked()
          },
        },
        {
          text: t("app.close"),
          role: "cancel",
        },
      ],
    })
    await sheet.present()
  }

  /**
   * Studio entry point. Pro-gated — non-subscribers see the paywall
   * instead of navigating to the editor. The editor itself re-checks
   * the gate on mount so a stale "subscribed" cache can't slip through.
   */
  function onOpenInStudioClicked(): void {
    const id = selectedNoteId.value
    if (!id) return
    void (async () => {
      if (!(await purchases.ensurePro("notesStudio"))) return
      studioHandoff.setPending({ kind: "note", noteId: id })
      void router.push("/tabs/studio")
    })()
  }

  async function onDeleteNoteClicked(): Promise<void> {
    const id = selectedNoteId.value
    if (!id) return
    await store.remove(id)
  }

  const actionSheetButtons = computed<readonly NotesActionSheetButton[]>(() => {
    // Top level: quick Copy-text + the nested Share menu (which holds the
    // text/audio/video shares and Open in Studio). Copy text drops the note
    // straight on the clipboard; Share opens the second sheet.
    return [
      {
        text: t("notes.copyText"),
        handler: () => {
          void onCopyNoteClicked()
        },
      },
      {
        text: t("app.share"),
        handler: () => {
          void presentShareMenu()
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
    ]
  })

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
    // The notes page needs dictionaries (authors / locations / sources)
    // for the source-context line under each item; pre-warm so the first
    // paint already has them.
    await dictionaries.ensureLoaded()
    await store.refresh()
    await refreshTracks(true)
  })

  // Ionic Tabs не размонтируют вкладку — `onMounted` стреляет один раз.
  // Без этого хука после создания заметки и возврата на вкладку список
  // мог не обновляться. Дубль с `onMounted` на первой активации безобиден:
  // store.refresh() идемпотентна, словари уже закешированы.
  onIonViewWillEnter(async () => {
    await store.refresh()
    await refreshTracks(true)
  })

  watch(
    () => store.rendered,
    () => {
      void refreshTracks()
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Returns rendered-snippet `html` with every case-insensitive occurrence of
 * `query` wrapped in `<mark>`. The mark expands to the whole word that
 * contains the match (so a search for "поль" highlights the entire
 * "польза", not just the prefix). Word boundaries are computed against
 * Unicode letter / digit / underscore — punctuation and whitespace end
 * the word.
 *
 * `html` is already escaped/rendered markdown (renderExcerptHtml output), so
 * we must NOT re-escape it. Instead split on tags and inject `<mark>` into
 * the text runs ONLY — never inside a generated tag (`<em>`, `<blockquote …>`,
 * `<br>`), which would corrupt the markup. The query is HTML-escaped so it
 * matches the escaped text and can't break the `v-html` render.
 */
function highlightHtml(html: string, query: string): string {
  const needle = escapeHtml(query)
  if (needle.length === 0) return html
  // Greedy word match: walk back to the start of the surrounding word
  // and forward to its end, then wrap the whole word. \p{L} keeps
  // Cyrillic/Latin/Greek letters etc. together with digits + `_`.
  const pattern = new RegExp(`[\\p{L}\\p{N}_]*${escapeRegExp(needle)}[\\p{L}\\p{N}_]*`, "giu")
  // Capturing split → odd segments are tags (left untouched), even segments
  // are visible text where the highlight is safe to inject.
  return html
    .split(/(<[^>]+>)/)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(pattern, (match) => `<mark>${match}</mark>`)))
    .join("")
}
