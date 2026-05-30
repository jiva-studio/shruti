import { onBeforeUnmount } from "vue"

/**
 * Central coordinator for every audio surface in the app. There are two
 * kinds of source:
 *
 *   - "main"   — the single floating lecture player (usePlayerStore).
 *   - "inline" — the short snippet players: chat citation chips/cards and
 *                Notes excerpts (one plain <audio> element each).
 *
 * It enforces a single invariant — at most ONE source plays at a time —
 * through two distinct operations:
 *
 *   - claim(self): the source is starting; pause every OTHER source,
 *     regardless of kind. This is the mutual-exclusion primitive used by
 *     both inline snippets and the lecture, so the coordination is
 *     symmetric (a snippet pauses the lecture AND the lecture pauses
 *     snippets).
 *
 *   - pauseGroup(kind): pause all sources of one kind, leave other kinds
 *     untouched. Used for navigation cleanup — pauseGroup("inline") stops
 *     chat snippets on view-leave / session switch WITHOUT ever pausing the
 *     lecture (Ionic keeps the chat page mounted, so per-chip unmount never
 *     fires and the snippets would otherwise keep playing in the
 *     background).
 *
 * Each source registers its own `pause()` callback; the semantics are the
 * source's business — inline players rewind to 0, the lecture keeps its
 * resume position.
 */
export type AudioSourceKind = "main" | "inline"

interface AudioSource {
  readonly kind: AudioSourceKind
  readonly pause: () => void
}

const sources = new Map<symbol, AudioSource>()

function safePause(source: AudioSource): void {
  try {
    source.pause()
  } catch {
    // best-effort — one source's failure must not block the rest
  }
}

/** Pause every source except `self`. Called when `self` is about to play. */
function claim(self: symbol): void {
  for (const [key, source] of sources) {
    if (key === self) continue
    safePause(source)
  }
}

/**
 * Register an audio source. Returns a handle: `claim()` announces this
 * source is starting (pauses all others); `release()` removes it from the
 * registry. Callers outside a Vue component (e.g. the player store) own the
 * release lifecycle; component callers should prefer {@link useAudioSource}.
 */
export function registerAudioSource(
  kind: AudioSourceKind,
  pause: () => void
): { claim: () => void; release: () => void } {
  const key = Symbol()
  sources.set(key, { kind, pause })
  return {
    claim: () => claim(key),
    release: () => {
      sources.delete(key)
    },
  }
}

/**
 * Pause all registered sources of a given kind, leaving other kinds
 * playing. Used by the chat view for cleanup on leave / session switch.
 */
export function pauseGroup(kind: AudioSourceKind): void {
  for (const source of sources.values()) {
    if (source.kind === kind) safePause(source)
  }
}

/**
 * Vue-component wrapper around {@link registerAudioSource} that auto-
 * releases on unmount. Returns `claim` to call when this component's audio
 * starts playing.
 */
export function useAudioSource(kind: AudioSourceKind, pause: () => void): { claim: () => void } {
  const handle = registerAudioSource(kind, pause)
  onBeforeUnmount(handle.release)
  return { claim: handle.claim }
}
