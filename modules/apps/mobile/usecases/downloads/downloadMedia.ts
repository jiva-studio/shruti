import type { TrackId } from "@lib/domain/core.js"
import type { MediaAudioKind, MediaItem } from "@lib/domain/mediaItem.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { buildServerUrl, type CdnServer } from "@lib/domain/servers.js"
import { err, ok, type Result } from "@kit/core"

export interface DownloadMediaInput {
  readonly trackId: TrackId
  /**
   * Storage key (full bucket path, including the `public/` prefix).
   * The use case re-resolves a fresh URL per attempt via
   * `buildServerUrl(server, path)`, so a CDN swap mid-flight cannot
   * produce a stale URL.
   */
  readonly path: string
  /**
   * Ordered candidate servers to try. The caller (download store)
   * is expected to put the currently-active server first so we hit
   * the happy path on the first attempt and only iterate the rest
   * on failure.
   */
  readonly candidates: readonly CdnServer[]
  /** Which audio version is being fetched. Defaults to "original". */
  readonly kind?: MediaAudioKind
}

/**
 * Raw byte-transfer callback. The use case is layer-pure — it can't
 * import `@ports/app/IMediaDownloader` — so the caller (typically the
 * download store) passes the adapter-backed transfer as a plain
 * function. Returning the local URL fulfils the use case's contract
 * to persist `localPath` on success.
 *
 * The optional `onProgress` is forwarded down to the platform downloader
 * so the UI can render a real radial gauge. `total` may be ≤ 0 when the
 * server omits Content-Length — callers must guard against that.
 */
export type MediaTransferFn = (
  url: string,
  onProgress?: (received: number, total: number) => void
) => Promise<string>

export interface DownloadMediaDeps {
  readonly mediaItems: IMediaItemRepository
  readonly transfer: MediaTransferFn
  /**
   * Used only to make the "claim the download slot" check-and-set atomic.
   * The long transfer itself runs outside any transaction.
   */
  readonly unitOfWork: IUnitOfWork
}

export type DownloadMediaError =
  | "already-in-progress"
  | "no-candidates"
  | "transfer-failed"
  | "persist-failed"

export interface DownloadMediaSuccess {
  readonly mediaItem: MediaItem
  /** The CDN server whose URL actually delivered the bytes. */
  readonly server: CdnServer
}

/**
 * Download a track's media and persist the lifecycle in the user DB
 * so the UI can recover the "ready" indicator after a relaunch. The
 * state machine is pending → downloading → ready / failed, serialised
 * through `IMediaItemRepository.upsert`.
 *
 * The use case iterates `input.candidates` in order and returns on the
 * first server that delivers bytes. That makes it the runtime CDN
 * fallback: if the user's active CDN degrades after the Welcome probe,
 * the download still completes by trying every alternative once,
 * priority-ordered, before declaring `transfer-failed`. The caller
 * inspects `success.server` to decide whether to promote a different
 * CDN to active.
 *
 * Optional `onProgress(pct)` reports the rounded percentage 0..100 only
 * when the byte total is known.
 */
export async function downloadMedia(
  input: DownloadMediaInput,
  deps: DownloadMediaDeps,
  onProgress?: (pct: number) => void
): Promise<Result<DownloadMediaSuccess, DownloadMediaError>> {
  if (input.candidates.length === 0) return err("no-candidates")
  const kind = input.kind ?? "original"

  // Check-and-claim the "downloading" slot atomically. Two simultaneous
  // taps on the same track race here; the unit-of-work serialises them,
  // so the loser sees state="downloading" and bows out with
  // "already-in-progress" instead of starting a parallel transfer.
  type Claim = { kind: "busy" } | { kind: "cached"; mediaItem: MediaItem } | { kind: "claimed" }
  const claim = await deps.unitOfWork.run<Claim>(async () => {
    const existing = await deps.mediaItems.getByTrack(input.trackId, kind)
    if (existing?.state === "downloading") return { kind: "busy" }
    if (existing?.state === "ready" && existing.localPath) {
      return { kind: "cached", mediaItem: existing }
    }
    await deps.mediaItems.upsert(input.trackId, "downloading", null, kind)
    return { kind: "claimed" }
  })

  if (claim.kind === "busy") return err("already-in-progress")
  if (claim.kind === "cached") {
    // No transfer happened, so we can't truthfully attribute a server.
    // Pick the first candidate (active server) — callers checking
    // `success.server` against `activeServer` will treat this as a
    // no-op promotion, which is correct: nothing changed.
    return ok({ mediaItem: claim.mediaItem, server: input.candidates[0]! })
  }

  let localUrl: string | null = null
  let workingServer: CdnServer | null = null

  // Iterate every candidate once (no within-server retry — the prober
  // already weeded out servers that 404 the config; an in-flight CDN
  // failure is what we're trying to survive). Build the URL freshly
  // per attempt: the active-server ref can mutate between attempts,
  // and a captured URL would silently target a stale template.
  for (const server of input.candidates) {
    const url = buildServerUrl(server, input.path)
    try {
      localUrl = await deps.transfer(url, (received, total) => {
        if (total > 0) onProgress?.(Math.round((received / total) * 100))
      })
      workingServer = server
      break
    } catch {
      // Tell the next attempt to draw 0% — otherwise the radial gauge
      // could display the previous server's last reported chunk while
      // we re-establish from byte 0 elsewhere.
      onProgress?.(0)
    }
  }

  if (localUrl === null || workingServer === null) {
    // Every CDN failed. `err("transfer-failed")` is the single failure
    // mode the UI can render; the use case stays IO-free, so logging the
    // underlying error is the composition root's job (error-handling
    // policy: the view controller catches and logs at the outer edge).
    // Best-effort mark "failed"; if the upsert itself rejects we don't
    // want a second exception masking the original transfer failure.
    try {
      await deps.mediaItems.upsert(input.trackId, "failed", null, kind)
    } catch {
      /* swallow — surfacing the transfer error matters more */
    }
    return err("transfer-failed")
  }

  // Bytes are on disk. The DB write is a separate failure mode (locked,
  // disk full, schema drift) and must not be conflated with a transfer
  // failure — Retry has different semantics for the two: a persist
  // retry should not re-download megabytes that are already cached.
  try {
    const saved = await deps.mediaItems.upsert(input.trackId, "ready", localUrl, kind)
    return ok({ mediaItem: saved, server: workingServer })
  } catch {
    return err("persist-failed")
  }
}
