import { computed, ref, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from "vue"
import type { LanguageCode } from "@lib/domain/core.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import type { Note } from "@lib/domain/note.js"
import type { NoteShareContext } from "@usecases/notes/formatNoteShare.js"
import { useShruti } from "@shruti/shruti.js"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import router from "@shruti/router/index.js"
import { buildMergedTranscriptViewData } from "@shruti/composables/buildTranscriptViewData.js"
import { formatReference } from "@lib/domain/services/references.js"
import { resolveLocalizedName } from "@lib/domain/services/localizedName.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useTranscriptSystemBars } from "@shruti/composables/useTranscriptSystemBars.js"
import { useTranscriptHydration } from "./transcript/useTranscriptHydration.js"
import { useTranscriptLoader } from "./transcript/useTranscriptLoader.js"
import { useTranscriptSelectionActions } from "./transcript/useTranscriptSelectionActions.js"
import type {
  ExistingNoteSelection,
  NoteTappedEvent,
  TextSelectedEvent,
  UiTranscriptBlocksGroup,
  UiTranscriptLanguage,
} from "@ui/features/transcript/index.js"
import type { SelectionActionEvent } from "./transcript/useTranscriptSelectionActions.js"

export interface TranscriptDialogState {
  readonly isOpen: Ref<boolean>
  readonly title: Ref<string>
  readonly author: Ref<string>
  readonly description: ComputedRef<string | null>
  readonly chapters: ComputedRef<readonly TrackOutlineChapter[]>
  readonly availableLanguages: ComputedRef<readonly UiTranscriptLanguage[]>
  readonly activeLanguages: Ref<readonly LanguageCode[]>
  readonly blockGroups: ComputedRef<readonly UiTranscriptBlocksGroup[]>
  readonly position: ComputedRef<number>
  readonly duration: ComputedRef<number>
  readonly isLoading: Ref<boolean>
  readonly error: Ref<string | null>
  readonly hasNoTranscripts: ComputedRef<boolean>
  readonly allowMultipleLanguages: Ref<boolean>
  readonly highlightCurrentSentence: Ref<boolean>
  readonly autoScrollCfg: Ref<boolean>
  /**
   * True when the dialog mirrors the track currently loaded in the
   * player. Drives both seek and the prompter scaling effect — both
   * only make sense when there's a live `position`.
   */
  readonly mirrorsActivePlayer: ComputedRef<boolean>
  /**
   * Live drag-select payload — set by `onTextSelected`, cleared on
   * popover action/dismiss. `App.vue` binds this to the sibling
   * `TranscriptSelectionPopover.selection` prop (see App.vue for the
   * rationale behind the sibling-mount design).
   */
  readonly lastTextSelectedEvent: Ref<TextSelectedEvent | undefined>
  /** Tap-on-existing-highlight payload. Same lifecycle as `lastTextSelectedEvent`. */
  readonly lastNoteTappedEvent: Ref<ExistingNoteSelection | undefined>
  onClose(): void
  onSeek(positionMs: number): void
  /** Chapter tapped: seek + start/resume playback (loading the track first
   *  when the transcript was opened in preview mode). */
  onChapterSeek(positionMs: number): Promise<void>
  onTextSelected(event: TextSelectedEvent): void
  onNoteTapped(event: NoteTappedEvent): void
  onSelectionAction(event: SelectionActionEvent): Promise<void>
  onSelectionDismissed(): void
  onPickStart(): void
}

export function useTranscriptDialogController(
  preferredLanguage: MaybeRefOrGetter<LanguageCode> = "en"
): TranscriptDialogState {
  const app = useShruti()
  const transcriptStore = useTranscriptStore()
  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const dictionaries = useDictionariesStore()
  const notesStore = useNotesStore()
  const chatStore = useChatStore()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  const highlightCurrentSentence = useConfig<boolean>("settings.highlightCurrentSentence", true)
  const autoScrollCfg = useConfig<boolean>("settings.autoScroll", false)
  /**
   * Saved notes for the currently open transcript, refreshed whenever the
   * track changes or a new bookmark is created. Drives the `bookmarked`
   * flag on each block in `blockGroups` so historic highlights reappear
   * on re-open of the same transcript.
   */
  const notesForTrack = ref<readonly Note[]>([])
  // Selection state for the popover that lives at App.vue level as a
  // sibling of TranscriptDialog. Drag-select fills `lastTextSelectedEvent`;
  // tapping an existing highlight fills `lastNoteTappedEvent`. Setting
  // either one to `undefined` closes the popover (the popover's watcher
  // collapses to `isOpen=false`).
  const lastTextSelectedEvent = ref<TextSelectedEvent>()
  const lastNoteTappedEvent = ref<ExistingNoteSelection>()
  useTranscriptSystemBars()

  // Repos are resolved lazily — at app root the controller is constructed
  // before the content DB is open, so `app.repositories()` would throw.
  const hydration = useTranscriptHydration({
    preferredLanguage,
    libraryLanguages: () => libraryLanguages.value,
    getRepos: () => {
      const repos = app.repositories()
      return { tracks: repos.tracks, authors: repos.authors, transcripts: repos.transcripts }
    },
  })

  const loader = useTranscriptLoader({
    getTranscripts: () => app.repositories().transcripts,
  })

  async function refreshNotesForTrack(): Promise<void> {
    const id = transcriptStore.trackId
    if (!id) {
      notesForTrack.value = []
      return
    }
    try {
      notesForTrack.value = await app.repositories().notes.listByTrack(id)
    } catch {
      notesForTrack.value = []
    }
  }

  function buildShareTrackContext(): NoteShareContext["track"] | undefined {
    const track = hydration.track.value
    if (!track) return undefined
    const lang = appLanguage.value
    const location = track.locationId ? dictionaries.locationsById.get(track.locationId) : undefined
    const locationName = resolveLocalizedName(location, lang)
    const reference =
      track.references.length > 0
        ? formatReference(track.references[0]!, dictionaries.sourcesById, lang)
        : undefined
    return {
      title: hydration.title.value || undefined,
      authorName: hydration.author.value || undefined,
      date: track.date || undefined,
      locationName,
      reference,
    }
  }

  const selectionActions = useTranscriptSelectionActions({
    getTrackId: () => transcriptStore.trackId,
    getNotes: () => app.repositories().notes,
    getUnitOfWork: () => app.repositories().unitOfWork,
    shareService: app.shareService,
    getShareTrackContext: buildShareTrackContext,
    onNoteCreated: () => {
      // Refresh both the dialog's in-memory note list (drives the
      // wavy-underline highlight on the transcript) and the global
      // notes store (drives the Notes page list). Without this the new
      // bookmark stays invisible until the user re-opens the app.
      void refreshNotesForTrack()
      void notesStore.refresh()
    },
    onNoteDeleted: () => {
      // Same refresh dance as onNoteCreated: drop the underline from the
      // transcript and remove the row from the Notes tab.
      void refreshNotesForTrack()
      void notesStore.refresh()
    },
    onError: (message) => {
      loader.error.value = message
    },
    onAskRequested: async ({ trackId, text, timeStart, timeEnd }) => {
      // Build focus payload — pin all bibliographic context at insert
      // time so a later catalog rename / dictionary swap doesn't
      // silently change the focus card's header. Source-audio path
      // is best-effort: missing audio → focus message renders with a
      // disabled player (still useful as a quoted text card).
      const track = hydration.track.value
      const ctx = buildShareTrackContext()
      const variant = track ? pickPlayableVariant(track) : null
      const sourceKey = variant?.audio?.path ?? undefined
      const lang = appLanguage.value
      const location = track?.locationId
        ? dictionaries.locationsById.get(track.locationId)
        : undefined
      const locationName = location ? resolveLocalizedName(location, lang) : undefined
      const focus = {
        trackId,
        startMs: timeStart,
        endMs: timeEnd,
        text,
        sourceKey,
        trackTitle: ctx?.title,
        authorName: ctx?.authorName,
        date: ctx?.date,
        location: locationName,
      }
      // Prep chat state FIRST while the transcript modal is still
      // mounted — that way our `chatStore` calls have access to the
      // user-DB without racing the modal teardown.
      try {
        const sessionId = await chatStore.openOrCreateFocusedSession(trackId)
        const focusMessageId = await chatStore.appendFocusMessage(focus)
        // Fire-and-forget — chips land on the focus message's
        // `followups` once /questions resolves (or `[]` on failure,
        // which the card interprets as "fall back to static i18n").
        void chatStore.requestSuggestions(focusMessageId, focus)
        chatStore.requestInputFocus()
        // Navigate FIRST, then close the modal (issue #662). The old
        // order — close, then `await router.push` — let the modal-
        // dismiss reactivity slip a frame in before the route swap
        // resolved. If the user was already on the chat tab, that
        // window was long enough for ChatView's route watcher to
        // re-fire `ensureSessionFromRoute` against the stale `/tabs/
        // chat` path (no `sessionId`), which called
        // `store.startNewSession()` and wiped the active session the
        // controller had just set up — leaving the user staring at
        // the empty chat list instead of the per-track session.
        // Awaiting the push first guarantees `route.query.session`
        // matches the freshly-created session before ChatView's
        // watcher or onMounted reads it; the modal then dismisses
        // over the already-correct chat view.
        await router.push({ name: "chat", query: { session: sessionId } })
        transcriptStore.close()
      } catch (err) {
        console.warn("[transcript] ask-sadhu dispatch failed:", err)
        loader.error.value = err instanceof Error ? err.message : String(err)
      }
    },
  })

  const isOpen = computed({
    get: () => transcriptStore.open,
    set: (value: boolean) => {
      if (!value) transcriptStore.close()
    },
  }) as Ref<boolean>

  const mirrorsActivePlayer = computed<boolean>(
    () => transcriptStore.trackId !== null && transcriptStore.trackId === player.trackId
  )

  // Auto-paragraph break threshold (chars). Bound to a user-tunable
  // setting so a future Settings screen can expose it; 350 is the chosen
  // default after eyeballing 30-min lectures (~5-10 paragraphs each).
  const paragraphChars = useConfig<number>("settings.transcript.paragraphChars", 350)

  // When several languages are shown at once, blocks group together across
  // languages (a sentence and its translation stay in one paragraph). Set true
  // to force a fresh paragraph at every language switch. No UI toggle — config-only.
  const breakParagraphOnLanguage = useConfig<boolean>(
    "settings.transcript.breakParagraphOnLanguageChange",
    false
  )

  // Lecture overview (description + chapter outline) for the displayed
  // language, rendered at the top of the transcript — the same data the track
  // bottom-sheet shows. Falls back to the playable variant when the active
  // language has no own variant. Declared before `blockGroups` because the
  // builder splits the transcript at these chapter boundaries.
  const overviewVariant = computed(() => {
    const track = hydration.track.value
    if (!track) return null
    const lang = hydration.activeLanguages.value[0]
    return track.variants.find((v) => v.language === lang) ?? pickPlayableVariant(track)
  })
  const description = computed<string | null>(() => overviewVariant.value?.description ?? null)
  const chapters = computed<readonly TrackOutlineChapter[]>(
    () => overviewVariant.value?.outline ?? []
  )
  // Title in the displayed language: a lecturer+translator recording shows the
  // translated title when its language is active, falling back to the track's.
  const title = computed<string>(() => overviewVariant.value?.title || hydration.title.value)

  const blockGroups = computed(() =>
    buildMergedTranscriptViewData(loader.transcripts.value, {
      paragraphChars: paragraphChars.value,
      sourcesById: dictionaries.sourcesById,
      lang: appLanguage.value,
      notes: notesForTrack.value,
      chapters: chapters.value,
      breakOnLanguageChange: breakParagraphOnLanguage.value,
    })
  )
  // Preview mode (Search → Open transcript with no track playing, or a
  // *different* track playing): the global player has no relevance to
  // the open transcript. Surfacing its position/duration would either
  // drift random paragraph timestamps (no track playing → durationMs=0)
  // or pull progress from an unrelated track. Pin to 0 so paragraphs
  // render their own static `startTime` and no progress UI shows.
  //
  // Position/duration are kept in MILLISECONDS — same units as
  // `transcript.blocks[].start`/`end` and `player.positionMs`. The UI
  // compares them directly without unit conversion.
  const position = computed(() => (mirrorsActivePlayer.value ? Math.max(0, player.positionMs) : 0))
  const duration = computed(() => (mirrorsActivePlayer.value ? Math.max(0, player.durationMs) : 0))

  const availableLanguages = computed<readonly UiTranscriptLanguage[]>(() =>
    hydration.availableLanguages.value.map((code) => ({
      code,
      name: code.toUpperCase(),
      icon: languageFlag(code),
    }))
  )

  // Multi-select (flags) only makes sense when the track has more than one
  // transcript language; a single-language track shows no selector.
  const allowMultipleLanguages = computed<boolean>(
    () => hydration.availableLanguages.value.length > 1
  )

  // True only after hydration settles — i.e. we know the track has zero
  // advertised transcripts, not "we haven't checked yet". Drives the
  // dialog's empty-state copy.
  const hasNoTranscripts = computed<boolean>(
    () =>
      !loader.isLoading.value &&
      !loader.error.value &&
      hydration.availableLanguages.value.length === 0
  )

  watch(
    () => transcriptStore.trackId,
    async (id) => {
      loader.error.value = null
      if (!id) {
        hydration.reset()
        notesForTrack.value = []
        await loader.reload(undefined, [])
        return
      }
      // Hydrate the sources dictionary so verse references resolve to
      // localised names (issue #399). Home/Search controllers already
      // pre-warm it; this covers the case where the dialog opens before
      // either view has been visited (e.g. tutorial deep-link).
      void dictionaries.ensureLoaded()
      await hydration.hydrate(id)
      await loader.reload(id, hydration.activeLanguages.value)
      // Load saved notes after the transcript so the first paint of the
      // block list already has `bookmarked` set on the right paragraphs.
      await refreshNotesForTrack()
    },
    { immediate: true }
  )

  watch(hydration.activeLanguages, async (langs) => {
    if (transcriptStore.trackId) await loader.reload(transcriptStore.trackId, langs)
  })

  function onClose(): void {
    transcriptStore.close()
  }

  function onSeek(positionMs: number): void {
    // Preview mode (transcript open without that track in the player):
    // seeking would jump the user's actual playback to a random place.
    if (!mirrorsActivePlayer.value) return
    void player.seek(Math.round(positionMs))
  }

  // Chapter tapped (outline row or inline heading). Unlike a plain seek this
  // is an explicit "take me here and play": jump + ensure playback. In
  // preview mode the track isn't loaded yet, so start it from the chapter.
  async function onChapterSeek(positionMs: number): Promise<void> {
    const ms = Math.max(0, Math.round(positionMs))
    if (mirrorsActivePlayer.value) {
      await player.seek(ms)
      if (!player.playing) await player.togglePause()
      return
    }
    const track = hydration.track.value
    if (!track) return
    // Preview mode: load this track and start at the chapter. Pass the
    // playlist item id (resume/queue persistence) and the author entity
    // (system-player label), mirroring how the player is opened elsewhere.
    const result = await player.openTrack({
      track,
      preferredLanguage: hydration.activeLanguages.value[0],
      author: hydration.authorEntity.value,
      itemId: playlist.getEntryByTrackId(track.id)?.item.id,
      resumeFromMs: ms,
    })
    if (!result.ok) loader.error.value = `Could not start playback: ${result.error}`
  }

  // Selection lifecycle. The two events are mutually exclusive — opening
  // one always clears the other — so the popover's `selection`/`existing`
  // props never both light up at once.
  function onTextSelected(event: TextSelectedEvent): void {
    lastNoteTappedEvent.value = undefined
    lastTextSelectedEvent.value = event
  }

  function onNoteTapped(event: NoteTappedEvent): void {
    lastTextSelectedEvent.value = undefined
    lastNoteTappedEvent.value = { noteIds: event.noteIds, event: event.event }
  }

  async function onSelectionAction(event: SelectionActionEvent): Promise<void> {
    // Clear refs first — that flips the popover to `isOpen=false`
    // immediately, so its dismiss animation runs in parallel with the
    // action's async work (DB write for bookmark, chat session for ask).
    lastTextSelectedEvent.value = undefined
    lastNoteTappedEvent.value = undefined
    await selectionActions.perform(event)
  }

  function onSelectionDismissed(): void {
    lastTextSelectedEvent.value = undefined
    lastNoteTappedEvent.value = undefined
  }

  function onPickStart(): void {
    void app.haptics.impact("light")
  }

  return {
    isOpen,
    title,
    author: hydration.author,
    description,
    chapters,
    availableLanguages,
    activeLanguages: hydration.activeLanguages as Ref<readonly LanguageCode[]>,
    blockGroups,
    position,
    duration,
    isLoading: loader.isLoading,
    error: loader.error,
    hasNoTranscripts,
    allowMultipleLanguages,
    highlightCurrentSentence,
    autoScrollCfg,
    mirrorsActivePlayer,
    lastTextSelectedEvent,
    lastNoteTappedEvent,
    onClose,
    onSeek,
    onChapterSeek,
    onTextSelected,
    onNoteTapped,
    onSelectionAction,
    onSelectionDismissed,
    onPickStart,
  }
}

/** Country-flag emoji for a transcript language code (the corpus languages);
 *  undefined for anything unmapped so the selector shows the code alone rather
 *  than a placeholder. A language isn't a country — this is a best-effort label. */
function languageFlag(code: string): string | undefined {
  const flags: Record<string, string> = {
    en: "🇬🇧",
    ru: "🇷🇺",
    hi: "🇮🇳",
    es: "🇪🇸",
    fr: "🇫🇷",
    de: "🇩🇪",
    pt: "🇵🇹",
    it: "🇮🇹",
    ja: "🇯🇵",
    nl: "🇳🇱",
    uk: "🇺🇦",
    bn: "🇧🇩",
  }
  return flags[code.toLowerCase()]
}
