import { onMounted, ref, watch, type Ref } from "vue"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useTutorialStore } from "@lectorium/stores/useTutorialStore.js"

/**
 * One-shot pulse cue applied to the FloatingPlayer the first time it
 * appears after the tutorial state has hydrated. Three seconds long;
 * dismisses the `player` tutorial flag in the same go so the cue
 * doesn't fire again on later opens.
 *
 * Returned ref is wired straight to the `pulsing` prop on
 * `FloatingPlayer`.
 */
export function usePlayerTutorialPulse(): Ref<boolean> {
  const player = usePlayerStore()
  const tutorial = useTutorialStore()
  const pulsing = ref<boolean>(false)

  // Bootstrap the tutorial-flag hydration. Idempotent inside the store
  // so calling it from multiple composables is safe.
  onMounted(() => {
    void tutorial.load()
  })

  watch(
    () => player.open,
    (open, prev) => {
      if (!prev && open && tutorial.loaded && !tutorial.flags.player) {
        pulsing.value = true
        setTimeout(() => {
          pulsing.value = false
        }, 3000)
        void tutorial.dismiss("player")
      }
    }
  )

  return pulsing
}
