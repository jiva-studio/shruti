import { computed, watch, type MaybeRefOrGetter, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useToast } from "@kit/composables"
import type { LanguageCode } from "@lib/domain/core.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { multiSpeakerLanguages } from "@lectorium/composables/buildTranscriptViewData.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useTranscriptSystemBars } from "@lectorium/composables/useTranscriptSystemBars.js"
import { useTranscriptTranslation } from "@lectorium/composables/useTranscriptTranslation.js"
import { useTranscriptViewData } from "@lectorium/composables/useTranscriptViewData.js"
import { useTranscriptNotes } from "@lectorium/composables/useTranscriptNotes.js"
import { useTranscriptPlayback } from "@lectorium/composables/useTranscriptPlayback.js"
import { languageFlag, languageLabel } from "@lectorium/composables/transcriptLanguageLabels.js"
import { useTranscriptHydration } from "./transcript/useTranscriptHydration.js"
import { useTranscriptLoader } from "./transcript/useTranscriptLoader.js"
import type { UiTranscriptLanguage } from "@ui/features/transcript/index.js"
import type { TranscriptDialogState } from "@lectorium/composables/transcriptDialogState.js"

export type { TranscriptDialogState } from "@lectorium/composables/transcriptDialogState.js"

export function useTranscriptDialogController(
  preferredLanguage: MaybeRefOrGetter<LanguageCode> = "en"
): TranscriptDialogState {
  const app = useLectorium()
  const { t } = useI18n()
  const toast = useToast()
  const transcriptStore = useTranscriptStore()
  const dictionaries = useDictionariesStore()
  const libraryLanguages = useLibraryLanguages()
  const highlightCurrentSentence = useConfig<boolean>("settings.highlightCurrentSentence", true)
  const autoScrollCfg = useConfig<boolean>("settings.autoScroll", false)
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

  const translation = useTranscriptTranslation({
    storedLanguages: hydration.availableLanguages,
    onVariantArrived: async (trackId) => {
      await hydration.hydrate(trackId)
      await loader.reload(trackId, hydration.activeLanguages.value)
    },
    onError: (key, params) => reportActionError(key, params),
    onNotice: (key, params) => reportActionNotice(key, params),
  })

  /**
   * A failed ACTION (bookmark, ask, translate, chapter tap) is a toast, never
   * `loader.errorKey`: that ref means the document failed to load and swaps
   * the whole reader for an error state. Takes an i18n KEY, never a message —
   * a raw `Error.message` reaches the user in English at every locale.
   */
  function reportActionError(key: string, params?: Record<string, unknown>): void {
    void toast.error(t(key, params ?? {}))
  }

  /** An outcome that is not a failure — a cancelled run, or one still going
   *  after we stopped watching. Same channel, different colour. */
  function reportActionNotice(key: string, params?: Record<string, unknown>): void {
    void toast.info(t(key, params ?? {}))
  }

  const playback = useTranscriptPlayback({
    getTrack: () => hydration.track.value,
    activeLanguages: hydration.activeLanguages,
    authorEntity: hydration.authorEntity,
    onError: reportActionError,
  })
  const { mirrorsActivePlayer, position, duration } = playback

  const notes = useTranscriptNotes({
    getTrack: () => hydration.track.value,
    title: hydration.title,
    author: hydration.author,
    onError: reportActionError,
  })

  const isOpen = computed({
    get: () => transcriptStore.open,
    set: (value: boolean) => {
      if (!value) transcriptStore.close()
    },
  }) as Ref<boolean>

  const viewData = useTranscriptViewData({
    getTrack: () => hydration.track.value,
    activeLanguages: hydration.activeLanguages,
    fallbackTitle: hydration.title,
    transcripts: loader.transcripts,
    notes: notes.notes,
  })
  const { description, chapters, title, blockGroups } = viewData

  const availableLanguages = computed<readonly UiTranscriptLanguage[]>(() => {
    const chips: UiTranscriptLanguage[] = hydration.availableLanguages.value.map((code) => ({
      code,
      name: code.toUpperCase(),
      icon: languageFlag(code),
      available: true,
    }))
    for (const code of translation.targets.value) {
      chips.push({
        code,
        name: code.toUpperCase(),
        icon: languageFlag(code),
        available: false,
        // Per-language, so one running translation spins its own chip and
        // leaves the other targets tappable.
        busy: translation.running.value.has(code),
      })
    }
    return chips
  })

  // Multi-select (flags) only makes sense when the track has more than one
  // transcript language; a single-language track shows no selector.
  const allowMultipleLanguages = computed<boolean>(
    () => hydration.availableLanguages.value.length > 1
  )

  // Which of the displayed transcripts are dialogues. The dialogue affordances
  // used to hang off `allowMultipleLanguages`, which counts LANGUAGES and has
  // nothing to say about speakers (issue #412).
  const dialogueLanguages = computed<ReadonlySet<string>>(() =>
    multiSpeakerLanguages(blockGroups.value)
  )

  // The load failure the reader renders in place of the text. The loader
  // reports a KEY; the sentence is composed here, where the locale is.
  const loadErrorMessage = computed<string | null>(() =>
    loader.errorKey.value ? t(loader.errorKey.value) : null
  )

  // True only after hydration settles — i.e. we know the track has zero
  // advertised transcripts, not "we haven't checked yet". Drives the
  // dialog's empty-state copy.
  const hasNoTranscripts = computed<boolean>(
    () =>
      !loader.isLoading.value &&
      !loader.errorKey.value &&
      hydration.availableLanguages.value.length === 0
  )

  watch(
    () => transcriptStore.trackId,
    async (id) => {
      loader.errorKey.value = null
      if (!id) {
        hydration.reset()
        notes.notes.value = []
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
      await notes.refresh()
    },
    { immediate: true }
  )

  watch(hydration.activeLanguages, async (langs) => {
    if (transcriptStore.trackId) await loader.reload(transcriptStore.trackId, langs)
  })

  // One language of a multi-language reader failed while another one loaded.
  // The text that did load stays on screen — routing this through `loader.errorKey`
  // would swap the whole reader for an error state and throw away the language
  // the user can actually read (issue #1785). Nothing went wrong with what they
  // are looking at, so it is a notice rather than an error toast.
  watch(loader.failedLanguages, (langs) => {
    if (langs.length === 0) return
    reportActionNotice("errors.transcriptLanguageUnavailable", {
      language: langs.map(languageLabel).join(", "),
    })
  })

  function onClose(): void {
    transcriptStore.close()
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
    onTranslateLanguage: translation.translate,
    activeLanguages: hydration.activeLanguages as Ref<readonly LanguageCode[]>,
    blockGroups,
    position,
    duration,
    isLoading: loader.isLoading,
    error: loadErrorMessage,
    hasNoTranscripts,
    allowMultipleLanguages,
    multiSpeakerLanguages: dialogueLanguages,
    highlightCurrentSentence,
    autoScrollCfg,
    mirrorsActivePlayer,
    lastTextSelectedEvent: notes.lastTextSelectedEvent,
    lastNoteTappedEvent: notes.lastNoteTappedEvent,
    onClose,
    onSeek: playback.onSeek,
    onChapterSeek: playback.onChapterSeek,
    onTextSelected: notes.onTextSelected,
    onNoteTapped: notes.onNoteTapped,
    onSelectionAction: notes.onSelectionAction,
    onSelectionDismissed: notes.onSelectionDismissed,
    onPickStart,
  }
}
