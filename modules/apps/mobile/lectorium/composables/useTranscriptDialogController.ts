import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import type { LanguageCode } from "@lib/domain/core.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { buildTranscriptViewData } from "@lectorium/composables/buildTranscriptViewData.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
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
  onClose(): void
  onSeek(positionSeconds: number): void
  onSelectionAction(action: { action: "copy" | "bookmark" | "share"; text: string }): Promise<void>
  onPickStart(): void
}

export function useTranscriptDialogController(
  preferredLanguage: LanguageCode = "en"
): TranscriptDialogState {
  const app = useLectorium()
  const transcriptStore = useTranscriptStore()
  const player = usePlayerStore()
  const allowMultipleLanguages = ref<boolean>(false)
  const highlightCurrentSentence = useConfig<boolean>("settings.highlightCurrentSentence", true)

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

  const selectionActions = useTranscriptSelectionActions({
    getTrackId: () => transcriptStore.trackId,
    getPositionSeconds: () => player.positionMs / 1000,
    getNotes: () => app.repositories().notes,
    shareService: app.shareService,
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

  const blockGroups = computed(() => buildTranscriptViewData(loader.transcript.value))
  const position = computed(() => Math.max(0, player.positionMs / 1000))
  const duration = computed(() => Math.max(0, player.durationMs / 1000))

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
        await loader.reload(undefined, undefined)
        return
      }
      await hydration.hydrate(id)
      await loader.reload(id, hydration.activeLanguages.value[0])
    },
    { immediate: true }
  )

  watch(hydration.activeLanguages, async (langs) => {
    if (transcriptStore.trackId) await loader.reload(transcriptStore.trackId, langs[0])
  })

  function onClose(): void {
    transcriptStore.close()
  }

  function onSeek(positionSeconds: number): void {
    void player.seek(Math.round(positionSeconds * 1000))
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
    onClose,
    onSeek,
    onSelectionAction: (event) => selectionActions.perform(event),
    onPickStart,
  }
}
