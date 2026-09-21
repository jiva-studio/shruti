import type { Ref } from "vue"
import type { PlayTrackCommand } from "@usecases/playback/playTrack.js"
import type { LanguageCode, PlaylistItemId } from "@lib/domain/core.js"
import { useShruti } from "@shruti/shruti.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import type { PlayerQueueMirrorReturn } from "./usePlayerQueueMirror.js"

export interface PlayerEngineLoadDeps {
  readonly queue: PlayerQueueMirrorReturn
  readonly autoPlayNext: Ref<boolean>
  /** Re-push mix + speed; a fresh native item loses both. */
  readonly applyEngineSettings: () => void
}

export interface EngineLoadTarget {
  readonly itemId?: PlaylistItemId
  readonly preferredLanguage?: LanguageCode
}

export interface PlayerEngineLoadReturn {
  /**
   * Put `cmd` on the engine at `resumeMs` and start it — as the head of the
   * playlist tail when continuous playback applies, as a single item
   * otherwise. False when the engine refused the load.
   */
  start(
    cmd: PlayTrackCommand,
    url: string,
    resumeMs: number,
    target: EngineLoadTarget
  ): Promise<boolean>
}

/** Hands one play plan to the native engine, queue or single track. */
export function usePlayerEngineLoad(deps: PlayerEngineLoadDeps): PlayerEngineLoadReturn {
  const app = useShruti()
  const { queue } = deps

  /**
   * Continuous playback (Pro): hand the whole playlist tail to the engine so it
   * can auto-advance in the background, where the JS layer is suspended.
   */
  async function tryHandOverQueue(
    cmd: PlayTrackCommand,
    url: string,
    resumeMs: number,
    target: EngineLoadTarget
  ): Promise<boolean> {
    if (!deps.autoPlayNext.value || !usePurchasesStore().isSubscribed) return false
    if (target.itemId === undefined) return false
    const items = await usePlaylistStore().buildQueueFrom(cmd.itemId, target.preferredLanguage)
    const startIndex = items.findIndex((q) => q.itemId === cmd.itemId)
    if (items.length === 0 || startIndex < 0) return false
    // The start item plays from the file we just ensured.
    items[startIndex] = { ...items[startIndex], url }
    await queue.handOver(items, startIndex, resumeMs)
    return true
  }

  async function start(
    cmd: PlayTrackCommand,
    url: string,
    resumeMs: number,
    target: EngineLoadTarget
  ): Promise<boolean> {
    try {
      const queued = await tryHandOverQueue(cmd, url, resumeMs, target)
      if (!queued) {
        queue.clear()
        await app.audioPlayer.open({
          itemId: cmd.itemId,
          url,
          title: cmd.title,
          author: cmd.authorName,
        })
        queue.markEngineReplaced()
      }
      deps.applyEngineSettings()
      // The queue path starts at `resumeMs` itself; single-track plays here.
      if (!queued) {
        if (resumeMs > 0) await app.audioPlayer.seek(resumeMs)
        await app.audioPlayer.play()
      }
      return true
    } catch {
      return false
    }
  }

  return { start }
}
