import { useI18n } from "vue-i18n"
import { actionSheetController } from "@ionic/vue"
import type { TrackId } from "@lib/domain/core.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useOverlaysStore } from "@lectorium/stores/useOverlaysStore.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { useTutorialStore } from "@lectorium/stores/useTutorialStore.js"
import { useAddToPlaylist } from "./useAddToPlaylist.js"
import { useShareTrack } from "./useShareTrack.js"

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
  const app = useLectorium()
  const transcriptStore = useTranscriptStore()
  const tutorial = useTutorialStore()
  const overlays = useOverlaysStore()
  const purchases = usePurchasesStore()
  const paywall = usePaywallStore()
  const { addToPlaylist } = useAddToPlaylist()
  const { presentShareMenu } = useShareTrack()

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
            // Explicit user tap on a transcript action — mark the
            // transcript as discovered so the FloatingPlayer pulse cue
            // stops inviting on subsequent opens.
            void tutorial.dismiss("transcriptOpened")
            transcriptStore.show(trackId)
          },
        },
        {
          text: t("search.actions.share"),
          // Pro feature. The "PRO" pill always shows as a CSS ::after
          // (Ionic buttons can't host a Vue component) — see theme/misc.css
          // `.action-sheet-pro`. Non-subscribers get the paywall on tap.
          cssClass: "action-sheet-pro",
          handler: () => {
            if (!purchases.isSubscribed) {
              paywall.requestOpen("shareTranscript")
              return
            }
            // Opens a second action sheet with the per-format share
            // options (PDF / text / audio); each row resolves its own
            // availability there.
            void presentShareMenu(trackId)
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
