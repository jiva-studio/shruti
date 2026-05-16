import { computed, onMounted, type ComputedRef } from "vue"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useTutorialStore } from "@shruti/stores/useTutorialStore.js"

/**
 * Looping pulse cue for the FloatingPlayer. Stays on whenever the
 * player is visible AND the user hasn't yet discovered the transcript
 * affordance. Driven directly by the tutorial flags so it keeps
 * inviting on every session until the user actually taps; tapping the
 * player calls `tutorial.dismiss("transcriptOpened")` in App.vue, which
 * flips this computed to `false` permanently.
 *
 * `player` flag stays in the gate as a back-compat for users who
 * dismissed it via the previous one-shot timer — they should not see
 * the cue re-appear.
 *
 * Returned ref is wired straight to the `pulsing` prop on
 * `FloatingPlayer`. The CSS animation (`@keyframes inviteClick`) is
 * already `infinite`, so as long as this returns `true` the player
 * keeps pulsing.
 */
export function usePlayerTutorialPulse(): ComputedRef<boolean> {
  const player = usePlayerStore()
  const tutorial = useTutorialStore()

  onMounted(() => {
    void tutorial.load()
  })

  return computed<boolean>(
    () =>
      tutorial.loaded && player.open && !tutorial.flags.player && !tutorial.flags.transcriptOpened
  )
}
