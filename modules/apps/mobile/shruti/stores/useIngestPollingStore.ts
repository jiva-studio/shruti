import { defineStore } from "pinia"
import { ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
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

  async function tick(): Promise<void> {
    if (inFlightTick) return
    if (!app.activeServer.value.orchestratorBaseUrl) return
    const pending = library.pendingItems
    if (pending.length === 0) {
      downloadActive = false
      return
    }
    const generation = epoch
    inFlightTick = true
    let sawTerminal = false
    let sawDownloading = false
    try {
      await Promise.all(
        pending.map(async (item) => {
          try {
            const s = await app.ingestClient.status(item.id)
            if (generation !== epoch) return
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
          } catch {
            // Transient poll failure — try again next tick; sync remains the
            // authoritative fallback.
          }
        })
      )
    } finally {
      inFlightTick = false
    }
    if (generation !== epoch) return
    downloadActive = sawDownloading
    // A job finished: pull the full authoritative row (keys/metadata the status
    // poll doesn't carry) so the now-ready card is immediately playable.
    if (sawTerminal) requestSync()
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
    if (claimed) start()
  }

  return { consumers, polling, retain, reset }
})
