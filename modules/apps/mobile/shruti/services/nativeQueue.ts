import type { PlaylistItemId } from "@lib/domain/core.js"

/**
 * Hand-off between the playlist and the live native playback queue, in the
 * same spirit as `syncEvents`: archiving a lecture deletes its audio, and the
 * engine was handed `file://` URLs when the queue was built — so the item has
 * to leave the queue BEFORE its file goes. The playlist can't import the
 * player store (which imports the playlist store), so the player registers
 * itself here on setup.
 */

/**
 * Drops `itemId` from the live native queue. Resolves `true` when the item's
 * audio must be KEPT — the engine can still reach it.
 */
export type NativeQueueRelease = (itemId: PlaylistItemId) => Promise<boolean>

let release: NativeQueueRelease | null = null

export function setNativeQueueRelease(fn: NativeQueueRelease | null): void {
  release = fn
}

/** See {@link NativeQueueRelease}. Safe to call with no player mounted. */
export async function releaseFromNativeQueue(itemId: PlaylistItemId): Promise<boolean> {
  if (!release) return false
  try {
    return await release(itemId)
  } catch (err) {
    // Couldn't rewrite the queue — assume the engine can still reach the file.
    console.warn("[playback/queue] release failed:", err)
    return true
  }
}
