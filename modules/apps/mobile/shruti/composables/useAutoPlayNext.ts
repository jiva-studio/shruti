import type { Ref } from "vue"
import { useConfig } from "@shruti/composables/useConfig.js"

/**
 * Persisted preference key for "play next track automatically" — the Pro
 * continuous-playback toggle. Shared so the settings UI and the player
 * store read/write the exact same config entry (`useConfig` caches by key
 * and hands every caller the same reactive Ref).
 */
export const AUTO_PLAY_NEXT_KEY = "settings.playback.autoPlayNext"

export function useAutoPlayNext(): Ref<boolean> {
  return useConfig<boolean>(AUTO_PLAY_NEXT_KEY, false)
}
