import type { AddByUrlFailureReason } from "@shruti/stores/library/classifyIngestFailure.js"

/**
 * What an `addByUrl` call actually accomplished. "Returned without throwing" is
 * not an outcome: the PRO gate and a rejected submit both return normally.
 *   - `added`     — submitted to ingest, un-archived, or already present
 *   - `paywalled` — bounced to the paywall; nothing was submitted, retry after
 *                   the user subscribes
 *   - failure     — the submit was attempted and rejected, carrying WHY so the
 *                   caller can say it. `paywalled` stays its own value because
 *                   chip routing branches on it.
 */
export type AddByUrlResult =
  | "added"
  | "paywalled"
  | { readonly kind: "failed"; readonly reason: AddByUrlFailureReason }

/** The failure reason, or `null` for the two non-failure outcomes. */
export function addFailureReason(result: AddByUrlResult): AddByUrlFailureReason | null {
  return typeof result === "string" ? null : result.reason
}
