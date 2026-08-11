import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { LibraryItem, LibraryItemStatus } from "@lib/domain/libraryItem.js"
import type { TrackId } from "@lib/domain/core.js"
import { isPendingLibraryItem } from "@usecases/sync/index.js"
import { useShruti } from "@shruti/shruti.js"
import { requestSync } from "@shruti/services/syncEvents.js"
import { IngestGatewayError } from "@infra/ingest/http/ingestClient.js"

/**
 * What an `addByUrl` call actually accomplished. "Returned without throwing"
 * is not an outcome: the PRO gate and a rejected submit both return normally,
 * and a caller that reads them as success marks the lecture added when nothing
 * was submitted (#1727).
 *   - `added`     — submitted to ingest, un-archived, or already present
 *   - `paywalled` — bounced to the paywall; nothing was submitted, retry after
 *                   the user subscribes
 *   - `failed`    — the submit was attempted and rejected
 */
export type AddByUrlResult = "added" | "paywalled" | "failed"

/**
 * Single source of truth for the user's **personal library** — lectures the
 * user added that are not in the shared corpus (epic #1236).
 *
 * Two collections back this store. `library_items` (server-owned, pull-only) is
 * the ingest FACTS — the store never writes it. `library_memberships` (CLIENT-
 * owned, synced) is the user's remove/re-add INTENT — the store writes it via
 * the journaled repo. The visible `items` is the join: a library item shown iff
 * it is NOT archived in `library_memberships` (absent membership = active).
 *
 * NOTE: distinct from `useLibraryLandingStore` (Search landing sections) and
 * `useLibraryLanguages` (content-language facet) — "library" is overloaded in
 * this app; this one is the *personal* library.
 */
