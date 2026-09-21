import type { Ref } from "vue"
import type { PlaylistItemId } from "@lib/domain/core.js"
import type { AudioQueueItem, AudioQueueState } from "@ports/app/audioPlayer.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { reportError } from "@lectorium/services/monitoring/reportError.js"
import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import type { PlayerIdentityRefs } from "./playerIdentity.js"

export interface PlayerQueueMirrorDeps {
  readonly refs: PlayerIdentityRefs
  /** The continuous-playback setting; also gates a late entitlement re-arm. */
  readonly autoPlayNext: Ref<boolean>
}

export interface PlayerQueueMirrorReturn {
  /** True while a multi-track native queue (continuous playback) is loaded. */
  isActive(): boolean
  /** True while a rewrite is owed but the engine was paused when it came due. */
  needsRewrite(): boolean
  metaFor(itemId: PlaylistItemId): AudioQueueItem | undefined
  /** Arm queue mode for a queue the engine reports but nothing here built. */
  markActive(): void
  /**
   * Rebuild the mirror when it can't place the item the engine is on: an empty
   * mirror waves every archive through, deleting a file the engine still holds.
   */
  ensureMirror(currentItemId: PlaylistItemId | null): Promise<void>
  /**
   * Rewrite the engine's queue from the mirror, restarting the current item at
   * its live position — `setQueue` is a full replace, the plugin has no
   * per-item removal. False means the mirror can't place the current item; the
   * rewrite flag is cleared either way, or it wedges every later tap here.
   */
  push(state?: AudioQueueState | null): Promise<boolean>
  /** Give a freshly built queue to the engine and take it as the mirror. */
  handOver(items: AudioQueueItem[], startIndex: number, atMs: number): Promise<void>
  /** Forget the mirror — the single-track path and a stopped player. */
  clear(): void
  /** The engine now runs something this mirror did not build. */
  markEngineReplaced(): void
  /** Give back the audio of lectures archived while the engine still held it. */
  flushEvictions(force?: boolean): Promise<void>
  /**
   * Take an item out of the live native queue, so the engine can't reach a
   * lecture whose audio is about to be deleted. True means the file must be
   * KEPT — it is playing, or the queue could not be rewritten on the spot — and
   * every kept file is remembered for a reclaim.
   */
  dropFromQueue(itemId: PlaylistItemId): Promise<boolean>
  /**
   * Hand the playlist tail over for a lecture opened single-track only because
   * the Pro entitlement had not resolved yet. Nothing restarts — `setQueue`
   * resumes at the engine's live position — but it does start playback, so a
   * paused player only gets it on its next resume.
   */
  armForEntitlement(): Promise<void>
}

/**
 * The JS mirror of the native playback queue, and the eviction debt that
 * follows from it. It is the only thing that can say whether a `file://` URL
 * the engine holds is still reachable.
 *
 * Two flags are deliberately distinct: `needsRewrite` says a rewrite is WANTED,
 * `holdsDropped` says the queue the engine actually runs still carries dropped
 * entries — a file may only be reclaimed on a rewrite that landed.
 */
