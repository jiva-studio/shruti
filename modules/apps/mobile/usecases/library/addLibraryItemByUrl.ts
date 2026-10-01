import { IngestGatewayError, type IIngestClient } from "@lib/contracts"
import type { LibraryItem } from "@lib/domain/libraryItem.js"
import type { AddByUrlResult } from "./addByUrlResult.js"
import { classifyIngestFailure } from "./classifyIngestFailure.js"
import { normalizeSource } from "./normalizeSource.js"

export const FREE_TIER_IMPORT_LIMIT = 10

export interface LectureHints {
  readonly title?: string
  readonly author?: string
}

export interface AddLibraryItemByUrlDeps {
  /** Resolves once the entitlement is known; `false` has already bounced the
   *  user to the paywall. */
  readonly ensurePro?: () => Promise<boolean>
  readonly isPro?: () => boolean | Promise<boolean>
  readonly externalItemCount?: () => number
  readonly openPaywall: () => Promise<void>
  /** The personal library as the shelf holds it right now. */
  readonly library: {
    /** Across ALL items, removed ones included, so a re-add is recognised. */
    findBySource(url: string): LibraryItem | undefined
    isArchived(id: string): boolean
    /** Put a removed item back and reload the shelf. */
    restore(id: string): Promise<void>
    /** The double-tap guard: `false` when a submit for this source is on the wire. */
    claimSource(sourceKey: string): boolean
    releaseSource(sourceKey: string): void
    /** Remember the job a source was submitted as, so it has live status
     *  before its row syncs down. */
    recordSubmission(sourceKey: string, membershipId: string): void
  }
  readonly ingest: Pick<IIngestClient, "submit">
  readonly requestSync: () => void
}

async function checkEntitlementOrQuota(deps: AddLibraryItemByUrlDeps): Promise<boolean> {
  if (deps.isPro) {
    const pro = await deps.isPro()
    if (pro === true) return true
    if (pro === false) {
      const count = deps.externalItemCount ? deps.externalItemCount() : 0
      if (count < FREE_TIER_IMPORT_LIMIT) {
        return true
      }
      await deps.openPaywall()
      return false
    }
  }
  if (deps.ensurePro) {
    return deps.ensurePro()
  }
  return true
}

/**
 * Add, retry or re-add a lecture by URL, resolving the right action locally so
 * chat is never involved:
 *   - not in the library        → submit to the ingest API (fresh add)
 *   - removed (archived)         → un-archive locally (instant, no re-ingest);
 *                                  also submit if it had failed
 *   - present but failed         → submit (the orchestrator restarts the job)
 *   - present and not failed     → no-op (already there / in progress)
 * PRO-gated; free tier users are granted a starter quota of 10 items.
 */
export async function addLibraryItemByUrl(
  url: string,
  hints: LectureHints | undefined,
  deps: AddLibraryItemByUrlDeps
): Promise<AddByUrlResult> {
  if (!url.trim()) return { kind: "failed", reason: "invalid" }
  const allowed = await checkEntitlementOrQuota(deps)
  if (!allowed) return "paywalled"

  const existing = deps.library.findBySource(url)
  if (existing) {
    if (deps.library.isArchived(existing.id)) await deps.library.restore(existing.id)
    // A failed item still needs a re-run; a healthy present item is done.
    if (existing.status !== "failed") return "added"
  }
  return submitIngest(url, hints, deps)
}

async function submitIngest(
  url: string,
  hints: LectureHints | undefined,
  deps: AddLibraryItemByUrlDeps
): Promise<AddByUrlResult> {
  const key = normalizeSource(url)
  // A second tap while the first is on the wire is a no-op: the shelf can't
  // see it yet, so without this both taps submit the same run. The first tap
  // owns the outcome; this one reports the submit it joined.
  if (!deps.library.claimSource(key)) return "added"
  try {
    const res = await deps.ingest.submit({ url, title: hints?.title, author: hints?.author })
    deps.library.recordSubmission(key, res.membership_id)
    deps.requestSync()
    return "added"
  } catch (err) {
    if (err instanceof IngestGatewayError && err.code === "not_pro") {
      await deps.openPaywall()
      return "paywalled"
    }
    return { kind: "failed", reason: classifyIngestFailure(err) }
  } finally {
    deps.library.releaseSource(key)
  }
}
