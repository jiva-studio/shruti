import { computed, ref, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from "vue"
import type { LanguageCode, NoteId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { NoteShareContext } from "@lib/application/formatNoteShare.js"
import { useShruti } from "@shruti/shruti.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { buildTranscriptViewData } from "@shruti/composables/buildTranscriptViewData.js"
import { formatReference } from "@shruti/composables/groupReferences.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useTranscriptSystemBars } from "@shruti/composables/useTranscriptSystemBars.js"
import { useTranscriptHydration } from "./transcript/useTranscriptHydration.js"
import { useTranscriptLoader } from "./transcript/useTranscriptLoader.js"
import { useTranscriptSelectionActions } from "./transcript/useTranscriptSelectionActions.js"
import type {
  UiTranscriptBlocksGroup,
  UiTranscriptLanguage,
} from "@ui/features/transcript/index.js"

export interface TranscriptDialogState {
  readonly isOpen: Ref<boolean>
  readonly title: Ref<string>
  readonly author: Ref<string>
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
  /**
   * True when the dialog mirrors the track currently loaded in the
   * player. Drives both seek and the prompter scaling effect — both
   * only make sense when there's a live `position`.
   */
  readonly mirrorsActivePlayer: ComputedRef<boolean>
  onClose(): void
  onSeek(positionMs: number): void
  onSelectionAction(action: {
    action: "copy" | "bookmark" | "share" | "delete"
    text: string
    timeStart: number
    timeEnd: number
    noteIds: readonly NoteId[]
  }): Promise<void>
  onPickStart(): void
}

export function useTranscriptDialogController(
  preferredLanguage: MaybeRefOrGetter<LanguageCode> = "en"
): TranscriptDialogState {
  const app = useShruti()
  const transcriptStore = useTranscriptStore()
  const player = usePlayerStore()
  const dictionaries = useDictionariesStore()
  const notesStore = useNotesStore()
  const appLanguage = useAppLanguage()
  const allowMultipleLanguages = ref<boolean>(false)
  const highlightCurrentSentence = useConfig<boolean>("settings.highlightCurrentSentence", true)
  /**
   * Saved notes for the currently open transcript, refreshed whenever the
   * track changes or a new bookmark is created. Drives the `bookmarked`
   * flag on each block in `blockGroups` so historic highlights reappear
   * on re-open of the same transcript.
   */
  const notesForTrack = ref<readonly Note[]>([])
  useTranscriptSystemBars()

  // Repos are resolved lazily — at app root the controller is constructed
  // before the content DB is open, so `app.repositories()` would throw.
  const hydration = useTranscriptHydration({
    preferredLanguage,
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
    const locationName = track.locationId
      ? (dictionaries.locationsById.get(track.locationId)?.names.get(lang) ??
        dictionaries.locationsById.get(track.locationId)?.names.values().next().value ??
        undefined)
      : undefined
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

  const blockGroups = computed(() =>
    buildTranscriptViewData(loader.transcript.value, {
      paragraphChars: paragraphChars.value,
      sourcesById: dictionaries.sourcesById,
      lang: appLanguage.value,
      notes: notesForTrack.value,
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
    hydration.availableLanguages.value.map((code) => ({ code, name: code.toUpperCase() }))
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
        await loader.reload(undefined, undefined)
        return
      }
      // Hydrate the sources dictionary so verse references resolve to
      // localised names (issue #399). Home/Search controllers already
      // pre-warm it; this covers the case where the dialog opens before
      // either view has been visited (e.g. tutorial deep-link).
      void dictionaries.ensureLoaded()
      await hydration.hydrate(id)
      await loader.reload(id, hydration.activeLanguages.value[0])
      // Load saved notes after the transcript so the first paint of the
      // block list already has `bookmarked` set on the right paragraphs.
      await refreshNotesForTrack()
    },
    { immediate: true }
  )

  watch(hydration.activeLanguages, async (langs) => {
    if (transcriptStore.trackId) await loader.reload(transcriptStore.trackId, langs[0])
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

  function onPickStart(): void {
    void app.haptics.impact("light")
  }

  return {
    isOpen,
    title: hydration.title,
    author: hydration.author,
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
    mirrorsActivePlayer,
    onClose,
    onSeek,
    onSelectionAction: (event) => selectionActions.perform(event),
    onPickStart,
  }
}
