import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { createNote } from "@lib/application/createNote.js"
import { loadTranscript } from "@lib/application/loadTranscript.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Transcript } from "@lib/domain/transcript.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { buildTranscriptViewData } from "@lectorium/composables/buildTranscriptViewData.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
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
  readonly allowMultipleLanguages: Ref<boolean>
  readonly highlightCurrentSentence: Ref<boolean>
  onClose(): void
  onSeek(positionSeconds: number): void
  onSelectionAction(action: { action: "copy" | "bookmark" | "share"; text: string }): Promise<void>
}

export function useTranscriptDialogController(
  preferredLanguage: LanguageCode = "en"
): TranscriptDialogState {
  const app = useLectorium()
  const transcriptStore = useTranscriptStore()
  const player = usePlayerStore()

  const title = ref<string>("")
  const author = ref<string>("")
  const availableLanguageCodes = ref<readonly LanguageCode[]>([])
  const activeLanguages = ref<readonly LanguageCode[]>([]) as Ref<readonly LanguageCode[]>
  const transcript = ref<Transcript | null>(null)
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  const allowMultipleLanguages = ref<boolean>(false)
  const highlightCurrentSentence = useConfig<boolean>("settings.highlightCurrentSentence", true)

  let loadToken = 0

  const isOpen = computed({
    get: () => transcriptStore.open,
    set: (value: boolean) => {
      if (!value) transcriptStore.close()
    },
  }) as Ref<boolean>

  const blockGroups = computed(() => buildTranscriptViewData(transcript.value))
  const position = computed(() => Math.max(0, player.positionMs / 1000))
  const duration = computed(() => Math.max(0, player.durationMs / 1000))

  const availableLanguages = computed<readonly UiTranscriptLanguage[]>(() =>
    availableLanguageCodes.value.map((code) => ({ code, name: code.toUpperCase() }))
  )

  async function hydrate(trackId: TrackId): Promise<void> {
    error.value = null
    const repos = app.repositories()
    const track = await repos.tracks.getById(trackId)
    const variant = track
      ? (track.variants.find((v) => v.language === preferredLanguage) ?? track.variants[0])
      : null
    title.value = variant?.title ?? ""
    if (track?.authorId) {
      const a = await repos.authors.getById(track.authorId)
      author.value =
        a?.names.get(preferredLanguage) ?? a?.names.values().next().value ?? track.authorId
    } else {
      author.value = ""
    }
    availableLanguageCodes.value = await repos.transcripts.availableLanguages(trackId)
    const firstActive =
      availableLanguageCodes.value.find((l) => l === preferredLanguage) ??
      availableLanguageCodes.value[0]
    activeLanguages.value = firstActive ? [firstActive] : []
    await reload(trackId)
  }

  async function reload(trackId: TrackId): Promise<void> {
    const lang = activeLanguages.value[0]
    if (!lang) {
      transcript.value = null
      return
    }
    const token = ++loadToken
    isLoading.value = true
    try {
      const result = await loadTranscript(
        { trackId, preferredLanguage: lang },
        { transcripts: app.repositories().transcripts }
      )
      if (token !== loadToken) return
      if (result.ok) {
        transcript.value = result.value.transcript
      } else {
        transcript.value = null
        if (result.error !== "no-transcript-available") {
          error.value = `Transcript failed to load: ${result.error}`
        }
      }
    } finally {
      if (token === loadToken) isLoading.value = false
    }
  }

  watch(
    () => transcriptStore.trackId,
    (id) => {
      if (id) void hydrate(id)
      else {
        transcript.value = null
        title.value = ""
        author.value = ""
        availableLanguageCodes.value = []
        activeLanguages.value = []
        error.value = null
      }
    },
    { immediate: true }
  )

  watch(activeLanguages, () => {
    if (transcriptStore.trackId) void reload(transcriptStore.trackId)
  })

  function onClose(): void {
    transcriptStore.close()
  }

  function onSeek(positionSeconds: number): void {
    void player.seek(Math.round(positionSeconds * 1000))
  }

  async function onSelectionAction(ev: {
    action: "copy" | "bookmark" | "share"
    text: string
  }): Promise<void> {
    const trackId = transcriptStore.trackId
    if (!trackId) return

    if (ev.action === "copy") {
      await app.shareService.copyToClipboard(ev.text)
      return
    }
    if (ev.action === "bookmark") {
      const seconds = Math.max(0, Math.round(player.positionMs / 1000))
      const result = await createNote(
        { trackId, text: ev.text, timeStart: seconds, timeEnd: seconds },
        { notes: app.repositories().notes }
      )
      if (!result.ok) error.value = `Could not save note: ${result.error}`
      return
    }
    if (ev.action === "share") {
      await app.shareService.share({ text: ev.text })
    }
  }

  return {
    isOpen,
    title,
    author,
    availableLanguages,
    activeLanguages: activeLanguages as Ref<readonly LanguageCode[]>,
    blockGroups,
    position,
    duration,
    isLoading,
    error,
    allowMultipleLanguages,
    highlightCurrentSentence,
    onClose,
    onSeek,
    onSelectionAction,
  }
}