export function usePlayerQueueMirror(deps: PlayerQueueMirrorDeps): PlayerQueueMirrorReturn {
  const app = useLectorium()
  const { refs, autoPlayNext } = deps

  let active = false
  let items: AudioQueueItem[] = []
  let needsRewriteFlag = false
  let holdsDropped = false
  // Archived lectures whose audio survived because the engine could still
  // reach them. The debt is written to the media row too, so a kill in that
  // window doesn't strand the file forever.
  const pendingEvictions = new Set<PlaylistItemId>()

  // `playing` only moves on a progress tick (1 s in the foreground), so for
  // about a second after a pause tap it still reads true — and rewriting a
  // paused queue restarts playback by itself. Ask the engine instead.
  function isEnginePlaying(state: AudioQueueState | null | undefined): boolean {
    return state?.playing ?? refs.playing.value
  }

  function isActive(): boolean {
    return active
  }

  function needsRewrite(): boolean {
    return needsRewriteFlag
  }

  function metaFor(itemId: PlaylistItemId): AudioQueueItem | undefined {
    return items.find((q) => q.itemId === itemId)
  }

  function markActive(): void {
    active = true
  }

  function clear(): void {
    items = []
    active = false
    needsRewriteFlag = false
  }

  function markEngineReplaced(): void {
    holdsDropped = false
  }

  async function ensureMirror(currentItemId: PlaylistItemId | null): Promise<void> {
    if (!currentItemId) return
    if (items.some((q) => q.itemId === currentItemId)) return
    const rebuilt = await usePlaylistStore()
      .buildQueueFrom(currentItemId, refs.language.value ?? undefined)
      .catch(() => [])
    if (rebuilt.length > 0) items = rebuilt
  }

  async function push(state?: AudioQueueState | null): Promise<boolean> {
    needsRewriteFlag = false
    const startIndex = items.findIndex((q) => q.itemId === refs.itemId.value)
    if (startIndex < 0) return false
    // `positionMs` lags by up to one progress tick and `setQueue` restarts the
    // item at whatever we pass, so take the position from the engine.
    const s = state !== undefined ? state : await app.audioPlayer.getQueueState().catch(() => null)
    const at = s && s.currentItemId === refs.itemId.value ? s.positionMs : refs.positionMs.value
    await app.audioPlayer.setQueue(items, startIndex, at)
    // The engine now runs the mirror, which carries none of the dropped
    // entries — this is the moment their files stop being reachable.
    holdsDropped = false
    await flushEvictions()
    return true
  }

  async function handOver(next: AudioQueueItem[], startIndex: number, atMs: number): Promise<void> {
    items = next
    active = true
    needsRewriteFlag = false
    await app.audioPlayer.setQueue(next, startIndex, atMs)
    // A queue built from the ACTIVE playlist carries no archived entry, so
    // whatever the engine was holding is out of reach now.
    holdsDropped = false
  }

  function rememberEviction(itemId: PlaylistItemId): void {
    pendingEvictions.add(itemId)
    void (async () => {
      const track = await usePlaylistStore().resolveTrackForItemId(itemId)
      if (track) await useDownloadStore().markEvictPending(track.id)
    })().catch((e: unknown) => reportError("player", e))
  }

  /**
   * An item archived while it was playing stays in the mirror — taking out the
   * item a rewrite starts from makes that rewrite impossible. Once the engine
   * has moved off it, drop it and arm the rewrite that puts it beyond reach.
   */
  function isStillReachable(itemId: PlaylistItemId): boolean {
    if (itemId === refs.itemId.value) return true
    if (items.some((q) => q.itemId === itemId)) {
      items = items.filter((q) => q.itemId !== itemId)
      needsRewriteFlag = true
      holdsDropped = true
    }
    return holdsDropped
  }

  async function flushEvictions(force = false): Promise<void> {
    if (pendingEvictions.size === 0) return
    for (const id of [...pendingEvictions]) {
      if (!force && isStillReachable(id)) continue
      pendingEvictions.delete(id)
      const track = await usePlaylistStore().resolveTrackForItemId(id)
      if (track) void useDownloadStore().evict(track.id)
    }
  }

  async function dropFromQueue(itemId: PlaylistItemId): Promise<boolean> {
    if (itemId === refs.itemId.value) {
      rememberEviction(itemId)
      return true
    }
    if (active) await ensureMirror(refs.itemId.value)
    const idx = items.findIndex((q) => q.itemId === itemId)
    if (idx < 0) return false
    const currentIdx = items.findIndex((q) => q.itemId === refs.itemId.value)
    items = items.filter((q) => q.itemId !== itemId)
    // Behind the playhead, or a mirror that can't place what is playing (so
    // `push` would push nothing). The engine keeps running the queue it has,
    // entry included, so the file has to stay — and no rewrite is ARMED for it:
    // a rewrite restarts the current lecture, and the sweep archives a finished
    // lecture behind the playhead every time one ends. The file goes back on
    // the next rewrite that happens anyway, or on the next launch's sweep.
    if (currentIdx < 0 || idx < currentIdx) {
      holdsDropped = true
      rememberEviction(itemId)
      return true
    }
    const state = await app.audioPlayer.getQueueState().catch(() => null)
    if (!isEnginePlaying(state)) {
      needsRewriteFlag = true
      holdsDropped = true
      rememberEviction(itemId)
      return true
    }
    await push(state)
    return false
  }

  async function armForEntitlement(): Promise<void> {
    if (active || !autoPlayNext.value) return
    const id = refs.itemId.value
    if (!id) return
    const state = await app.audioPlayer.getQueueState().catch(() => null)
    // The engine has moved on to something else (or holds nothing) — whatever
    // it plays did not come from this store's single-track open.
    if (state && state.currentItemId !== id) return
    const next = await usePlaylistStore().buildQueueFrom(id, refs.language.value ?? undefined)
    // A tail of one is what the engine already has; a tail that can't place the
    // current item can't be started from it.
    if (next.length < 2 || !next.some((q) => q.itemId === id)) return
    items = next
    active = true
    if (!isEnginePlaying(state)) {
      needsRewriteFlag = true
      return
    }
    await push(state)
  }

  return {
    isActive,
    needsRewrite,
    metaFor,
    markActive,
    ensureMirror,
    push,
    handOver,
    clear,
    markEngineReplaced,
    flushEvictions,
    dropFromQueue,
    armForEntitlement,
  }
}
