import { onBeforeUnmount, ref } from "vue"

/**
 * Singleton coordinator for the inline audio players rendered on the
 * Notes page. Each note row instance registers a `pause()` callback;
 * when one player starts, the coordinator pauses everyone else so the
 * user never hears two excerpts overlapping.
 *
 * The main lecture player can also opt in via {@link registerMainPlayerPauser}
 * so an excerpt and a lecture never play at the same time.
 */
const pausers = new Set<() => void>()

/**
 * Register a `pause()` callback owned by something outside the inline-
 * note-player rows (e.g. the main lecture player). Unlike the per-row
 * registration, the returned dispose handle is the caller's
 * responsibility — there is no Vue lifecycle hook here, since the main
 * player lives for the app's lifetime.
 */
export function registerMainPlayerPauser(fn: () => void): () => void {
  pausers.add(fn)
  return () => pausers.delete(fn)
}

/**
 * Pause every registered inline player. Views that host a stack of
 * inline players (e.g. Chat citation chips) call this on view-leave and
 * session switch: Ionic keeps the page mounted in the router outlet, so
 * per-chip unmount cleanup never fires and audio would otherwise keep
 * playing after the user navigates away.
 */
export function pauseAllInlineAudio(): void {
  for (const fn of pausers) {
    try {
      fn()
    } catch {
      // best-effort — one player's failure must not block the rest
    }
  }
}

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
