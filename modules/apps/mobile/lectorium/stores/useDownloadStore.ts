import { defineStore } from "pinia"
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useToast } from "@kit/composables"
import { downloadMedia } from "@usecases/downloads/downloadMedia.js"
import { removeDownloadedMedia } from "@usecases/downloads/removeDownloadedMedia.js"
import { removeDownloadedTranscripts } from "@usecases/downloads/removeDownloadedTranscripts.js"
import type { TrackId } from "@lib/domain/core.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useDownloadQuotaStore } from "./useDownloadQuotaStore.js"
import { useServerFallback } from "./downloads/useServerFallback.js"
import { useTranscriptPrefetch } from "./downloads/useTranscriptPrefetch.js"

/**
 * `pending` — the tap has been accepted but nothing is known yet: the
 * cache probe, the budget measurement and the play plan all still have to
 * resolve. Claimed synchronously so the row answers on the very next
 * frame; every real outcome below overwrites it, and `clearPending` puts
 * the row back the way it was if the caller bails first.
 *
 * `deferred` — queued for offline use but held back because the storage
 * budget is spent. It is not a failure and not in flight: the track waits
 * in the FIFO until an eviction frees room (see `resumeDeferred`).
 */
export type DownloadState = "idle" | "pending" | "downloading" | "deferred" | "completed" | "failed"

/**
 * Who asked for this download. `"user"` is a tap the user is waiting on (a
 * play, a retry, "download again"); `"queue"` is the prefetch FIFO working
 * through a playlist on its own. Only the notice rate-limit reads it — the
 * user's own request is never suppressed by the queue's.
 */
export type DownloadOrigin = "user" | "queue"

/**
 * How long a download attempt may go without a single byte before it is
 * declared dead.
 *
 * A STALL deadline, deliberately not a cap on the whole transfer: a lecture is
 * tens of megabytes and a slow mobile link can legitimately spend half an hour
 * on one, so a total-duration limit would fail exactly the users who need
 * offline most. What a live transfer never does is go two minutes without
 * delivering anything — the native side reports every chunk — so silence is
 * the honest signal, and it costs a slow connection nothing.
 *
 * Comfortably above `HEDGE_CEILING_MS` (15s), which already bounds the silence
 * BEFORE the first byte, so this only ever fires on a transfer the hedge has
 * already handed over to.
 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 120_000

/** How often the stall watch looks at the clock. */
const STALL_CHECK_INTERVAL_MS = 5_000

/** What the stall watch resolves with; distinct from any real result. */
const STALLED = Symbol("stalled")

/**
 * Watch an attempt for total silence and settle when it lasts too long.
 *
 * Nothing else bounds one: the adapter's promise settles only on a native
 * `completed` / `failed` event for its own id, and there are ways for neither
 * to arrive (an entry removed from the metadata store mid-flight, a
 * stalled-but-open connection that iOS holds until its one-hour resource
 * timeout). One such attempt used to freeze auto-download for the rest of the
 * process (#1730).
 *
 * Only FOREGROUND time counts. A webview suspended in the user's pocket stops
 * delivering progress events and stops running timers, and reading that
 * silence as death would kill a background transfer that is in fact still
 * moving bytes. The clock restarts on resume, so a genuinely dead transfer is
 * still caught — one deadline later, with the app in the user's hands.
 */
function startStallWatch(): {
  readonly expired: Promise<typeof STALLED>
  readonly touch: () => void
  readonly stop: () => void
} {
  let lastByteAt = Date.now()
  let timer: ReturnType<typeof setInterval> | undefined
  const expired = new Promise<typeof STALLED>((resolve) => {
    timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        lastByteAt = Date.now()
        return
      }
      if (Date.now() - lastByteAt < DOWNLOAD_STALL_TIMEOUT_MS) return
      resolve(STALLED)
    }, STALL_CHECK_INTERVAL_MS)
  })
  return {
    expired,
    touch: () => {
      lastByteAt = Date.now()
    },
    stop: () => clearInterval(timer),
  }
}

/**
 * Per-track media download state. The source of truth is the user DB
 * (`IMediaItemRepository`) — this store hydrates once from `listReady()`
 * so the "downloaded" indicator survives app relaunches, and in-flight
 * signals are tracked in memory for the duration of a session.
 *
 * CDN rotation (`useServerFallback`) and transcript prefetch
 * (`useTranscriptPrefetch`) are split into composables under
 * `stores/downloads/`. The store keeps the reactive state maps and the
 * `ensureDownloaded` orchestration.
 */
