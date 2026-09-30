import type { TrackId } from "@lib/domain/core.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import type { DownloadDisk } from "./downloadDisk.js"
import type { DownloadBudget, DownloadPlatform, DownloadRowsPort } from "./downloadPorts.js"
import { removeDownloadedMedia } from "./removeDownloadedMedia.js"
import { removeDownloadedTranscripts } from "./removeDownloadedTranscripts.js"

export interface DownloadEviction {
  /** Delete a track's audio and transcripts, in flight or already saved. */
  remove(trackId: TrackId, remoteUrl: string): Promise<void>
  /** Free what a track holds and hand its share of the budget back. */
  evict(trackId: TrackId): Promise<boolean>
  markEvictPending(trackId: TrackId): Promise<void>
  collectOrphans(): Promise<void>
}

export interface DownloadEvictionDeps {
  readonly platform: DownloadPlatform
  readonly rows: DownloadRowsPort
  /** Read per call: the budget is owned by a store the caller resolves lazily. */
  readonly quota: () => DownloadBudget
  readonly disk: DownloadDisk
  readonly cancelInFlight: (trackId: TrackId) => void
  readonly resumeDeferred: () => void
}

/** Giving disk back: removing a track's files and reclaiming what it charged. */
export function createDownloadEviction(deps: DownloadEvictionDeps): DownloadEviction {
  const { platform, rows, quota, disk } = deps

  async function remove(trackId: TrackId, remoteUrl: string): Promise<void> {
    // Stop any in-flight transfer first, else the running worker can finish and
    // re-create the file right after we delete it. Falls back to the remote url
    // when the track has no tracked in-flight one.
    deps.cancelInFlight(trackId)
    await platform.files
      .cancel(remoteUrl)
      .catch((err: unknown) => console.warn("[downloads] cancel before evict failed", err))
    const repos = platform.repositories()
    await removeDownloadedMedia(
      { trackId, remoteUrl },
      { mediaItems: repos.mediaItems, deleteLocal: (url) => platform.files.delete(url) }
    )
    // Transcript JSON goes with the audio. Failures are tolerated per-language
    // inside the use case — an orphan cache entry is kilobytes, and a
    // Settings → Clear cache sweep reclaims it.
    await removeDownloadedTranscripts(
      { trackId },
      {
        transcripts: repos.transcripts,
        deleteLocal: async (id, language) => {
          const path = await repos.tracks.getTranscriptPath(id, language)
          if (!path) return
          await platform.deleteTranscriptFile(path)
        },
      }
    )
    // The file is provably gone, so the memoised disk answer is too.
    disk.recordProbe(trackId, false)
    rows.clearState(trackId)
  }

  /**
   * Resolves the remote url itself so callers (archive, the auto-archive sweep)
   * only need a track id. A no-op unless the track is actually cached:
   * archiving a lecture that was never downloaded must not credit the budget
   * for bytes nobody spent.
   */
  async function evict(trackId: TrackId): Promise<boolean> {
    if (rows.getState(trackId) !== "completed") return false
    const track = await platform.repositories().tracks.getById(trackId)
    const audio = track?.variants.find((v) => v.audio)?.audio
    if (!audio) return false
    // The downloader keys deleted files by url pathname, so the active CDN
    // resolves the same local file even if the bytes arrived from another.
    await remove(trackId, buildServerUrl(platform.activeServer(), audio.path))
    // The credit is the ledger's, not this variant's `filesize`: that read is a
    // third source of truth (the first language's audio, where the measurement
    // charges the largest) and every disagreement stranded budget for the rest
    // of the session.
    quota().forget(trackId)
    deps.resumeDeferred()
    return true
  }

  /**
   * Record that a track's audio is owed an eviction the app could not perform
   * yet, because the native engine could still reach the file. The player holds
   * the same debt for this session; this is the copy that survives the process.
   */
  async function markEvictPending(trackId: TrackId): Promise<void> {
    await platform
      .repositories()
      .mediaItems.markEvictPending(trackId)
      .catch((err: unknown) => {
        console.warn("[downloads] could not record pending eviction:", err)
      })
  }

  /**
   * Reclaim the audio of lectures archived while the engine held them, which
   * never got their eviction because the app was killed before the queue let
   * go. Their row still reads "ready", so the budget keeps charging for a file
   * no playlist points at.
   *
   * Skipped while the engine has a queue loaded: a queue restored from a
   * previous session still holds `file://` urls, and deleting one out from
   * under it is exactly the failure this defers to the player, which can see
   * the queue. The debt is durable, so a skipped sweep is postponed, not lost.
   */
  async function collectOrphans(): Promise<void> {
    try {
      const owed = await platform.repositories().mediaItems.listEvictPending()
      if (owed.length === 0) return
      if (await platform.loadedQueueItem()) return
      for (const item of new Set(owed.map((i) => i.trackId))) await evict(item)
    } catch (err) {
      console.warn("[downloads] orphan collection failed:", err)
    }
  }

  return { remove, evict, markEvictPending, collectOrphans }
}
