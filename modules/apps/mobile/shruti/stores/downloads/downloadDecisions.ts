import type { Result } from "@kit/core"
import type { CdnServer } from "@lib/domain/servers.js"
import type { DownloadMediaError, DownloadMediaSuccess } from "@usecases/downloads/downloadMedia.js"
import type { DownloadFailureCause } from "./downloadFailureKey.js"
import type { DownloadOrigin } from "./downloadNotices.js"

export interface BudgetInput {
  /** A one-off pass granted by "Download anyway", already spent by the caller. */
  readonly exempt: boolean
  /** The bytes are already on disk, so the transfer asks the device for no new space. */
  readonly onDisk: boolean
  readonly hasRoom: boolean
  readonly origin: DownloadOrigin
  /** Whether the budget is known; an unmeasured one has no room for anything. */
  readonly measured: boolean
}

export type BudgetDecision =
  | { readonly kind: "admit" }
  | { readonly kind: "defer"; readonly announce: boolean }

/**
 * Whether a new transfer may start, and whether a refusal is worth a notice.
 *
 * Only a request someone is waiting on is told, and only when the budget is
 * actually known to be full: an unmeasured budget refuses too, and "storage is
 * full" would then be a guess about a device that was never measured. A queue's
 * own refusals are told by the row's `deferred` state and nothing else.
 */
export function decideBudget(input: BudgetInput): BudgetDecision {
  if (input.exempt || input.onDisk || input.hasRoom) return { kind: "admit" }
  return { kind: "defer", announce: input.origin === "user" && input.measured }
}

export type TransferOutcome =
  | { readonly kind: "saved"; readonly localPath: string | null; readonly server: CdnServer }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly cause: DownloadFailureCause }

/**
 * Read a finished transfer as one of three outcomes.
 *
 * A cancelled transfer is a user decision (remove, archive, data wipe), not a
 * fault, and is kept apart from the failures so nothing paints a red retry
 * affordance on a row the user just asked to drop.
 */
export function classifyTransferResult(
  result: Result<DownloadMediaSuccess, DownloadMediaError>
): TransferOutcome {
  if (result.ok) {
    return {
      kind: "saved",
      localPath: result.value.mediaItem.localPath,
      server: result.value.server,
    }
  }
  if (result.error === "cancelled") return { kind: "cancelled" }
  return { kind: "failed", cause: result.error }
}
