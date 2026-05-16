import { onBeforeUnmount, ref } from "vue"

/**
 * Singleton coordinator for the inline audio players rendered on the
 * Notes page. Each note row instance registers a `pause()` callback;
 * when one player starts, the coordinator pauses everyone else so the
 * user never hears two excerpts overlapping.
 *
 * Independent of the main `usePlayerStore` — these excerpts are short
 * clips (a quote's span), not lecture playback.
 */
const pausers = new Set<() => void>()

export function useNotesInlineAudio(): {
  registerPauser: (fn: () => void) => () => void
  notifyPlaying: (selfPause: () => void) => void
} {
  const owned = ref<() => void>()

  function registerPauser(fn: () => void): () => void {
    pausers.add(fn)
    owned.value = fn
    return () => pausers.delete(fn)
  }

  function notifyPlaying(selfPause: () => void): void {
    for (const fn of pausers) {
      if (fn === selfPause) continue
      try {
        fn()
      } catch {
        // best-effort — never let a sibling row's failure block playback
      }
    }
  }

  onBeforeUnmount(() => {
    if (owned.value) pausers.delete(owned.value)
  })

  return { registerPauser, notifyPlaying }
}
