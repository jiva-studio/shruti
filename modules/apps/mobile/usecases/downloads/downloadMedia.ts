import type { MediaItemId, TrackId } from "@lib/domain/core.js"
import type { MediaAudioKind, MediaItem } from "@lib/domain/mediaItem.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { CdnServer } from "@lib/domain/servers.js"
import { err, ok, type Result } from "@kit/core"
import { hedgeCandidates, type MediaTransferFn, type ScheduleFn } from "./hedgeCandidates.js"

export type { MediaTransferFn, ScheduleFn } from "./hedgeCandidates.js"
export { HEDGE_CEILING_MS, HEDGE_INTERVAL_MS } from "./hedgeCandidates.js"

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

export interface DownloadMediaDeps {
  readonly mediaItems: IMediaItemRepository
  readonly transfer: MediaTransferFn
  /**
   * Used only to make the "claim the download slot" check-and-set atomic.
   * The long transfer itself runs outside any transaction.
   */
  readonly unitOfWork: IUnitOfWork
  /** The hedge's timers. Left out, the platform's own are used. */
  readonly schedule?: ScheduleFn
}

export type DownloadMediaError =
  | "already-in-progress"
  | "no-candidates"
  | "cancelled"
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
 * `input.candidates` are hedged rather than walked one at a time (see
 * `hedgeCandidates`): they enter the race `HEDGE_INTERVAL_MS` apart, the
 * first to deliver a byte wins, and the rest are cancelled on the spot.
 * That makes it the runtime CDN fallback — if the user's active CDN
 * degrades after the Welcome probe the download still completes — while
 * capping the wait at one timeout instead of one per region. The caller
 * inspects `success.server` to decide whether to promote a different CDN
 * to active. A cancel the USER asked for ends everything with
 * `err("cancelled")`; a loser being dropped is invisible.
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

  const claim = await claimDownloadSlot(input.trackId, kind, deps)
  if (claim.kind === "busy") return err("already-in-progress")
  if (claim.kind === "cached") {
    // No transfer happened, so no server can be truthfully attributed. The
    // first candidate is the active one, which callers comparing
    // `success.server` read as a no-op promotion — correct, nothing changed.
    return ok({ mediaItem: claim.mediaItem, server: input.candidates[0]! })
  }

  // No within-server retry: the prober already weeded out servers that 404 the
  // config, and an in-flight CDN failure is what the hedge is for. URLs are
  // built inside the hedge, per attempt — the active-server ref can mutate
  // while we wait, and a URL captured up front would target a stale template.
  const outcome = await hedgeCandidates(
    input.candidates,
    input.path,
    deps.transfer,
    onProgress,
    deps.schedule
  )

  if (outcome.kind === "cancelled") {
    await releaseClaim(input.trackId, kind, claim.id, deps)
    return err("cancelled")
  }
  if (outcome.kind === "failed") {
    // Every CDN failed. `err("transfer-failed")` is the single failure mode
    // the UI can render; the use case stays IO-free, so logging the underlying
    // error is the composition root's job.
    await markFailed(input.trackId, kind, deps)
    return err("transfer-failed")
  }

  // Bytes are on disk. The DB write is a separate failure mode (locked, disk
  // full, schema drift) and must not be conflated with a transfer failure:
  // Retry means different things for the two, and a persist retry should not
  // re-download megabytes that are already cached.
  try {
    const saved = await deps.mediaItems.upsert(input.trackId, "ready", outcome.localUrl, kind)
    return ok({ mediaItem: saved, server: outcome.server })
  } catch {
    return err("persist-failed")
  }
}

type DownloadClaim =
  | { readonly kind: "busy" }
  | { readonly kind: "cached"; readonly mediaItem: MediaItem }
  | { readonly kind: "claimed"; readonly id: MediaItemId }

/**
 * Check-and-claim the "downloading" slot atomically. Two simultaneous taps on
 * the same track race here; the unit of work serialises them, so the loser
 * sees state="downloading" and bows out instead of starting a parallel
 * transfer.
 */
async function claimDownloadSlot(
  trackId: TrackId,
  kind: MediaAudioKind,
  deps: DownloadMediaDeps
): Promise<DownloadClaim> {
  return deps.unitOfWork.run<DownloadClaim>(async (tx) => {
    const existing = await deps.mediaItems.getByTrack(trackId, kind)
    if (existing?.state === "downloading") return { kind: "busy" }
    if (existing?.state === "ready" && existing.localPath) {
      return { kind: "cached", mediaItem: existing }
    }
    // Keep the row id: it identifies OUR claim, so a later release can tell it
    // from a row a newer task claimed after a wipe.
    //
    // `tx` is handed down because `upsert` runs itself through a unit of work:
    // without the handle it would ask for a transaction of its own and wait
    // behind the one we are inside, which never ends.
    const claimed = await deps.mediaItems.upsert(trackId, "downloading", null, kind, tx)
    return { kind: "claimed", id: claimed.id }
  })
}

/**
 * A cancellation the user asked for is a decision, not a CDN fault, so the
 * claimed row is dropped rather than demoted to "failed": the cancel usually
 * comes from a remove that deletes the track's rows anyway, and an upsert
 * racing behind that delete would resurrect it as litter. Only OUR claim goes
 * — a row deleted and re-claimed meanwhile has a different id, and deleting it
 * would strip the newer task's guard.
 */
async function releaseClaim(
  trackId: TrackId,
  kind: MediaAudioKind,
  claimId: MediaItemId,
  deps: DownloadMediaDeps
): Promise<void> {
  try {
    const current = await deps.mediaItems.getByTrack(trackId, kind)
    if (current?.id === claimId) await deps.mediaItems.deleteById(claimId)
  } catch {
    /* swallow — best-effort release of the claimed row */
  }
}

/** Best-effort: a rejected upsert must not mask the transfer failure. */
async function markFailed(
  trackId: TrackId,
  kind: MediaAudioKind,
  deps: DownloadMediaDeps
): Promise<void> {
  try {
    await deps.mediaItems.upsert(trackId, "failed", null, kind)
  } catch {
    /* swallow — surfacing the transfer error matters more */
  }
}
