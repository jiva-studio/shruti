import { watch } from "vue"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { useSystemBarsStyle } from "@lectorium/composables/useSystemBarsStyle.js"

/**
 * Theme Android's status + navigation bars while the transcript dialog
 * is open. The dialog paints a dark immersive surface that extends
 * under both system bars; the default day-mode dark-on-light icons
 * would disappear against that bleed, so flip both bars to light
 * icons (`style: "DARK"` = dark background) while open and restore
 * the default style on close.
 *
 * Covers every close path — explicit close button, tap-to-close on
 * FloatingPlayer, Android system back — because they all converge on
 * `transcriptStore.close()`. iOS and web are no-ops inside
 * useSystemBarsStyle.
 *
 * Owns nothing; extracted from useTranscriptDialogController so the
 * controller can focus on data orchestration.
 */
export function useTranscriptSystemBars(): void {
  const transcriptStore = useTranscriptStore()
  const systemBars = useSystemBarsStyle()

  watch(
    () => transcriptStore.open,
    (isOpenNow) => {
      if (isOpenNow) void systemBars.applyImmersive()
      else void systemBars.restoreDefault()
    }
  )
}
