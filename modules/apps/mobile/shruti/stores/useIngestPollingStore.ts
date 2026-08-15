import { defineStore } from "pinia"
import { ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { IngestGatewayError } from "@infra/ingest/http/ingestClient.js"
import { requestSync } from "@shruti/services/syncEvents.js"
import type { LibraryItemStatus } from "@lib/domain/libraryItem.js"
import type { TrackId } from "@lib/domain/core.js"
import type { IngestState } from "@lib/contracts"

/**
 * The single owner of the live ingest poll.
 *
 * While an item is being ingested this polls `GET /orchestrator/run/{jobId}`
 * for each pending library item and patches its status into the library store —
 * so the card shows a real-time queued → processing → ready flip without waiting
 * out the sync cadence. On a terminal transition it fires `requestSync` once to
 * pull the authoritative row (audio keys, resolved metadata) the poll doesn't
 * carry.
 *
 * The loop used to live in the view: three pages instantiate
 * `useIngestStatusPolling`, Ionic keeps every page it has shown mounted, and so
 * a user who had opened Search, Chat and My Library ran three loops asking the
 * same question about the same job at the same 1.2s cadence (#1589). The
 * question has one answer and one place to write it, so it has one asker.
 *
 * Ownership: the store owns the loop, the surfaces own their INTEREST in it.
 * `retain()` is a claim that lives exactly as long as the mounting surface and
 * returns its own release; the loop starts on the first claim and stops on the
 * last release, so nothing polls when no surface is showing the result. That
 * makes idle cost zero rather than "one cheap early return per tick forever",
 * and it keeps the teardown where it can be verified — a component's unmount.
 * `useConnectivity` shares one set of window listeners between its callers the
 * same way; this is that shape, with the state in a store because the answers
 * are written into one.
 *
 * The keys line up by construction: the poll id is the job id, which IS the
 * library item id (`library_items.id`), so `item.id` addresses both.
 */
const POLL_INTERVAL_MS = 3000
// While a lecture is actively downloading, poll faster so the progress ring
// advances smoothly rather than jumping once every 3s.
const FAST_POLL_INTERVAL_MS = 1200

/**
 * How long one item may stay non-terminal before this loop stops asking about
 * it. Nothing here is a deadline on the INGEST — the orchestrator keeps working
 * and sync stays authoritative — only on the live poll, which is a nicety.
 * Generous on purpose: a long lecture downloaded and transcribed end to end is
 * minutes of honest work, so the cap is set where "still running" stops being a
 * plausible reading and "will never report terminal" starts.
 */
const GIVE_UP_AFTER_MS = 30 * 60_000

/**
 * Consecutive failed status reads before an item is dropped. A blip mid-tick is
 * ordinary (the timeout in `ingestClient` alone makes one), so a single failure
 * means nothing; a run of them is a job the control plane cannot answer for.
 */
const MAX_CONSECUTIVE_FAILURES = 5

/**
 * A status read that will fail the same way forever: the orchestrator has no
 * such run (404 — the job was pruned, or the row was never written), or it
 * refuses to answer for it (403/410). Retrying is pure waste, so these give up
 * on the first occurrence instead of serving out the failure budget.
 */
function isPermanentFailure(error: unknown): boolean {
  if (!(error instanceof IngestGatewayError)) return false
  return error.status === 404 || error.status === 403 || error.status === 410
}

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

  /** How many mounted surfaces currently want live status. */
  const consumers = ref(0)
  const polling = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlightTick = false
  // True after a tick that saw a downloading item — the scheduler then uses the
  // fast interval so the percent ring animates rather than stepping every 3s.
  let downloadActive = false
  // Bumped whenever the loop is stopped or the data underneath it is wiped, so
  // a tick already in flight cannot write its answers into state that has since
  // been emptied or into a generation nobody is listening to. Same guard
  // `useDownloadStore` puts around its in-flight transfers.
  let epoch = 0
  // Per-item give-up bookkeeping: when this loop first asked about an item, and
  // how many reads in a row have failed since. An item that ages out or runs
  // out of failure budget lands in `abandoned` and is never asked about again
  // this session — without it, a job the orchestrator will never report
  // terminal keeps `pendingItems` non-empty and the loop runs forever (#1834).
  const watched = new Map<string, { since: number; failures: number }>()
  const abandoned = new Set<string>()

  function abandon(id: string, reason: string): void {
    abandoned.add(id)
    watched.delete(id)
    console.warn(`[ingest] giving up on live status for ${id}: ${reason}`)
  }

  async function tick(): Promise<void> {
    if (inFlightTick) return
    if (!app.activeServer.value.orchestratorBaseUrl) return
    const now = Date.now()
    const pending = library.pendingItems.filter((item) => !abandoned.has(item.id))
    // Drop bookkeeping for items that left the pending set (finished, removed,
    // or wiped) so neither map grows with the session.
    const live = new Set(pending.map((item) => item.id))
    for (const id of watched.keys()) if (!live.has(id)) watched.delete(id)

    let gaveUp = false
    for (const item of pending) {
      const seen = watched.get(item.id)
      if (!seen) watched.set(item.id, { since: now, failures: 0 })
      else if (now - seen.since > GIVE_UP_AFTER_MS) {
        abandon(item.id, `no terminal state in ${Math.round(GIVE_UP_AFTER_MS / 60_000)}min`)
        gaveUp = true
      }
    }

    const active = pending.filter((item) => !abandoned.has(item.id))
    if (active.length === 0) {
      downloadActive = false
      if (gaveUp) requestSync()
      return
    }
    const generation = epoch
    inFlightTick = true
    let sawTerminal = false
    let sawDownloading = false
    try {
      await Promise.all(
        active.map(async (item) => {
          try {
            const s = await app.ingestClient.status(item.id)
            if (generation !== epoch) return
            const seen = watched.get(item.id)
            if (seen) seen.failures = 0
            const status = toLibraryStatus(s.state)
            if (!status) return
            library.applyLiveStatus(item.id, status, (s.track_id as TrackId | undefined) ?? null)
            // Granular stage (+ download percent) only while processing; cleared otherwise.
            const processing = status === "processing"
            library.setLiveStage(
              item.id,
              processing ? s.stage : undefined,
              processing ? s.percent : undefined
            )
            if (processing && s.stage === "downloading") sawDownloading = true
            if (status === "ready" || status === "failed") sawTerminal = true
          } catch (error) {
            if (generation !== epoch) return
            // A swallowed failure is how a job that can never be answered for
            // stayed indistinguishable from one that is merely slow. A
            // permanent answer ends the poll on the spot; a transient one
            // spends a life and is retried next tick, with sync still the
            // authoritative fallback either way.
            if (isPermanentFailure(error)) {
              abandon(item.id, `status read failed permanently (${String(error)})`)
              gaveUp = true
              return
            }
            const seen = watched.get(item.id)
            if (!seen) return
            seen.failures += 1
            if (seen.failures >= MAX_CONSECUTIVE_FAILURES) {
              abandon(item.id, `${seen.failures} consecutive failed status reads`)
              gaveUp = true
            }
          }
        })
      )
    } finally {
      inFlightTick = false
    }
    if (generation !== epoch) return
    downloadActive = sawDownloading
    // A job finished: pull the full authoritative row (keys/metadata the status
    // poll doesn't carry) so the now-ready card is immediately playable. A
    // give-up asks for the same pull, because sync is the fallback this loop
    // just handed the item back to — it is the only thing left that can move it.
    if (sawTerminal || gaveUp) requestSync()
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
   * Drop everything in flight — `wipeLocalUserData` ("Clear user data" and the
   * delete-account flow), where the library rows this loop is writing into are
   * being deleted underneath it.
   * The claims survive: a surface that is still mounted still wants live status
   * once there is something to report, so the loop restarts on the spot with a
   * fresh generation, against the emptied library (where it costs one early
   * return per tick until a new item is added).
   */
  function reset(): void {
    const claimed = consumers.value > 0
    stop()
    // The rows these verdicts were about are gone; anything added afterwards
    // deserves a fresh give-up clock. (`stop()` deliberately does NOT clear
    // them — a surface unmounting is not a reason to re-poll a dead job.)
    watched.clear()
    abandoned.clear()
    if (claimed) start()
  }

  return { consumers, polling, retain, reset }
})
