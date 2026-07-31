import { onMounted, onUnmounted } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import { requestSync } from "@lectorium/services/syncEvents.js"
import type { LibraryItemStatus } from "@lib/domain/libraryItem.js"
import type { TrackId } from "@lib/domain/core.js"
import type { IngestState } from "@lib/contracts"

/**
 * Live status polling for in-flight personal-library items. While a library view
 * is mounted, this polls `GET /orchestrator/ingest/{jobId}` for each item still
 * ingesting (`queued` / `processing`) and patches its status into the store —
 * so the card shows a real-time queued → processing → ready flip without waiting
 * out the sync cadence. On a terminal transition it fires `requestSync` once to
 * pull the authoritative row (audio keys, resolved metadata) the poll doesn't
 * carry. Idle (no pending items, or a region without the ingest API) costs one
 * cheap early-return per tick; the interval is torn down on unmount.
 *
 * The keys line up by construction: the poll id is the job id, which IS the
 * library item id (`library_items.id`), so `item.id` addresses both.
 */
const POLL_INTERVAL_MS = 3000

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

export function useIngestStatusPolling(): void {
  const app = useLectorium()
  const library = useLibraryStore()
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlightTick = false

  async function tick(): Promise<void> {
    if (inFlightTick) return
    if (!app.activeServer.value.orchestratorBaseUrl) return
    const pending = library.pendingItems
    if (pending.length === 0) return
    inFlightTick = true
    let sawTerminal = false
    try {
      await Promise.all(
        pending.map(async (item) => {
          try {
            const s = await app.ingestClient.status(item.id)
            const status = toLibraryStatus(s.state)
            if (!status) return
            library.applyLiveStatus(item.id, status, (s.track_id as TrackId | undefined) ?? null)
            // Granular stage only while processing; cleared otherwise.
            library.setLiveStage(item.id, status === "processing" ? s.stage : undefined)
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
    // A job finished: pull the full authoritative row (keys/metadata the status
    // poll doesn't carry) so the now-ready card is immediately playable.
    if (sawTerminal) requestSync()
  }

  onMounted(() => {
    void tick()
    timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
  })
  onUnmounted(() => {
    if (timer !== null) clearInterval(timer)
    timer = null
  })
}
