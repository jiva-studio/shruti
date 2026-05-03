import { useI18n } from "vue-i18n"
import { actionSheetController } from "@ionic/vue"
import type { TrackId } from "@lib/domain/core.js"
import { useShruti } from "@shruti/shruti.js"
import { useOverlaysStore } from "@shruti/stores/useOverlaysStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { useAddToPlaylist } from "./useAddToPlaylist.js"

export interface UseTrackActionSheetReturn {
  present: (trackId: TrackId) => Promise<void>
}

/**
 * Per-track ActionSheet on the Search list. Uses the imperative
 * `actionSheetController` so SearchView stays free of sheet boilerplate
 * (no `isOpen` ref, no `<IonActionSheet>` block, no buttons computed).
 *
 * Transcript availability is resolved once before presenting so the
 * "Open transcript" button renders in its final disabled/enabled state
 * — Ionic's controller doesn't let us mutate buttons after the fact.
 */
export function useTrackActionSheet(): UseTrackActionSheetReturn {
  const { t } = useI18n()
  const app = useShruti()
  const transcriptStore = useTranscriptStore()
  const overlays = useOverlaysStore()
  const { addToPlaylist } = useAddToPlaylist()

  async function present(trackId: TrackId): Promise<void> {
    void app.haptics.impact("light")
    let hasTranscripts: boolean
    try {
      const langs = await app.repositories().transcripts.availableLanguages(trackId)
      hasTranscripts = langs.length > 0
    } catch {
      // On error leave the button enabled — the dialog has its own error UI.
      hasTranscripts = true
    }

    const sheet = await actionSheetController.create({
      buttons: [
        {
          text: t("search.actions.addToPlaylist"),
          handler: () => {
            void addToPlaylist(trackId)
          },
        },
        {
          text: t("search.actions.openTranscript"),
          disabled: !hasTranscripts,
          handler: () => {
            transcriptStore.show(trackId)
          },
        },
        {
          text: t("app.close"),
          role: "cancel",
        },
      ],
    })
    overlays.actionSheetOpen = true
    void sheet.onDidDismiss().then(() => {
      overlays.actionSheetOpen = false
    })
    await sheet.present()
  }

  return { present }
}
