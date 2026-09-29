import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { LibraryItem, LibraryItemStatus } from "@lib/domain/libraryItem.js"
import type { TrackId } from "@lib/domain/core.js"
import { isPendingLibraryItem } from "@usecases/sync/index.js"
import { normalizeSource } from "@usecases/library/normalizeSource.js"
import { requestSync } from "@shruti/services/syncEvents.js"
import { useLibraryUseCases } from "@shruti/wiring/libraryUseCases.js"

/**
 * Single source of truth for the user's **personal library** — lectures the
 * user added that are not in the shared corpus.
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
  const useCases = useLibraryUseCases()

  // Raw facts + the archived-membership overlay; `items` is the active join.
  const allItems = ref<readonly LibraryItem[]>([])
  const archivedIds = ref<ReadonlySet<string>>(new Set())
  // Live granular pipeline stage per in-flight item (poll-only, ephemeral) —
  // the card shows it instead of a bare "Processing" while an item ingests.
  const liveStages = ref<ReadonlyMap<string, string>>(new Map())
  // Live download percent per in-flight item (poll-only) — refines the
  // downloading stage into "Downloading 40%". Cleared with the stage.
  const livePercents = ref<ReadonlyMap<string, number>>(new Map())
  // Normalized source URL → job id, recorded at submit time, so a just-submitted
  // lecture has live status before its row syncs down.
  const submittedIngestIds = ref<ReadonlyMap<string, string>>(new Map())
  // Normalized sources with a submit in flight — the double-tap guard.
  const inFlightSources = new Set<string>()
  const isLoading = ref<boolean>(false)
  // The READ failed — the shelf has nothing trustworthy to show.
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
      const shelf = await useCases.loadShelf()
      allItems.value = shelf.items
      archivedIds.value = shelf.archivedIds
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

  /** Whether a source URL is already an ACTIVE library item. */
  function hasSource(url: string): boolean {
    if (!url.trim()) return false
    const key = normalizeSource(url)
    return items.value.some((i) => i.sourceUrl != null && normalizeSource(i.sourceUrl) === key)
  }

  /** Across ALL items, removed ones included, so a re-add is recognised. */
  function findBySource(url: string): LibraryItem | undefined {
    if (!url.trim()) return undefined
    const key = normalizeSource(url)
    return allItems.value.find((i) => i.sourceUrl != null && normalizeSource(i.sourceUrl) === key)
  }

  /** The ingest job id for a source URL — the just-submitted one, or the id of
   *  a matched item so it also works after a reload. */
  function ingestIdForUrl(url: string): string | undefined {
    if (!url.trim()) return undefined
    return submittedIngestIds.value.get(normalizeSource(url)) ?? findBySource(url)?.id
  }

  /** Patch an item's status (and track id) from a live poll, ahead of the
   *  authoritative sync pull. No-op when nothing changed. */
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

  /** Set (or clear) the live pipeline stage and its download percent. Replaces
   *  the maps so the card re-renders; `percent` is unset off the download stage. */
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

  /** Soft-delete an item from the shelf; a re-add is instant with no re-ingest. */
  async function remove(id: string): Promise<void> {
    await useCases.remove(id)
    requestSync()
    await refresh()
  }

  /** Put a removed item back on the shelf. */
  async function restore(id: string): Promise<void> {
    await useCases.restore(id)
    requestSync()
    await refresh()
  }

  function isArchived(id: string): boolean {
    return archivedIds.value.has(id)
  }

  /** Claim a normalized source for a submit; `false` when one is already in flight. */
  function claimSource(sourceKey: string): boolean {
    if (inFlightSources.has(sourceKey)) return false
    inFlightSources.add(sourceKey)
    return true
  }

  function releaseSource(sourceKey: string): void {
    inFlightSources.delete(sourceKey)
  }

  function recordSubmission(sourceKey: string, membershipId: string): void {
    const next = new Map(submittedIngestIds.value)
    next.set(sourceKey, membershipId)
    submittedIngestIds.value = next
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
    restore,
    isArchived,
    claimSource,
    releaseSource,
    recordSubmission,
  }
})
