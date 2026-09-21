import type { TrackId } from "@lib/domain/core.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import type { Lectorium } from "@lectorium/lectorium.js"
import type { useDownloadQuotaStore } from "../useDownloadQuotaStore.js"
import type { DownloadRows } from "./downloadRows.js"

/** The quota store, read from the active registry per call rather than captured. */
type Quota = () => ReturnType<typeof useDownloadQuotaStore>

/** How many demoted rows one launch will ask the disk about. */
const STALE_RECONCILE_LIMIT = 32

export interface DownloadDisk {
  /** Remember what the disk answered about a track, so a walk can skip it. */
  recordProbe(trackId: TrackId, found: boolean): void
  adoptCachedFile(trackId: TrackId, localPath: string, filesize?: number | null): Promise<void>
  adoptIfOnDisk(trackId: TrackId, path: string, filesize?: number | null): Promise<boolean>
  reconcileStaleDownloads(trackIds: readonly TrackId[]): Promise<void>
  clear(): void
}

export interface DownloadDiskDeps {
  readonly app: Lectorium
  readonly rows: DownloadRows
  readonly quota: Quota
  readonly isInFlight: (trackId: TrackId) => boolean
}

/**
 * The half of the state machine that consults the disk.
 *
 * Everything else is derived from `media_items` plus budget arithmetic, so a
 * file present on disk but absent from the table reads as "not downloaded"
 * while the player, which resolves the same file independently, plays it
 * offline. These probes are what close that gap.
 */
export function createDownloadDisk(deps: DownloadDiskDeps): DownloadDisk {
  const { app, rows, quota } = deps
  // Tracks the disk was asked about and did not have. Memoised because the
  // probe is a native round trip and the prefetch FIFO re-walks its tail on
  // every eviction and every limit change. Everything that puts a file there
  // goes through this store and drops the entry.
  const absentFromDisk = new Set<TrackId>()

  function recordProbe(trackId: TrackId, found: boolean): void {
    if (found) absentFromDisk.delete(trackId)
    else absentFromDisk.add(trackId)
  }

  /**
   * Take ownership of audio the native cache is already holding: write the
   * `media_items` row and charge the budget, exactly as a finished transfer
   * does.
   *
   * A file can exist with nothing in the ledger pointing at it — sharing a
   * lecture downloads the full audio through the same adapter and the same key
   * — and everything that rebuilds from `listReady()` is blind to such a file.
   * Idempotent, and safe for a track that is already tracked.
   */
  async function adoptCachedFile(
    trackId: TrackId,
    localPath: string,
    filesize?: number | null
  ): Promise<void> {
    const epoch = rows.currentEpoch()
    absentFromDisk.delete(trackId)
    await app
      .repositories()
      .mediaItems.upsert(trackId, "ready", localPath)
      .catch((err: unknown) => {
        console.warn("[downloads] could not adopt a cached file:", err)
      })
    // A wipe landing while the row was being written owns the maps now.
    if (epoch !== rows.currentEpoch()) return
    quota().adopt(trackId, quota().sizeOf(filesize))
    rows.setState(trackId, "completed")
  }

  /**
   * Ask the disk whether this lecture is already saved, and adopt it if so.
   *
   * A `failed` row is left alone: the file its last attempt left behind may be
   * a CDN error page written to the lecture's own path, and adopting that would
   * make a corrupt download permanent. Those rows keep their retry, which
   * re-fetches rather than trusting what is there.
   */
  async function adoptIfOnDisk(
    trackId: TrackId,
    path: string,
    filesize?: number | null
  ): Promise<boolean> {
    if (absentFromDisk.has(trackId)) return false
    if (rows.effectiveState(trackId) === "failed") return false
    try {
      const url = buildServerUrl(app.activeServer.value, path)
      const cached = await app.mediaDownloader.resolveLocalUrl(url)
      if (!cached) {
        absentFromDisk.add(trackId)
        return false
      }
      await adoptCachedFile(trackId, cached, filesize)
      return true
    } catch (err) {
      console.warn("[downloads] disk probe failed:", err)
      return false
    }
  }

  /**
   * Ask the disk about the rows the previous session left mid-transfer, and put
   * back the ones whose bytes did arrive.
   *
   * `failStaleDownloads()` has to demote them all, or the row keeps the next
   * attempt refused as already-in-progress — but it demotes blind, and on iOS a
   * background `URLSession` goes on delivering while the app is suspended, so
   * the file lands while the row still says "downloading".
   *
   * VALIDITY IS PRESENCE, deliberately, and not a size comparison: both native
   * backends put a file at the destination only by an atomic move after a 2xx
   * response, nothing below can read a file's size, and the catalog's
   * `filesize` is null for every personal-library import — so a size gate would
   * refuse exactly the tracks whose only source of truth is the disk.
   */
  async function reconcileStaleDownloads(trackIds: readonly TrackId[]): Promise<void> {
    // Bounded so a pathological table cannot turn a launch into an unbounded
    // series of bridge calls; past the cap the rows keep their demotion.
    const pending = [...new Set(trackIds)].slice(0, STALE_RECONCILE_LIMIT)
    if (pending.length === 0) return
    const epoch = rows.currentEpoch()
    try {
      const tracks = await app.repositories().tracks.getByIds(pending)
      for (const trackId of pending) {
        if (epoch !== rows.currentEpoch()) return
        // A transfer started since hydrate owns this row: it writes its own
        // outcome, and it is already probing the same file.
        if (deps.isInFlight(trackId)) continue
        const track = tracks.get(trackId)
        const audio = track ? pickPlayableVariant(track)?.audio : null
        // Nothing to ask the disk about: the track left the catalog, or has no
        // audio at all. The row keeps the demotion.
        if (!audio) continue
        await adoptIfOnDisk(trackId, audio.path, audio.filesize)
      }
    } catch (err) {
      console.warn("[downloads] stale download reconciliation failed:", err)
    }
  }

  return {
    recordProbe,
    adoptCachedFile,
    adoptIfOnDisk,
    reconcileStaleDownloads,
    clear: () => absentFromDisk.clear(),
  }
}
