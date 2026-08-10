import { defineStore } from "pinia"
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useToast } from "@kit/composables"
import { downloadMedia } from "@usecases/downloads/downloadMedia.js"
import { removeDownloadedMedia } from "@usecases/downloads/removeDownloadedMedia.js"
import { removeDownloadedTranscripts } from "@usecases/downloads/removeDownloadedTranscripts.js"
import type { TrackId } from "@lib/domain/core.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { useShruti } from "@shruti/shruti.js"
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
  const app = useShruti()
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
  let queueDraining = false
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
        await repo.failStaleDownloads()
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
    const fresh = (): boolean => taskEpoch === storeEpoch
    // Created before the first await so a cancel arriving at any point in the
    // pre-transfer phase has something to abort.
    const aborter = new AbortController()
    inFlightAborts.set(trackId, aborter)
    const cancelled = (): boolean => aborter.signal.aborted
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
        if (!isRetryAfterFailure) {
          const cached = await app.mediaDownloader.resolveLocalUrl(probeUrl)
          if (cancelled()) return null
          if (cached) {
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
        if (!exempt && !quota.hasRoomFor(sizeBytes, trackId)) {
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
        const result = await downloadMedia(
          { trackId, path, candidates: fallback.candidates() },
          {
            mediaItems: app.repositories().mediaItems,
            unitOfWork: app.repositories().unitOfWork,
            transfer: (url, onProgress, signal) =>
              app.mediaDownloader.download(
                url,
                (received, total) => {
                  onProgress?.(received, total)
                },
                signal
              ),
          },
          (pct) => {
            if (fresh()) setProgress(trackId, pct)
          }
        )
        if (result.ok) {
          // Bytes are on disk — turn the reservation into real usage.
          quota.settle(trackId, true)
          if (fresh()) setState(trackId, "completed")
          // Promote the working CDN if it differs from the active
          // server when the download started. The activeServer watcher
          // in initShruti persists the new preference so the next
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
        if (fresh()) clearPending(trackId)
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
    if (queueDraining) return
    queueDraining = true
    try {
      const quota = useDownloadQuotaStore()
      // Never budget against an unmeasured zero — on a cold start that
      // would let the whole queue through before the first refresh lands.
      await quota.ensureMeasured()
      while (prefetchQueue.length > 0) {
        const batch: Array<{ trackId: TrackId; path: string; sizeBytes: number }> = []
        while (batch.length < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
          const head = prefetchQueue[0]!
          if (!quota.hasRoomFor(head.sizeBytes)) break
          // Reserve up front so a multi-job batch is measured against the
          // budget as a whole, not job-by-job against a stale total.
          quota.reserve(head.trackId, head.sizeBytes)
          prefetchQueue.shift()
          batch.push(head)
        }
        if (batch.length === 0) {
          // Budget spent. Paint the whole waiting tail as deferred and say
          // nothing: nobody is waiting on a particular one of these, the rows
          // now carry the state themselves, and a notice here fired on every
          // launch of a library already at the cap (#1578).
          for (const job of prefetchQueue) markDeferred(job.trackId)
          return
        }
        await Promise.allSettled(
          batch.map(async (job) => {
            queuedTrackIds.delete(job.trackId)
            markStartingDownload(job.trackId)
            try {
              await ensureDownloaded(job.trackId, job.path, job.sizeBytes, "queue")
            } catch {
              // ensureDownloaded already records "failed"; don't break the queue.
            }
          })
        )
      }
    } finally {
      queueDraining = false
    }
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
    const idx = prefetchQueue.findIndex((j) => j.trackId === trackId)
    if (idx >= 0) prefetchQueue.splice(idx, 1)
    queuedTrackIds.delete(trackId)
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
    prefetch,
    resumeDeferred,
    cancelPrefetch,
    markPending,
    clearPending,
    markStartingDownload,
    clearStartingDownload,
    remove,
    evict,
    reset,
  }
})