export const useLibraryStore = defineStore("personalLibrary", () => {
  const app = useShruti()

  // Raw facts + the archived-membership overlay; `items` is the active join.
  const allItems = ref<readonly LibraryItem[]>([])
  const archivedIds = ref<ReadonlySet<string>>(new Set())
  // Live granular pipeline stage per in-flight item (poll-only, ephemeral) —
  // the card shows it instead of a bare "Processing" while an item ingests.
  const liveStages = ref<ReadonlyMap<string, string>>(new Map())
  // Live download percent per in-flight item (poll-only) — refines the
  // downloading stage into "Downloading 40%". Cleared with the stage.
  const livePercents = ref<ReadonlyMap<string, number>>(new Map())
  // normalized source URL → job id, recorded at submit time. The job id IS the
  // library item id (deterministic), so a just-submitted lecture can be matched
  // to its live status BEFORE its row syncs down (where sourceUrl isn't yet set
  // during processing) — used to show ingest progress on the chat candidate card.
  const submittedIngestIds = ref<ReadonlyMap<string, string>>(new Map())
  // Normalized sources with a submit in flight — the double-tap guard.
  const inFlightSources = new Set<string>()
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  let loaded = false

  /** Items the user has NOT removed — the visible library. */
  const items = computed(() => allItems.value.filter((i) => !archivedIds.value.has(i.id)))
  /** Items still being ingested (server will flip them to ready/failed). */
  const pendingItems = computed(() => items.value.filter(isPendingLibraryItem))
  const hasPending = computed(() => pendingItems.value.length > 0)
  const isEmpty = computed(() => items.value.length === 0)

  async function refresh(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      // Facts + the archived overlay. Both always present (not gated on the sync
      // `getDeviceId`); the sync-apply adapter fills the tables when the engine
      // runs, and the local writes below fill memberships even without it.
      const repos = app.repositories()
      const [rows, archived] = await Promise.all([
        repos.libraryItems.listAll(),
        repos.libraryMemberships.listArchivedIds(),
      ])
      allItems.value = rows
      archivedIds.value = archived
      loaded = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load library"
      // Keep the last-good list (don't blank the shelf on a transient read
      // failure), and leave `loaded` false so `ensureLoaded` retries.
      loaded = false
    } finally {
      isLoading.value = false
    }
  }

  /** Lazy refresh — only refetches if we've never loaded. */
  async function ensureLoaded(): Promise<void> {
    if (!loaded) await refresh()
  }

  function getById(id: string): LibraryItem | undefined {
    return allItems.value.find((i) => i.id === id)
  }

  /** Whether a source URL is already an ACTIVE library item — used to mark a
   *  search candidate the user has added. Matches on the normalized source. */
  function hasSource(url: string): boolean {
    if (!url.trim()) return false
    const key = normalizeSource(url)
    return items.value.some((i) => i.sourceUrl != null && normalizeSource(i.sourceUrl) === key)
  }

  /** Find a library item by source across ALL items (including removed ones),
   *  so a re-add of a previously-removed lecture is recognised. */
  function findBySource(url: string): LibraryItem | undefined {
    if (!url.trim()) return undefined
    const key = normalizeSource(url)
    return allItems.value.find((i) => i.sourceUrl != null && normalizeSource(i.sourceUrl) === key)
  }

  /** The ingest job id for a source URL, if this device just submitted it — the
   *  id equals the (deterministic) library item id, so live status can be shown
   *  before the row (which lacks sourceUrl while processing) syncs down. Falls
   *  back to a matched item so it also works after a reload / on another view. */
  function ingestIdForUrl(url: string): string | undefined {
    if (!url.trim()) return undefined
    return submittedIngestIds.value.get(normalizeSource(url)) ?? findBySource(url)?.id
  }

  /**
   * Patch an item's lifecycle status (and track id) from a live status poll,
   * ahead of the authoritative sync pull. No-op when the item isn't loaded yet
   * or nothing changed; on a terminal transition the poller reconciles the full
   * row via requestSync.
   */
  function applyLiveStatus(id: string, status: LibraryItemStatus, trackId: TrackId | null): void {
    const idx = allItems.value.findIndex((i) => i.id === id)
    if (idx === -1) return
    const cur = allItems.value[idx]
    if (!cur) return
    const nextTrackId = trackId ?? cur.trackId
    if (cur.status === status && cur.trackId === nextTrackId) return
    const next = allItems.value.slice()
    next[idx] = { ...cur, status, trackId: nextTrackId }
    allItems.value = next
  }

  /** Set (or clear) the live pipeline stage — and its download percent — for an
   *  in-flight item, from a status poll. Replaces the maps so the card re-renders
   *  reactively. `percent` is undefined off the downloading stage. */
  function setLiveStage(id: string, stage: string | undefined, percent?: number): void {
    const curStage = liveStages.value.get(id)
    if (curStage !== stage) {
      const next = new Map(liveStages.value)
      if (stage) next.set(id, stage)
      else next.delete(id)
      liveStages.value = next
    }
    const curPct = livePercents.value.get(id)
    if (curPct !== percent) {
      const next = new Map(livePercents.value)
      if (percent !== undefined) next.set(id, percent)
      else next.delete(id)
      livePercents.value = next
    }
  }

  /**
   * Remove a lecture from the library — a client-owned soft delete: archive its
   * membership (synced across the user's devices) and hide it locally. The
   * `library_items` facts (and the stored content) are kept, so a later re-add
   * is instant (see addByUrl) with no re-ingest.
   */
  async function remove(id: string): Promise<void> {
    await app.repositories().libraryMemberships.setArchived(id)
    requestSync()
    await refresh()
  }

  /**
   * Add / retry / re-add a lecture by URL. Resolves the right action locally so
   * chat is never involved:
   *   - not in the library        → submit to the ingest API (fresh add)
   *   - removed (archived)         → un-archive locally (instant, no re-ingest);
   *                                  also submit if it had failed
   *   - present but failed         → submit (the orchestrator restarts the job)
   *   - present and not failed      → no-op (already in the library / in progress)
   * PRO-gated; a non-subscriber (or a server not_pro) is bounced to the paywall.
   * Reports which of those happened — see {@link AddByUrlResult}.
   */
  async function addByUrl(
    url: string,
    hints?: { title?: string; author?: string }
  ): Promise<AddByUrlResult> {
    if (!url.trim()) return "failed"
    const { usePurchasesStore } = await import("@shruti/stores/usePurchasesStore.js")
    if (!usePurchasesStore().isSubscribed) {
      await openPaywall()
      return "paywalled"
    }
    const existing = findBySource(url)
    if (existing) {
      const wasArchived = archivedIds.value.has(existing.id)
      if (wasArchived) {
        await app.repositories().libraryMemberships.setActive(existing.id)
        requestSync()
        await refresh()
      }
      // A failed item still needs a re-run; a healthy present item is done.
      if (existing.status !== "failed") return "added"
    }
    return submitIngest(url, hints)
  }

  async function submitIngest(
    url: string,
    hints?: { title?: string; author?: string }
  ): Promise<AddByUrlResult> {
    const key = normalizeSource(url)
    // A second tap while the first request is still on the wire is a no-op —
    // findBySource can't see it yet (the row hasn't synced down), so without this
    // both taps submit the same run. Bounded by the ingest client's request
    // timeout, so a hung connection can't leave the button silently dead.
    // The first tap owns the outcome; this one reports the submit it joined.
    if (inFlightSources.has(key)) return "added"
    inFlightSources.add(key)
    try {
      const res = await app.ingestClient.submit({ url, title: hints?.title, author: hints?.author })
      const next = new Map(submittedIngestIds.value)
      next.set(key, res.membership_id)
      submittedIngestIds.value = next
      requestSync()
      return "added"
    } catch (err) {
      if (err instanceof IngestGatewayError && err.code === "not_pro") {
        await openPaywall()
        return "paywalled"
      }
      error.value = err instanceof Error ? err.message : "Failed to add lecture"
      return "failed"
    } finally {
      inFlightSources.delete(key)
    }
  }

  async function openPaywall(): Promise<void> {
    const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
    usePaywallStore().requestOpen()
  }

  return {
    items,
    isLoading,
    error,
    pendingItems,
    hasPending,
    isEmpty,
    refresh,
    ensureLoaded,
    getById,
    hasSource,
    findBySource,
    ingestIdForUrl,
    applyLiveStatus,
    liveStages,
    livePercents,
    setLiveStage,
    remove,
    addByUrl,
  }
})

const YT_ID = /(?:youtube\.com\/(?:watch\?[^\s]*\bv=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i

function normalizeSource(url: string): string {
  const m = YT_ID.exec(url)
  return m ? `yt:${m[1]}` : url.trim()
}
