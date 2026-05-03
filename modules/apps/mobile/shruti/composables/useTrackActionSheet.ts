import { computed, ref, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import type { ActionSheetButton } from "@ionic/vue"
import type { TrackId } from "@lib/domain/core.js"
import { useShruti } from "@shruti/shruti.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { useAddToPlaylist } from "./useAddToPlaylist.js"

export interface UseTrackActionSheetReturn {
  isOpen: Ref<boolean>
  buttons: ComputedRef<readonly ActionSheetButton[]>
  present: (trackId: TrackId) => Promise<void>
  dismiss: () => void
}

/**
 * Drives the per-track ActionSheet on the Search list. Owns its own
 * open/close state and asynchronously checks transcript availability
 * so the "Open transcript" button can dim itself when the track has
 * none. Add-to-playlist stays a one-tap action behind the sheet.
 */
export function useTrackActionSheet(): UseTrackActionSheetReturn {
  const { t } = useI18n()
  const app = useShruti()
  const transcriptStore = useTranscriptStore()
  const { addToPlaylist } = useAddToPlaylist()

  const isOpen = ref<boolean>(false)
  const selectedTrackId = ref<TrackId | null>(null)
  // null = "haven't checked yet"; flips to a boolean once
  // availableLanguages resolves. The button is enabled by default and
  // only dims after we've confirmed there are zero transcripts.
  const transcriptsAvailable = ref<boolean | null>(null)

  const buttons = computed<readonly ActionSheetButton[]>(() => {
    const trackId = selectedTrackId.value
    if (!trackId) return []
    return [
      {
        text: t("search.actions.addToPlaylist"),
        handler: () => {
          void addToPlaylist(trackId)
        },
      },
      {
        text: t("search.actions.openTranscript"),
        disabled: transcriptsAvailable.value === false,
        handler: () => {
          transcriptStore.show(trackId)
        },
      },
      {
        text: t("app.close"),
        role: "cancel",
      },
    ]
  })

  async function present(trackId: TrackId): Promise<void> {
    selectedTrackId.value = trackId
    transcriptsAvailable.value = null
    isOpen.value = true
    void app.haptics.impact("light")
    try {
      const langs = await app.repositories().transcripts.availableLanguages(trackId)
      // Race-protect: stale callback for a previous trackId is ignored.
      if (selectedTrackId.value === trackId) {
        transcriptsAvailable.value = langs.length > 0
      }
    } catch {
      // Leave the button enabled — the dialog has its own error UI.
      if (selectedTrackId.value === trackId) {
        transcriptsAvailable.value = true
      }
    }
  }

  function dismiss(): void {
    isOpen.value = false
    selectedTrackId.value = null
    transcriptsAvailable.value = null
  }

  return { isOpen, buttons, present, dismiss }
}
