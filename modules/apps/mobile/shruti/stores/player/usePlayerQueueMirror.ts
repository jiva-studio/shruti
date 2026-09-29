import type { Ref } from "vue"
import {
  createPlayerQueueMirror,
  type PlayerQueueMirrorReturn,
} from "@usecases/playback/playerQueueMirror.js"
import { useShruti } from "@shruti/shruti.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import type { PlayerIdentityRefs } from "./playerIdentity.js"

export type { PlayerQueueMirrorReturn }

/** The player store's mirror of the native queue, bound to its refs and stores. */
export function usePlayerQueueMirror(deps: {
  readonly refs: PlayerIdentityRefs
  readonly autoPlayNext: Ref<boolean>
}): PlayerQueueMirrorReturn {
  const app = useShruti()
  const { refs } = deps
  return createPlayerQueueMirror({
    identity: {
      itemId: () => refs.itemId.value,
      positionMs: () => refs.positionMs.value,
      playing: () => refs.playing.value,
      language: () => refs.language.value,
    },
    autoPlayNext: () => deps.autoPlayNext.value,
    engine: app.audioPlayer,
    playlist: usePlaylistStore,
    downloads: useDownloadStore,
    reportError: (err) => reportError("player", err),
  })
}
