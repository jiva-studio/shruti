import { computed, ref, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from "vue"
import type { LanguageCode } from "@lib/domain/core.js"
import { useShruti } from "@shruti/shruti.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { buildTranscriptViewData } from "@shruti/composables/buildTranscriptViewData.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useSystemBarsStyle } from "@shruti/composables/useSystemBarsStyle.js"
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
  onSeek(positionSeconds: number): void
  onSelectionAction(action: { action: "copy" | "bookmark" | "share"; text: string }): Promise<void>
  onPickStart(): void
}

export function useTranscriptDialogController(
  preferredLanguage: MaybeRefOrGetter<LanguageCode> = "en"
): TranscriptDialogState {
  const app = useShruti()
  const transcriptStore = useTranscriptStore()
  const player = usePlayerStore()
  const allowMultipleLanguages = ref<boolean>(false)
  const highlightCurrentSentence = useConfig<boolean>("settings.highlightCurrentSentence", true)
  const systemBars = useSystemBarsStyle()

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

  const mirrorsActivePlayer = computed<boolean>(
    () => transcriptStore.trackId !== null && transcriptStore.trackId === player.trackId
  )

  const blockGroups = computed(() => buildTranscriptViewData(loader.transcript.value))
  // Preview mode (Search → Open transcript with no track playing, or a
  // *different* track playing): the global player has no relevance to
  // the open transcript. Surfacing its position/duration would either
  // drift random paragraph timestamps (no track playing → durationMs=0)
  // or pull progress from an unrelated track. Pin to 0 so paragraphs
  // render their own static `startTime` and no progress UI shows.
  const position = computed(() =>
    mirrorsActivePlayer.value ? Math.max(0, player.positionMs / 1000) : 0
  )
  const duration = computed(() =>
    mirrorsActivePlayer.value ? Math.max(0, player.durationMs / 1000) : 0
  )

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

  // System-bar theming: the transcript dialog paints a dark immersive
  // surface that extends under the Android status bar / navigation bar.
  // The default day-mode icon set is dark-on-light, so against the
  // dark bleed the icons disappear. Flip both bars to light icons
  // (`style: "DARK"` = dark background) while open, then restore the
  // default on close. Covers all close paths — explicit close button,
  // tap-to-close on FloatingPlayer, and Android system back button —
  // because they all converge on `transcriptStore.close()`. Android-
  // only inside the composable; iOS / web are no-ops.
  watch(
    () => transcriptStore.open,
    (isOpenNow) => {
      if (isOpenNow) void systemBars.applyImmersive()
      else void systemBars.restoreDefault()
    }
  )

  function onClose(): void {
    transcriptStore.close()
  }

  function onSeek(positionSeconds: number): void {
    // Preview mode (transcript open without that track in the player):
    // seeking would jump the user's actual playback to a random place.
    if (!mirrorsActivePlayer.value) return
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
    mirrorsActivePlayer,
    onClose,
    onSeek,
    onSelectionAction: (event) => selectionActions.perform(event),
    onPickStart,
  }
}
