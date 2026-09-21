import { defineStore } from "pinia"
import { ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { createIngestPollWatchlist } from "@shruti/stores/library/ingestPollWatchlist.js"
import { requestSync } from "@shruti/services/syncEvents.js"
import type { LibraryItemStatus } from "@lib/domain/libraryItem.js"
import type { TrackId } from "@lib/domain/core.js"
import type { IngestState, IngestStatusResponse } from "@lib/contracts"

/**
 * The single owner of the live ingest poll.
 *
 * While an item is being ingested this polls the orchestrator for each pending
 * library item and patches its status into the library store, so the card flips
 * queued → processing → ready without waiting out the sync cadence. On a
 * terminal transition it fires `requestSync` once to pull the authoritative row
 * (audio keys, resolved metadata) the poll doesn't carry.
 *
 * The store owns the loop, the surfaces own their INTEREST in it: `retain()` is
 * a claim that lives as long as the mounting surface and returns its own
 * release, so nothing polls when no surface is showing the result.
 *
 * The keys line up by construction: the poll id is the job id, which IS the
 * library item id, so `item.id` addresses both.
 */
const POLL_INTERVAL_MS = 3000
// While a lecture is downloading, poll faster so the progress ring advances
// smoothly rather than jumping once every 3s.
const FAST_POLL_INTERVAL_MS = 1200

/** What one item's status read told the loop. */
interface PollOutcome {
  readonly terminal: boolean
  readonly downloading: boolean
  readonly gaveUp: boolean
}

const NOTHING_HAPPENED: PollOutcome = { terminal: false, downloading: false, gaveUp: false }

/** Map the ingest wire state onto the library card's status vocabulary. Only the
 *  four card states are applied; `cancelled` is left for sync to reconcile. */
function toLibraryStatus(state: IngestState): LibraryItemStatus | null {
  switch (state) {
    case "queued":
    case "processing":
    case "ready":
    case "failed":
      return state
    default:
      return null
  }
}

export const useIngestPollingStore = defineStore("ingestPolling", () => {
  const app = useShruti()
  const library = useLibraryStore()
  const watchlist = createIngestPollWatchlist()

  /** How many mounted surfaces currently want live status. */
  const consumers = ref(0)
  const polling = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlightTick = false
  // Set by a tick that saw a downloading item — the scheduler then uses the
  // fast interval so the percent ring animates rather than stepping every 3s.
  let downloadActive = false
  // Bumped whenever the loop is stopped or the data underneath it is wiped, so
  // a tick already in flight cannot write its answers into state that has since
  // been emptied.
  let epoch = 0

  function applyPolledStatus(id: string, status: IngestStatusResponse): PollOutcome {
    const next = toLibraryStatus(status.state)
    if (!next) return NOTHING_HAPPENED
    library.applyLiveStatus(id, next, (status.track_id as TrackId | undefined) ?? null)
    // Granular stage (+ download percent) only while processing; cleared otherwise.
    const processing = next === "processing"
    library.setLiveStage(
      id,
      processing ? status.stage : undefined,
      processing ? status.percent : undefined
    )
    return {
      terminal: next === "ready" || next === "failed",
      downloading: processing && status.stage === "downloading",
      gaveUp: false,
    }
  }

  async function pollItem(id: string, generation: number, now: number): Promise<PollOutcome> {
    try {
      const status = await app.ingestClient.status(id)
      if (generation !== epoch) return NOTHING_HAPPENED
      watchlist.noteSuccess(id)
      return applyPolledStatus(id, status)
    } catch (error) {
      if (generation !== epoch) return NOTHING_HAPPENED
      return { ...NOTHING_HAPPENED, gaveUp: watchlist.noteFailure(id, error, now) }
    }
  }

  async function tick(): Promise<void> {
    if (inFlightTick) return
    if (!app.activeServer.value.orchestratorBaseUrl) return
    const now = Date.now()
    const ids = library.pendingItems.map((item) => item.id)
    const { active, gaveUp } = watchlist.selectActive(ids, now)
    if (active.length === 0) {
      downloadActive = false
      if (gaveUp) requestSync()
      return
    }

    const generation = epoch
    inFlightTick = true
    let outcomes: readonly PollOutcome[]
    try {
      outcomes = await Promise.all(active.map((id) => pollItem(id, generation, now)))
    } finally {
      inFlightTick = false
    }
    if (generation !== epoch) return

    downloadActive = outcomes.some((o) => o.downloading)
    // A job finished: pull the full authoritative row so the now-ready card is
    // immediately playable. A give-up asks for the same pull, because sync is
    // the fallback the item was just handed back to.
    const syncNeeded = gaveUp || outcomes.some((o) => o.terminal || o.gaveUp)
    if (syncNeeded) requestSync()
  }

  // Self-scheduling loop: the delay tightens while a download is in flight.
  function schedule(generation: number): void {
    if (generation !== epoch || !polling.value) return
    timer = setTimeout(
      () => {
        void tick().finally(() => schedule(generation))
      },
      downloadActive ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS
    )
  }

  function start(): void {
    if (polling.value) return
    polling.value = true
    const generation = epoch
    void tick().finally(() => schedule(generation))
  }

  function stop(): void {
    if (!polling.value && timer === null) return
    // Invalidate before clearing: a tick may be awaiting its status calls right
    // now, and it must not reschedule itself or write a late answer.
    epoch += 1
    polling.value = false
    downloadActive = false
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  /**
   * Claim live status for as long as the caller is on screen. Returns the
   * release — idempotent, so a double teardown can't drop the count below the
   * surfaces that are still mounted and kill their polling.
   */
  function retain(): () => void {
    consumers.value += 1
    if (consumers.value === 1) start()
    let released = false
    return () => {
      if (released) return
      released = true
      consumers.value -= 1
      if (consumers.value === 0) stop()
    }
  }

  /**
   * Drop everything in flight — for `wipeLocalUserData`, where the library rows
   * this loop writes into are being deleted underneath it. The claims survive:
   * a surface still mounted still wants live status, so the loop restarts with
   * a fresh generation against the emptied library.
   */
  function reset(): void {
    const claimed = consumers.value > 0
    stop()
    // The rows those verdicts were about are gone; anything added afterwards
    // deserves a fresh give-up clock. (`stop()` deliberately does NOT clear
    // them — a surface unmounting is not a reason to re-poll a dead job.)
    watchlist.clear()
    if (claimed) start()
  }

  return { consumers, polling, retain, reset }
})