export const useDownloadStore = defineStore("downloads", () => {
  const app = useLectorium()
  const fallback = useServerFallback()
  const transcriptPrefetch = useTranscriptPrefetch()
  const { t } = useI18n()
  const toast = useToast()

  const states = ref<Map<TrackId, DownloadState>>(new Map())
  // Per-track download progress 0..100. Populated only while a download
  // is in flight; cleared on completed/failed/idle/remove.
  const progress = ref<Map<TrackId, number>>(new Map())
  // Set when the most recent `hydrate()` couldn't read the user DB
  // (schema drift, db locked, plugin error). Without this, the UI
  // showed every track as "not downloaded" and the user had no signal
  // why. The Welcome screen / Settings can render a banner from this.
  const hydrationError = ref<string | null>(null)
  const inFlight = new Map<TrackId, Promise<string | null>>()
  // The CDN url a track's transfer was started with, kept while it's in
  // flight so remove()/cancelPrefetch()/reset() can abort the native
  // transfer. One url is enough even though the download may be hedging
  // several regions at once: the downloader keys by the url's path, so
  // cancelling with any of them stops every candidate. Cleared when the
  // task settles.
  const inFlightUrls = new Map<TrackId, string>()
  /**
   * One per running task, so a cancel that arrives BEFORE the native transfer
   * is registered still stops the task.
   *
   * `inFlightUrls` is set at the top of the task, but nothing exists natively
   * until `transfer()` runs — several awaits later (the cache probe, the stale
   * -row repair, `ensureMeasured`, the budget gate). A cancel landing in that
   * window used to issue a native cancel for a url the plugin had never heard
   * of and change nothing: the download proceeded and re-created the file the
   * archive had just deleted.
   */
  const inFlightAborts = new Map<TrackId, AbortController>()
  // Who is waiting on each in-flight task, boxed so a caller that JOINS a
  // running transfer can upgrade it (see `ensureDownloaded`). Only the
  // failure notice's rate-limit reads it.
  const inFlightOrigins = new Map<TrackId, { current: DownloadOrigin }>()
  // Bounded FIFO for prefetch-style enqueues. Without this, restoring
  // many tracks at once fires `ensureDownloaded` in a tight loop and
  // the native plugin's WorkManager (Android) / URLSession (iOS) drops
  // everything past the first transfer to "failed". The queue keeps
  // explicit-await callers (player auto-start) on their own fast path
  // — `prefetch` is the parallel-spam entry point and is the one we
  // serialize.
  const PREFETCH_CONCURRENCY = 1
  const prefetchQueue: Array<{ trackId: TrackId; path: string; sizeBytes: number }> = []
  const queuedTrackIds = new Set<TrackId>()
  /**
   * How many prefetch jobs are transferring right now. A slot belongs to one
   * job and is handed back when that job settles — see `pumpPrefetchQueue`.
   */
  let activeJobs = 0
  /** Guards the tail walk, which is async and must not overlap itself. */
  let settlingTail = false
  let hydrated = false
  // The "storage budget is full" notice carries a "Download anyway" button,
  // so it stays on screen long enough to be read AND acted on. There is no
  // time-based cooldown behind it: only one budget notice is ever on screen
  // (`budgetNoticeVisible`), which is what keeps a draining queue from
  // turning into a toast storm — while still answering every deliberate tap
  // the moment the previous notice is gone.
  const BUDGET_NOTICE_DURATION_MS = 20_000
  let budgetNoticeVisible = false
  // One-off permissions to overshoot the budget, granted ONLY by pressing
  // "Download anyway" on the notice above. Each entry is consumed by the
  // very next budget decision for that track and dropped again when the task
  // it was granted for settles, so it cannot widen into a general bypass:
  // nothing outside this store can add to the set, no exported action takes
  // an "ignore the budget" flag, and the configured limit is never written.
  const budgetExceptions = new Set<TrackId>()
  // Same rate-limit for the "couldn't download" notice, but for QUEUE-origin
  // failures only (see `noticeDownloadFailed`): in airplane mode a draining
  // queue fails every job in a row, and the user needs to be told once, not
  // once per lecture.
  let lastFailureNoticeAt = 0
  const FAILURE_NOTICE_COOLDOWN_MS = 60_000
  // Live `pending` claims: how many callers are waiting on this row, and the
  // state the first of them replaced. Kept out of `states` so releasing a
  // claim can restore the row instead of blanking it.
  const pendingClaims = new Map<TrackId, { count: number; previous: DownloadState | undefined }>()
  // Coalesce concurrent hydrate() calls (Home + Search + Settings all call it
  // defensively on mount) and back off after a failure, so a hard-failing DB
  // doesn't re-run failStaleDownloads() (a write) + listReady() on every screen
  // access — a tight retry-storm against an already-broken DB.
  let hydratePromise: Promise<void> | null = null
  let lastHydrateFailAt = 0
  const HYDRATE_RETRY_COOLDOWN_MS = 30_000
  /** How many demoted rows one launch will ask the disk about — see
   *  `reconcileStaleDownloads`. */
  const STALE_RECONCILE_LIMIT = 32
  // Bumped by reset() so an in-flight task started before the wipe
  // cannot write back into the freshly-emptied state maps. Every task
  // captures the epoch at start and gates its state writes on a match.
  let storeEpoch = 0

  function setState(trackId: TrackId, state: DownloadState): void {
    const next = new Map(states.value)
    next.set(trackId, state)
    states.value = next
    if (state !== "downloading") {
      const p = new Map(progress.value)
      if (p.delete(trackId)) progress.value = p
    }
  }

  /** Drop a track back to "idle": no state, no progress, no red X. */
  function clearDownloadState(trackId: TrackId): void {
    const nextStates = new Map(states.value)
    nextStates.delete(trackId)
    states.value = nextStates
    const nextProgress = new Map(progress.value)
    if (nextProgress.delete(trackId)) progress.value = nextProgress
  }

  function setProgress(trackId: TrackId, pct: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)))
    if (progress.value.get(trackId) === clamped) return
    const next = new Map(progress.value)
    next.set(trackId, clamped)
    progress.value = next
  }

  function getState(trackId: TrackId): DownloadState {
    return states.value.get(trackId) ?? "idle"
  }

  /**
   * Tell the user why a lecture stays grey / didn't save offline, and what
   * to do about it — free space by removing listened lectures, or raise the
   * limit in Settings.
   *
   * A budget notice belongs to an interaction — hence `downloadAnyway` is
   * required. The user tapped something and deserves to know why it did not
   * happen, plus a way past the limit for that one lecture. A background queue
   * hitting a wall it was always going to hit is not news: the rows already
   * show `deferred`, which is the honest, silent signal, and a toast about a
   * decision nobody made fired on every launch (#1578).
   *
   * At most one budget notice is on screen at a time — a second one would be
   * an unreadable stack, and the button on the first would no longer refer to
   * what the user is looking at.
   */
  function noticeBudgetFull(downloadAnyway: () => void): void {
    if (budgetNoticeVisible) return
    budgetNoticeVisible = true
    const message = t("errors.downloadStorageFull")
    void (async () => {
      try {
        const outcome = await toast.action(message, {
          color: "danger",
          durationMs: BUDGET_NOTICE_DURATION_MS,
          buttons: [{ text: t("errors.downloadStorageFullAction") }],
        })
        // Only a press grants the exception. An expired or swiped-away toast
        // leaves the track deferred — the limit holds by default.
        if (outcome.kind === "pressed") downloadAnyway()
      } finally {
        budgetNoticeVisible = false
      }
    })()
  }

  /**
   * Tell the user a download did not happen. Deliberately NOT fired for a
   * skipped-on-budget download: that one is intentional, the lecture still
   * plays from the stream, and `noticeBudgetFull` says the accurate thing.
   *
   * `origin` decides whether the rate-limit applies. A background queue
   * failing every job in airplane mode must be told once, but it must not
   * be able to swallow the answer to something the user just tapped — so
   * the cooldown suppresses queue notices only, and an explicit request is
   * always answered.
   */
  function noticeDownloadFailed(origin: DownloadOrigin): void {
    const now = Date.now()
    if (origin === "queue" && now - lastFailureNoticeAt < FAILURE_NOTICE_COOLDOWN_MS) return
    lastFailureNoticeAt = now
    void toast.error(t("errors.downloadFailed"))
  }

  /**
   * What a row really is underneath a `pending` claim: the state the claim
   * replaced, which `clearPending` will put back. Callers that must not
   * overwrite a terminal state have to read THIS, not the raw map — a
   * claimed row reads "pending" while still being a failed one.
   */
  function effectiveState(trackId: TrackId): DownloadState | undefined {
    const current = states.value.get(trackId)
    if (current !== "pending") return current
    return pendingClaims.get(trackId)?.previous
  }

  /** Paint a track as "waiting for space" without touching a terminal state. */
  function markDeferred(trackId: TrackId): void {
    const current = effectiveState(trackId)
    if (current === "completed" || current === "failed") return
    setState(trackId, "deferred")
  }

  /**
   * Synchronously acknowledge a tap before anything is known about it —
   * including a tap on a FAILED row, whose retry has just as far to travel
   * before it paints anything. The claim remembers what it replaced, so
   * releasing it restores that state rather than blanking the row.
   *
   * Not claimed over a finished download (it must not rewind to a shimmer)
   * or a live transfer (it keeps its progress radial). Claims nest: two
   * opens racing the same row each hold one, and the row stays claimed
   * until the last of them lets go.
   */
  function markPending(trackId: TrackId): void {
    const claim = pendingClaims.get(trackId)
    if (claim) {
      claim.count += 1
      return
    }
    const current = states.value.get(trackId)
    if (current === "completed" || current === "downloading" || current === "pending") return
    pendingClaims.set(trackId, { count: 1, previous: current })
    setState(trackId, "pending")
  }

  /**
   * Release a `pending` claim. The last one out restores whatever the claim
   * replaced — unless a real outcome has since been recorded, which wins.
   * Balanced against `markPending`, so it is safe to call unconditionally
   * from a `finally`: a claim that was never granted releases nothing.
   */
  function clearPending(trackId: TrackId): void {
    const claim = pendingClaims.get(trackId)
    if (!claim) return
    claim.count -= 1
    if (claim.count > 0) return
    pendingClaims.delete(trackId)
    // Restore only a row still showing OUR claim. Anything else — a real
    // outcome, or an entry a canceller DELETED from the map — wins. That
    // second case is load-bearing: cancelling a retry drops the row's state
    // entirely, and this guard is what stops the release putting the red X
    // back on a row the user just asked us to drop. A canceller must
    // therefore delete the entry, not write "idle" over it.
    if (states.value.get(trackId) !== "pending") return
    if (claim.previous === undefined) {
      const next = new Map(states.value)
      next.delete(trackId)
      states.value = next
      return
    }
    setState(trackId, claim.previous)
  }

  /**
   * `getState` for callers that must act on what a row IS, not on what it
   * is currently showing: while a `pending` claim is held the raw state
   * reads "pending", which would hide a `failed` row from the two retry
   * entry points (the Home tap and the sheet's primary button).
   */
  function getEffectiveState(trackId: TrackId): DownloadState {
    return effectiveState(trackId) ?? "idle"
  }

  function getProgress(trackId: TrackId): number {
    return progress.value.get(trackId) ?? 0
  }

  /**
   * Rebuild the reactive state map from the user DB. Called once on
   * first use; idempotent so Home / Search / Settings can all request
   * it defensively without re-hitting SQLite.
   */
  async function hydrate(): Promise<void> {
    if (hydrated) return
    if (hydratePromise) return hydratePromise
    // Back off after a recent failure instead of re-hammering a broken DB on
    // every screen that defensively calls hydrate().
    if (lastHydrateFailAt && Date.now() - lastHydrateFailAt < HYDRATE_RETRY_COOLDOWN_MS) return
    hydratePromise = (async () => {
      try {
        const repo = app.repositories().mediaItems
        // Recover rows the previous session left at "downloading" because
        // the app was force-closed or crashed mid-transfer. Without this
        // the Download button stays locked-out (downloadMedia rejects with
        // already-in-progress) until the user wipes data.
        const stale = await repo.failStaleDownloads()
        const ready = await repo.listReady()
        const next = new Map<TrackId, DownloadState>()
        for (const item of ready) next.set(item.trackId, "completed")
        states.value = next
        // Size what's already on disk before anything can be queued, so the
        // first budget decision of the session isn't made against a zero.
        await useDownloadQuotaStore().refresh()
        hydrated = true
        hydrationError.value = null
        lastHydrateFailAt = 0
        // Only now, with the ledger measured, can a reclaim credit the right
        // number back. Deliberately not awaited by hydrate's callers: a sweep
        // is housekeeping, not something a screen should wait on.
        void collectOrphans()
        // Same reasoning, and the same measured ledger: the demotion above is
        // a guess that the disk can overturn, and asking it is a series of
        // native round trips that a cold start must not sit behind.
        void reconcileStaleDownloads(stale.map((item) => item.trackId))
      } catch (err) {
        console.error("[downloads] hydrate failed:", err)
        hydrationError.value = err instanceof Error ? err.message : String(err)
        lastHydrateFailAt = Date.now()
        // Surface it wherever the user is — not just Home. The 30s back-off
        // above keeps this from repeating on every screen that hydrates.
        void toast.error(t("errors.downloadsCacheUnavailable"))
      } finally {
        hydratePromise = null
      }
    })()
    return hydratePromise
  }

  /**
   * Tracks the disk was asked about and did not have. Memoised because
   * `resolveLocalUrl` is a native round trip and the FIFO re-drains on every
   * eviction and every limit change — an un-memoised probe would cost one
   * bridge call per queued lecture per drain, which is what makes probing the
   * whole tail unaffordable. Everything that PUTS a file there goes through
   * this store and drops the entry.
   */
  const absentFromDisk = new Set<TrackId>()

  /**
   * Take ownership of audio the native cache is already holding: write the
   * `media_items` row and charge the budget, exactly as a finished transfer
   * does.
   *
   * A file can exist with nothing in the ledger pointing at it — sharing a
   * lecture downloads the full audio through the same adapter and the same key
   * as an offline save (#1739), and a row can be lost to a failed migration or
   * an interrupted write. Everything that rebuilds from `listReady()` is blind
   * to such a file: the offline badge disappears on the next launch, the
   * storage budget under-counts by its size, and `evict()` refuses to reclaim
   * it because the row it checks isn't there.
   *
   * Idempotent, and safe for a track that IS already tracked: the row is
   * rewritten with the same values and the budget keeps the charge it has.
   */
  async function adoptCachedFile(
    trackId: TrackId,
    localPath: string,
    filesize?: number | null
  ): Promise<void> {
    const epoch = storeEpoch
    absentFromDisk.delete(trackId)
    await app
      .repositories()
      .mediaItems.upsert(trackId, "ready", localPath)
      .catch((err: unknown) => {
        console.warn("[downloads] could not adopt a cached file:", err)
      })
    // A wipe landing while the row was being written owns the maps now.
    if (epoch !== storeEpoch) return
    const quota = useDownloadQuotaStore()
    quota.adopt(trackId, quota.sizeOf(filesize))
    setState(trackId, "completed")
  }

  /**
   * Ask the disk whether this lecture is already saved, and adopt it if so.
   *
   * The state machine is otherwise derived from `media_items` plus budget
   * arithmetic and never consults the disk, so a file present on disk but
   * absent from the table is reported as "not downloaded" and painted as
   * refused-for-space — while the player, which resolves the same file
   * independently, plays it offline (#1744).
   *
   * A `failed` row is left alone: the file its last attempt left behind may be
   * a CDN error page written to the lecture's own path (#1722), and adopting
   * that would make a corrupt download permanent. Those rows keep their red X
   * and their retry, which re-fetches rather than trusting what is there.
   */
  async function adoptIfOnDisk(
    trackId: TrackId,
    path: string,
    filesize?: number | null
  ): Promise<boolean> {
    if (absentFromDisk.has(trackId)) return false
    if (effectiveState(trackId) === "failed") return false
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
   * Ask the disk about the rows the previous session left mid-transfer, and
   * put back the ones whose bytes did arrive.
   *
   * `failStaleDownloads()` demotes them all — it has to, or the row keeps
   * `downloadMedia` refusing the next attempt with `already-in-progress` —
   * but it demotes blind. On iOS a transfer runs in a background
   * `URLSession` that goes on delivering while the app is suspended or
   * killed, so the file lands while the row still says "downloading"; the
   * launch that follows then blanks the row AND its `local_path`, and from
   * then on the lecture reads "not downloaded" while the player, which
   * resolves the file independently, plays it offline (#1744). Nothing ever
   * re-checked, because the state machine is derived from `media_items` and
   * budget arithmetic and never consults the disk.
   *
   * The key the native cache is addressed by is the audio's remote path, and
   * it is reachable from the track alone — one batched catalog read, then the
   * same `resolveLocalUrl` probe `ensureDownloaded` makes. Nothing new is
   * stored for this.
   *
   * VALIDITY IS PRESENCE, deliberately, and not a size comparison:
   *  - both native backends put a file at the destination only by an atomic
   *    move/rename after a 2xx response (iOS `didFinishDownloadingTo` with
   *    its status check, Android's temp file + `renameTo`), so neither a
   *    partial nor the CDN error page of #1722 can be sitting there;
   *  - `resolveLocalUrl` already requires both a live metadata entry and the
   *    file to exist;
   *  - no layer can read the size anyway — `IMediaDownloader` has no stat,
   *    and on web the "local path" is a `blob:` URL nothing can measure;
   *  - and the catalog's `filesize` is null for every personal-library
   *    import, so a size gate would refuse exactly the tracks whose only
   *    source of truth is the disk.
   * An adopted row is not final either: if the file turns out to be
   * unplayable — a bad one left at the path by a build older than that status
   * check, say — `ensureDownloaded`'s retry deletes the native entry and
   * re-fetches rather than trusting what is there.
   *
   * A row that has FAILED in this session is left alone — `adoptIfOnDisk`
   * holds that guard, the same one the queue's tail walk holds, so a bad file
   * a real attempt left behind is not promoted from here either.
   */
  async function reconcileStaleDownloads(trackIds: readonly TrackId[]): Promise<void> {
    // Bounded so a pathological table (a crash loop, a bad migration) cannot
    // turn a launch into an unbounded series of bridge calls. In practice the
    // set is what was in flight when the app closed — the prefetch queue runs
    // one at a time — so the cap is never reached; past it the rows simply
    // keep the demotion they have today.
    const pending = [...new Set(trackIds)].slice(0, STALE_RECONCILE_LIMIT)
    if (pending.length === 0) return
    const epoch = storeEpoch
    try {
      const tracks = await app.repositories().tracks.getByIds(pending)
      for (const trackId of pending) {
        if (epoch !== storeEpoch) return
        // A transfer started since hydrate owns this row; it will write its
        // own outcome, and it is already probing the same file.
        if (inFlight.has(trackId)) continue
        const track = tracks.get(trackId)
        const audio = track ? pickPlayableVariant(track)?.audio : null
        // Nothing to ask the disk ABOUT: the track left the catalog, or has
        // no audio at all. The row keeps the demotion.
        if (!audio) continue
        await adoptIfOnDisk(trackId, audio.path, audio.filesize)
      }
    } catch (err) {
      console.warn("[downloads] stale download reconciliation failed:", err)
    }
  }

  /**
   * Ensure the track's audio is cached locally. Returns the local URL
   * (blob: on web, file:// on native). Concurrent calls for the same
   * track share one in-flight download. Returns `null` on failure.
   *
   * Accepts the storage `path` (full bucket key) rather than a
   * pre-resolved URL so the use case can build a fresh URL per attempt
   * during runtime CDN fallback. Callers must NOT capture a URL once
   * and reuse it: the active CDN can be swapped between calls.
   *
   * On audio-success the transcript JSON for every advertised language
   * is also fetched in the background. The audio result isn't gated on
   * the transcript leg — opening a downloaded track for playback must
   * not wait on a 50KB JSON file behind a kilobyte-counter spinner.
   *
   * `filesize` is the catalog's byte size for the audio being fetched; it
   * funds the storage budget. Pass it whenever the caller already holds
   * the `TrackAudio` — omitting it makes the budget fall back to a corpus
   * average, which is a worse estimate but never a free pass.
   *
   * A cache hit is always served, but starting a NEW transfer requires
   * budget: over the limit this returns `null` (playback then streams
   * from the CDN instead) and tells the user why. The notice carries a
   * "Download anyway" button, which starts a SEPARATE call for that track
   * holding a single-use exception — this call still returns `null` right
   * away rather than staying open for the length of a toast.
   *
   * Every OTHER `null` — offline, all CDN candidates exhausted, an
   * unexpected throw — is a real failure and says so. The budget case is
   * excluded on purpose: the skip is deliberate and the lecture still
   * plays, so a connectivity message there would be misinformation.
   *
   * `origin` defaults to `"user"`: everything except the prefetch FIFO is
   * someone waiting on a tap.
   */
  async function ensureDownloaded(
    trackId: TrackId,
    path: string,
    filesize?: number | null,
    origin: DownloadOrigin = "user"
  ): Promise<string | null> {
    const existing = inFlight.get(trackId)
    if (existing) {
      // Joining a transfer the prefetch queue already started. The user is
      // now waiting on it too, so promote it out of the queue's rate-limit —
      // otherwise "add a playlist, then tap one of its lectures" is exactly
      // the case whose failure notice gets swallowed as background noise.
      // Only ever upwards: a queue job joining a user's transfer changes
      // nothing.
      if (origin === "user") {
        const claimed = inFlightOrigins.get(trackId)
        if (claimed) claimed.current = "user"
      }
      return existing
    }

    // A "failed" in-memory state means the previous attempt did NOT
    // produce a usable file. The iOS plugin's `resolveLocalUrl` can
    // still return a phantom localUrl in this case (its UserDefaults
    // entry is written at download-start and not cleaned up on
    // failure), which would flip the row to "completed" with zero
    // network bytes. So treat the cache as empty AND proactively
    // delete the native-side mapping for this URL before re-trying.
    //
    // Read through any `pending` claim an outer caller (`openTrack`) already
    // placed on the row: the raw state would read "pending" and quietly skip
    // the whole retry path.
    const isRetryAfterFailure = effectiveState(trackId) === "failed"

    // Answer the tap NOW — before the first await. Everything below (the
    // native cache probe, an unmeasured `ensureMeasured`'s SQLite round
    // trip, the transfer itself) can take anything from a frame to minutes,
    // and without this claim the row sits motionless the whole time. That
    // includes a retry, which paints over its own red X: `isRetryAfterFailure`
    // is captured above, off the state this claim replaces.
    markPending(trackId)

    // Boxed so a later caller joining this task can upgrade it; the notice
    // below reads it at failure time, not at call time.
    const claimedOrigin = { current: origin }
    inFlightOrigins.set(trackId, claimedOrigin)

    const taskEpoch = storeEpoch
    // Set when the stall watch gives up on this attempt. Nothing can force a
    // native promise to settle, so an abandoned attempt may still be running:
    // it is barred from writing state as though it were still the live one.
    let abandoned = false
    /** Still the generation this task started in (a wipe bumps it). */
    const live = (): boolean => taskEpoch === storeEpoch
    const fresh = (): boolean => live() && !abandoned
    // Created before the first await so a cancel arriving at any point in the
    // pre-transfer phase has something to abort.
    const aborter = new AbortController()
    inFlightAborts.set(trackId, aborter)
    const cancelled = (): boolean => aborter.signal.aborted
    // Bounds the attempt. Armed for the whole task, not just the transfer:
    // the probe and the native delete are platform calls too.
    const stall = startStallWatch()

    /**
     * The stall watch gave up. The attempt is abandoned rather than awaited —
     * that is the whole point, since waiting is what froze the queue — so the
     * abort stops it at its next checkpoint and the native transfer is
     * cancelled, and `abandoned` keeps it from painting over the failure if it
     * settles after all.
     */
    function abandonStalled(): null {
      if (fresh()) {
        setState(trackId, "failed")
        noticeDownloadFailed(claimedOrigin.current)
      }
      abandoned = true
      aborter.abort()
      const url = inFlightUrls.get(trackId)
      if (url) void app.mediaDownloader.cancel(url).catch(() => {})
      // The DB row goes with the state: one left at "downloading" makes
      // `downloadMedia` refuse the next attempt with "already-in-progress"
      // until a relaunch runs `failStaleDownloads()`.
      void app
        .repositories()
        .mediaItems.upsert(trackId, "failed", null)
        .catch(() => {})
      return null
    }
    // Token used so the task's finally only clears the inFlight slot
    // if it is still the one we put there — reset() may have wiped
    // and a newer task may already own this trackId.
    const ownership: { current: Promise<string | null> | null } = { current: null }
    const quota = useDownloadQuotaStore()

    const task = (async (): Promise<string | null> => {
      try {
        // The probe URL names the active server, but the lookup underneath
        // is addressed by the file's own key — so a file downloaded before a
        // CDN swap is still found. That used to be an assumption stated in
        // this comment and contradicted by the native stores, which compared
        // the whole URL; it is now the plugin contract.
        const probeUrl = buildServerUrl(app.activeServer.value, path)
        // Record the url so a concurrent remove/archive/reset can cancel the
        // native transfer (keyed by url → pathname id, host-independent).
        inFlightUrls.set(trackId, probeUrl)
        // Ask the disk FIRST, on every path including a retry. Two different
        // questions hang off this one probe and the code used to conflate
        // them:
        //
        //   "is there a file?"        — what the storage budget needs to know.
        //   "is that file any good?"  — what a retry needs to know.
        //
        // A retry answers the second with "assume not" and re-fetches (see the
        // eviction below): a failed attempt can leave a BAD file behind, and
        // on iOS that is a CDN error page written to the lecture's own path
        // (#1722). That is why the cache-hit shortcut stays gated on
        // `!isRetryAfterFailure`. But it is not a reason to withhold the FIRST
        // answer from the budget, and withholding it is what produced the
        // reported "storage is full" popup over a lecture that was on disk and
        // playing: a background URLSession finishes while the app is suspended,
        // the next launch's unconditional `failStaleDownloads()` blanks the
        // still-"downloading" row to `failed`, and from then on every tap took
        // the retry path straight past the probe into the budget gate (#1744).
        const cached = await Promise.race([
          app.mediaDownloader.resolveLocalUrl(probeUrl),
          stall.expired,
        ])
        if (cached === STALLED) return abandonStalled()
        if (cancelled()) return null
        // Keep the memoised answer honest for the queue's tail walk.
        if (cached) absentFromDisk.delete(trackId)
        else absentFromDisk.add(trackId)
        if (!isRetryAfterFailure) {
          if (cached) {
            // The file is on disk — but nothing may own it. Sharing a lecture
            // downloads the full audio through the same adapter and the same
            // key, so this branch is reached with no `media_items` row and
            // nothing charged to the budget (#1739). Left that way the badge
            // disappears on the next launch (`hydrate()` rebuilds from
            // `listReady()`), `usedBytes` under-counts by everything the user
            // has shared, and `evict()` refuses to reclaim the file — it
            // survives until uninstall. Adopt it instead: the same bookkeeping
            // a finished transfer does.
            await adoptCachedFile(trackId, cached, filesize)
            if (fresh()) setState(trackId, "completed")
            // Even when audio is already on disk, make sure transcripts
            // are too — the user might have saved offline before the
            // transcript-prefetch feature shipped, so this self-heals.
            if (fresh()) void transcriptPrefetch.prefetchForTrack(trackId)
            return cached
          }
          // The native cache says the file is NOT there, so a DB row still
          // claiming "ready" is stale and is repaired here — before any gate
          // below can decide not to download. Leaving it would keep the row
          // in `listReady()`: a phantom "downloaded" badge on Home, and its
          // bytes still charged to `usedBytes` by `quota.refresh()`, which
          // makes the budget refuse the next track that little bit sooner.
          await app
            .repositories()
            .mediaItems.upsert(trackId, "failed", null)
            .catch(() => {})
          // The bytes go with the row. Whatever the last measurement charged
          // this track is not on disk — the probe just said so — and leaving
          // it charged makes the gate below refuse a re-download the budget
          // has room for.
          quota.uncharge(trackId)
        }
        // Offline guard: a transfer kicked off with no connectivity (airplane
        // mode) otherwise enqueues a native job that waits indefinitely for the
        // network — the row sticks on "downloading" forever and never surfaces
        // a failure, so no red X and no retry affordance ever appears. Fail
        // fast instead so the failed state (and the sheet's "Download again"
        // button) show up immediately.
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          if (fresh()) {
            setState(trackId, "failed")
            noticeDownloadFailed(claimedOrigin.current)
          }
          return null
        }
        // Budget gate. Everything above this line either served a cache hit
        // or cost nothing; from here on we'd be writing megabytes to disk,
        // so the user's storage limit gets a say. `hasRoomFor` counts
        // in-flight reservations too, so a draining queue can't overshoot
        // the cap in the window before `usedBytes` catches up — except this
        // track's own, which the drain may already have reserved for us.
        //
        // It runs BEFORE the "downloading" paint: a track the budget refuses
        // must never flash a spinner it isn't going to earn. (The stale-row
        // repair above is deliberately NOT behind it — that one is a fix for
        // the DB, owed whether or not this transfer happens.)
        await quota.ensureMeasured()
        // Last gate before bytes start moving: an archive or remove that
        // landed while the budget was being measured must not be overtaken.
        if (cancelled()) return null
        const sizeBytes = quota.sizeOf(filesize)
        // A "Download anyway" press grants this track exactly one pass, and
        // this is where it is spent — deleted whether or not the budget would
        // have refused, so the grant can never outlive the decision it was
        // made for. The limit itself is untouched: the next track is measured
        // against it as before, now with these bytes counted in.
        const exempt = budgetExceptions.delete(trackId)
        // The bytes are already on disk and the re-fetch overwrites them in
        // place, so this transfer asks the device for no new space — refusing
        // it on storage grounds would be arithmetic about a file the disk
        // already holds. Reachable only on the retry path (any other route
        // served the cache hit above and never got here).
        //
        // A phantom iOS entry — written at download-start and not cleaned up
        // on failure — can answer "yes" for a file that isn't there, so this
        // can wave through one lecture the cap would have refused. That is the
        // cheaper mistake: the alternative is telling a user their storage is
        // full while the lecture in question plays offline. The eviction below
        // clears the phantom, and the settled transfer charges the budget
        // honestly either way.
        const onDiskAlready = cached !== null
        if (!exempt && !onDiskAlready && !quota.hasRoomFor(sizeBytes, trackId)) {
          if (fresh()) {
            markDeferred(trackId)
            // Only a request the user is waiting on gets a notice, and it
            // always carries the way past. The queue's own refusals are told
            // by the row's `deferred` state and nothing else.
            //
            // And only when the budget is actually known to be full: an
            // unmeasured budget refuses too, and "storage is full" would be
            // a guess about a device we failed to measure.
            if (claimedOrigin.current === "user" && quota.isMeasured) {
              noticeBudgetFull(() => {
                budgetExceptions.add(trackId)
                void ensureDownloaded(trackId, path, filesize, "user")
              })
            }
          }
          return null
        }
        quota.reserve(trackId, sizeBytes)
        if (fresh()) {
          setProgress(trackId, 0)
          setState(trackId, "downloading")
        }
        if (isRetryAfterFailure) {
          // Best-effort: evict stale native cache before re-downloading.
          // iOS keeps a phantom UserDefaults entry for the URL after a
          // failed download; without this delete, a follow-up probe
          // would hand back a localUrl pointing at nothing.
          await app.mediaDownloader.delete(probeUrl).catch(() => {})
          absentFromDisk.add(trackId)
          // Demote any stale "ready" DB row before invoking `downloadMedia`.
          // The use case's cached branch trusts the DB (`state === "ready" &&
          // localPath`) without verifying the file is still on disk — so a row
          // left "ready" from a prior session whose file the OS later evicted
          // (iOS /Caches sweep, user-initiated clear) would short-circuit the
          // retry and return success WITHOUT moving any bytes. The user sees
          // the row flip off-failed but no download happens.
          await app
            .repositories()
            .mediaItems.upsert(trackId, "failed", null)
            .catch(() => {})
          // Same as the probe-miss demotion above: the row is no longer
          // ready, so it holds no budget. The reservation made just above
          // is untouched — it funds the bytes now on their way in.
          quota.uncharge(trackId)
        }
        const result = await Promise.race([
          downloadMedia(
            { trackId, path, candidates: fallback.candidates() },
            {
              mediaItems: app.repositories().mediaItems,
              unitOfWork: app.repositories().unitOfWork,
              transfer: (url, onProgress, signal) =>
                app.mediaDownloader.download(
                  url,
                  (received, total) => {
                    // Raw bytes, not the rounded percentage below: a server
                    // that omits Content-Length reports no percentage at all,
                    // and a transfer that IS delivering must never look stalled.
                    stall.touch()
                    onProgress?.(received, total)
                  },
                  signal
                ),
            },
            (pct) => {
              if (fresh()) setProgress(trackId, pct)
            }
          ),
          stall.expired,
        ])
        if (result === STALLED) return abandonStalled()
        if (result.ok) {
          // Bytes are on disk — turn the reservation into real usage.
          quota.settle(trackId, true)
          absentFromDisk.delete(trackId)
          if (fresh()) setState(trackId, "completed")
          // Promote the working CDN if it differs from the active
          // server when the download started. The activeServer watcher
          // in initLectorium persists the new preference so the next
          // session also starts from this CDN; the transcript prefetch
          // (kicked off below) sees the updated active server because
          // we set it synchronously here.
          if (fresh() && app.activeServer.value.id !== result.value.server.id) {
            app.setActiveServer(result.value.server)
          }
          if (fresh()) void transcriptPrefetch.prefetchForTrack(trackId)
          return result.value.mediaItem.localPath
        }
        // A cancelled transfer is a user decision (remove / archive / data
        // wipe), not a fault: painting "failed" would leave a red retry
        // affordance on a row the user just asked us to drop. Fall back to
        // "idle" so a later tap can start over.
        if (result.error === "cancelled") {
          if (fresh()) clearDownloadState(trackId)
          return null
        }
        if (fresh()) {
          setState(trackId, "failed")
          noticeDownloadFailed(claimedOrigin.current)
        }
        return null
      } catch (err) {
        console.error(`[downloads] failed for ${trackId}:`, err)
        if (fresh()) {
          setState(trackId, "failed")
          noticeDownloadFailed(claimedOrigin.current)
        }
        return null
      } finally {
        stall.stop()
        // Drop a grant this task never reached the gate to spend (a cache
        // hit, the offline guard, a throw). Together with the delete AT the
        // gate this bounds a "Download anyway" press to the single call it
        // started: it is never left lying around for a later download.
        budgetExceptions.delete(trackId)
        // Release any reservation this task still holds — a cache hit, an
        // early return, or a throw all land here. No-op once the success
        // branch has already promoted it into `usedBytes`.
        quota.settle(trackId, false)
        // Same for the synchronous claim: a throw before any outcome was
        // recorded must not leave the row shimmering forever. Epoch-gated
        // like the writes above — after a reset() our claim is already gone
        // and the trackId may carry a NEW one, which is not ours to release.
        // Deliberately NOT gated on `abandoned`: an attempt the stall watch
        // gave up on still holds the claim it made, and only this releases it.
        if (live()) clearPending(trackId)
        // Only delete our own slot. After a reset() the map was
        // cleared and a newer task may already own this trackId.
        if (inFlight.get(trackId) === ownership.current) {
          inFlight.delete(trackId)
          inFlightUrls.delete(trackId)
          inFlightOrigins.delete(trackId)
        }
        if (inFlightAborts.get(trackId) === aborter) inFlightAborts.delete(trackId)
      }
    })()

    ownership.current = task
    inFlight.set(trackId, task)
    return task
  }

  /**
   * Walk the FIFO, stopping at the first job the storage budget can't
   * fund. Deferred jobs STAY in the queue in order — `resumeDeferred()`
   * simply drains again once an eviction frees room, so a 100-track
   * playlist downloads as far as the budget allows and then continues on
   * its own as the user finishes and clears lectures.
   */
  async function drainPrefetchQueue(): Promise<void> {
    // Never budget against an unmeasured zero — on a cold start that would let
    // the whole queue through before the first refresh lands. Concurrent
    // callers share the one measurement (`ensureMeasured` coalesces), so this
    // needs no guard of its own.
    await useDownloadQuotaStore().ensureMeasured()
    pumpPrefetchQueue()
  }

  /**
   * Admit jobs from the head of the FIFO up to `PREFETCH_CONCURRENCY`, and
   * stop at the first one the budget can't fund.
   *
   * A slot is owned by ONE job and handed back when THAT job settles. The
   * previous shape — a single `queueDraining` boolean held across a `while`
   * loop that awaited each job inside it — meant a transfer that never settled
   * kept the flag raised for the rest of the process: every later `prefetch()`
   * and `resumeDeferred()` returned at the guard, and auto-download silently
   * stopped working with no error and no state change on any row (#1730).
   * Nothing here is held across an await.
   */
  function pumpPrefetchQueue(): void {
    const quota = useDownloadQuotaStore()
    while (activeJobs < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
      const head = prefetchQueue[0]!
      if (!quota.hasRoomFor(head.sizeBytes)) {
        if (!settlingTail) void settleUnfundedTail()
        return
      }
      // Reserve up front so a multi-job batch is measured against the
      // budget as a whole, not job-by-job against a stale total.
      quota.reserve(head.trackId, head.sizeBytes)
      prefetchQueue.shift()
      queuedTrackIds.delete(head.trackId)
      activeJobs += 1
      void runPrefetchJob(head)
    }
  }

  async function runPrefetchJob(job: {
    trackId: TrackId
    path: string
    sizeBytes: number
  }): Promise<void> {
    markStartingDownload(job.trackId)
    try {
      await ensureDownloaded(job.trackId, job.path, job.sizeBytes, "queue")
    } catch {
      // ensureDownloaded already records "failed"; don't break the queue.
    } finally {
      activeJobs -= 1
      pumpPrefetchQueue()
    }
  }

  /**
   * The budget is spent. Before painting the waiting tail as "held back for
   * space", ask the disk about each of them once: a lecture whose audio is
   * already saved is downloaded no matter what `media_items` says, and the
   * budget arithmetic that refused it never looked (#1744). Whatever the disk
   * does have is adopted into the ledger and leaves the queue.
   *
   * The rest are painted and nothing is said: nobody is waiting on a
   * particular one of these, the rows now carry the state themselves, and a
   * notice here fired on every launch of a library already at the cap (#1578).
   */
  async function settleUnfundedTail(): Promise<void> {
    settlingTail = true
    try {
      let adopted = false
      for (const job of [...prefetchQueue]) {
        if (await adoptIfOnDisk(job.trackId, job.path, job.sizeBytes)) {
          dropFromQueue(job.trackId)
          adopted = true
          continue
        }
        markDeferred(job.trackId)
      }
      // Adopting shortens the queue, so the head may have changed — and it
      // charges the budget, so re-running the gate is also what keeps the
      // adopted bytes counted before the next job is measured.
      if (adopted) pumpPrefetchQueue()
    } finally {
      settlingTail = false
    }
  }

  function dropFromQueue(trackId: TrackId): void {
    const idx = prefetchQueue.findIndex((j) => j.trackId === trackId)
    if (idx >= 0) prefetchQueue.splice(idx, 1)
    queuedTrackIds.delete(trackId)
  }

  /**
   * Re-drain the FIFO after something freed storage (an archived lecture
   * evicted, the limit raised). No-op when nothing is waiting.
   */
  function resumeDeferred(): void {
    if (prefetchQueue.length === 0) return
    void drainPrefetchQueue()
  }

  /**
   * Fire-and-forget enqueue for "add to playlist" / data-restore flows.
   * Replaces a previous unbounded parallel dispatch that caused every
   * download past the first to fail when the native plugin's transfer
   * limit was exceeded (issue #474). Skips tracks already in flight or
   * already queued — same-track double-tap is a no-op.
   *
   * Marks the row as `downloading` immediately on enqueue (unless it
   * was already `failed` — leave that state intact so `ensureDownloaded`
   * still picks the retry path) so the dim treatment doesn't flicker
   * between `idle` and `downloading` while the FIFO is draining. Over
   * budget it enqueues as `deferred` instead: no spinner for a transfer
   * that isn't going to start.
   */
  function prefetch(trackId: TrackId, path: string, filesize?: number | null): void {
    if (queuedTrackIds.has(trackId)) return
    if (inFlight.has(trackId)) return
    const current = effectiveState(trackId)
    if (current === "completed") return
    const quota = useDownloadQuotaStore()
    const sizeBytes = quota.sizeOf(filesize)
    queuedTrackIds.add(trackId)
    prefetchQueue.push({ trackId, path, sizeBytes })
    if (current !== "failed") {
      if (quota.hasRoomFor(sizeBytes)) markStartingDownload(trackId)
      else markDeferred(trackId)
    }
    void drainPrefetchQueue()
  }

  /**
   * Synchronously claim "downloading" state for a track. Used by add-to-
   * playlist so the row paints directly as `downloading` instead of
   * flashing the "added" checkmark while `prefetch` resolves the audio
   * path and `ensureDownloaded` probes the cache. A subsequent
   * `ensureDownloaded` call will either confirm the state, find the file
   * already cached and flip to "completed", or report "failed". The
   * already-cached branch is skipped here so re-adding a downloaded
   * track doesn't visually rewind to "downloading".
   */
  function markStartingDownload(trackId: TrackId): void {
    const current = effectiveState(trackId)
    // Preserve a terminal state. "completed" must not visually rewind to
    // "downloading" on re-add; "failed" must survive so a follow-up
    // `ensureDownloaded` takes the retry path (which runs the iOS
    // phantom-cache cleanup gated on `state === "failed"`). Overwriting
    // "failed" here would suppress that cleanup for re-add-after-failure.
    if (current === "completed" || current === "failed") return
    setProgress(trackId, 0)
    setState(trackId, "downloading")
  }

  /**
   * Roll back an optimistic "downloading" paint that will never resolve.
   * Used when `add()` claimed "downloading" up front but the track turns
   * out to have no audio variant to fetch — nothing will ever call
   * `ensureDownloaded`, so the spinner would otherwise stick forever.
   * Only clears a state we ourselves set optimistically; a real in-flight
   * download (or any terminal state) is left untouched.
   */
  function clearStartingDownload(trackId: TrackId): void {
    if (inFlight.has(trackId)) return
    if (states.value.get(trackId) !== "downloading") return
    clearDownloadState(trackId)
  }

  /**
   * Abort an in-flight native transfer for a track, if any. Best-effort:
   * the web backend may not implement cancel, and a transfer that already
   * finished is a no-op. Drops the tracked url so a later settle doesn't
   * re-cancel.
   */
  function cancelInFlight(trackId: TrackId): void {
    // Abort first and unconditionally: the task may not have reached the
    // native call yet, in which case there is no url to cancel and this is
    // the only thing that stops it.
    inFlightAborts.get(trackId)?.abort()
    const url = inFlightUrls.get(trackId)
    if (!url) return
    inFlightUrls.delete(trackId)
    void app.mediaDownloader.cancel(url).catch(() => {})
  }

  async function remove(trackId: TrackId, remoteUrl: string): Promise<void> {
    // Stop any in-flight transfer first, else the running worker can finish
    // and re-create the file right after we delete it (orphan on disk with no
    // DB row). Falls back to the remoteUrl id when the track has no tracked
    // in-flight url (already finished / not ours).
    cancelInFlight(trackId)
    await app.mediaDownloader.cancel(remoteUrl).catch(() => {})
    const repos = app.repositories()
    await removeDownloadedMedia(
      { trackId, remoteUrl },
      {
        mediaItems: repos.mediaItems,
        deleteLocal: (url) => app.mediaDownloader.delete(url),
      }
    )
    // Drop transcript JSON files alongside the audio. We resolve the
    // bucket path from the content DB, build the same URL the HTTP
    // transcript repo uses (`storagePublicUrl.get(path)`), and ask the
    // shared `IRemoteFilesStorage` to evict it. Failures are tolerated
    // per-language inside the use case — orphan cache entries are
    // harmless and a Settings → Clear cache sweep will reclaim them.
    await removeDownloadedTranscripts(
      { trackId },
      {
        transcripts: repos.transcripts,
        deleteLocal: async (id, language) => {
          const path = await repos.tracks.getTranscriptPath(id, language)
          if (!path) return
          const url = app.storagePublicUrl.get(path)
          await app.filesStorage.delete(url)
        },
      }
    )
    // The file is provably gone, so the memoised disk answer is too.
    absentFromDisk.add(trackId)
    clearDownloadState(trackId)
  }

  /**
   * Free the disk a track's cached audio holds and hand its share of the
   * budget back, then let the waiting queue continue. Resolves the remote
   * URL itself so callers (archive, auto-archive sweep) only need a
   * track id.
   *
   * A no-op unless the track is actually cached — archiving a lecture
   * that was never downloaded must not credit the budget for bytes that
   * were never spent. Returns whether anything was evicted.
   */
  async function evict(trackId: TrackId): Promise<boolean> {
    if (states.value.get(trackId) !== "completed") return false
    const repos = app.repositories()
    const track = await repos.tracks.getById(trackId)
    const audio = track?.variants.find((v) => v.audio)?.audio
    if (!audio) return false
    // The downloader keys deleted files by URL pathname, so the currently
    // active CDN resolves the same local file even if the bytes arrived
    // from a different one.
    await remove(trackId, buildServerUrl(app.activeServer.value, audio.path))
    // The credit is the ledger's, not this variant's `filesize`. That read
    // was a third source of truth — the FIRST language's audio, where the
    // measurement charges the LARGEST — and every disagreement between the
    // two left budget stranded for the rest of the session.
    useDownloadQuotaStore().forget(trackId)
    resumeDeferred()
    return true
  }

  /**
   * Record that a track's cached audio is owed an eviction the app could not
   * perform yet, because the native engine could still reach the file. The
   * player holds the same debt in memory for this session; this is the copy
   * that survives the process.
   */
  async function markEvictPending(trackId: TrackId): Promise<void> {
    await app
      .repositories()
      .mediaItems.markEvictPending(trackId)
      .catch((err: unknown) => {
        console.warn("[downloads] could not record pending eviction:", err)
      })
  }

  /**
   * Reclaim the audio of lectures that were archived while the engine held
   * them and never got their eviction — the app was killed before the queue
   * let go. Their `media_items` row is still "ready", so `usedBytes` keeps
   * charging the user for a file no playlist row points at, and the budget
   * refuses new downloads for space nothing is using (issue #1666).
   *
   * Skipped while the engine has a queue loaded: a queue restored from a
   * previous session still holds `file://` URLs, and deleting one out from
   * under it is exactly the failure this defers to the player, which can see
   * the queue and reclaims on its own (`flushPendingEvictions`). The debt is
   * durable, so a skipped sweep is postponed, not lost.
   *
   * Reconciling the other direction — files on disk with no row at all — is
   * not attempted here.
   */
  async function collectOrphans(): Promise<void> {
    try {
      const owed = await app.repositories().mediaItems.listEvictPending()
      if (owed.length === 0) return
      const queue = await app.audioPlayer.getQueueState().catch(() => null)
      if (queue?.currentItemId) return
      for (const item of new Set(owed.map((i) => i.trackId))) await evict(item)
    } catch (err) {
      console.warn("[downloads] orphan collection failed:", err)
    }
  }

  /**
   * Drop a track from the prefetch FIFO before its turn starts. Called
   * by `playlist.archive` so archiving a track that the auto-download
   * loop (or "add to playlist") has just queued does not waste bandwidth
   * cabling a file the user no longer wants offline. If the track is
   * already mid-flight there is no AbortSignal yet — the download
   * resolves naturally and lands in the (now archived) cache; that's
   * acceptable for the rare race.
   */
  function cancelPrefetch(trackId: TrackId): void {
    // Already transferring: abort the native transfer so archiving a track
    // mid-download actually stops the bandwidth + leaves no orphan partial.
    // (The JS task then settles as "cancelled" and the row drops back to
    // idle — no red X on a track the user chose to archive.)
    if (inFlight.has(trackId)) {
      cancelInFlight(trackId)
      return
    }
    if (!queuedTrackIds.has(trackId)) return
    dropFromQueue(trackId)
    // Roll back the optimistic paint applied at enqueue time — "downloading"
    // when the budget had room, "deferred" when it didn't — but only if the
    // track hasn't started transferring yet.
    const painted = states.value.get(trackId)
    if (!inFlight.has(trackId) && (painted === "downloading" || painted === "deferred")) {
      clearDownloadState(trackId)
    }
  }

  /**
   * Wipe in-memory download state and force a re-hydrate on next access.
   * Used by the "Clear user data" flow in Settings — after the user DB
   * has been emptied, the cached `Map<TrackId, "completed">` would still
   * paint Home/Search rows as offline-ready until the next launch.
   */
  function reset(): void {
    // Bump the epoch so any still-running download task started before
    // this call cannot write into the freshly-emptied maps when it
    // resolves later: the task still resolves but its setState/setProgress
    // calls become no-ops.
    storeEpoch += 1
    // Abort in-flight transfers so a wipe/clear-cache doesn't leave workers
    // running that re-create files into the just-emptied cache — natively for
    // the ones that got that far, and by signal for the ones that did not.
    for (const aborter of inFlightAborts.values()) aborter.abort()
    inFlightAborts.clear()
    for (const url of inFlightUrls.values()) {
      void app.mediaDownloader.cancel(url).catch(() => {})
    }
    inFlightUrls.clear()
    inFlightOrigins.clear()
    pendingClaims.clear()
    budgetExceptions.clear()
    states.value = new Map()
    progress.value = new Map()
    hydrationError.value = null
    inFlight.clear()
    prefetchQueue.length = 0
    queuedTrackIds.clear()
    absentFromDisk.clear()
    useDownloadQuotaStore().reset()
    hydrated = false
    lastHydrateFailAt = 0
  }

  // Raising the limit must let the waiting tail through without requiring
  // the user to re-add anything; lowering it just means the next job
  // doesn't fit, which the drain loop discovers on its own.
  //
  // A budget that only just became measurable is the same event: everything
  // enqueued before it was refused for want of a number, not for want of
  // room, and the queue would otherwise sit deferred until an eviction.
  watch([() => useDownloadQuotaStore().limitBytes, () => useDownloadQuotaStore().isMeasured], () =>
    resumeDeferred()
  )

  return {
    states,
    progress,
    hydrationError,
    getState,
    getEffectiveState,
    getProgress,
    hydrate,
    ensureDownloaded,
    adoptCachedFile,
    prefetch,
    resumeDeferred,
    cancelPrefetch,
    markPending,
    clearPending,
    markStartingDownload,
    clearStartingDownload,
    remove,
    evict,
    markEvictPending,
    collectOrphans,
    reset,
  }
})
