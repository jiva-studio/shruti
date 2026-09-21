import type { UseToast } from "@kit/composables"
import { downloadFailureKey, type DownloadFailureCause } from "./downloadFailureKey.js"

/**
 * Who asked for a download. `"user"` is a tap someone is waiting on; `"queue"`
 * is the prefetch FIFO working through a playlist on its own. Only the notice
 * rate-limit reads it — the user's own request is never suppressed by the
 * queue's.
 */
export type DownloadOrigin = "user" | "queue"

/**
 * The budget notice carries a "Download anyway" button, so it stays on screen
 * long enough to be read and acted on.
 */
const BUDGET_NOTICE_DURATION_MS = 20_000

/** How long one queue-origin failure notice silences the rest. */
const FAILURE_NOTICE_COOLDOWN_MS = 60_000

export interface DownloadNoticesDeps {
  readonly t: (key: string) => string
  readonly toast: Pick<UseToast, "error" | "action">
}

export interface DownloadNotices {
  announceBudgetFull(downloadAnyway: () => void): void
  announceDownloadFailed(origin: DownloadOrigin, cause: DownloadFailureCause): void
}

export function createDownloadNotices(deps: DownloadNoticesDeps): DownloadNotices {
  const { t, toast } = deps
  let budgetNoticeVisible = false
  let lastFailureNoticeAt = 0

  /**
   * Tell the user why a lecture did not save offline, and offer the way past
   * the limit for that one lecture.
   *
   * At most one budget notice is on screen at a time: a second would be an
   * unreadable stack, and the button on the first would no longer refer to what
   * the user is looking at. That, rather than a cooldown, is what keeps a
   * draining queue from turning into a toast storm.
   */
  function announceBudgetFull(downloadAnyway: () => void): void {
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
   * Tell the user a download did not happen, and which failure it was.
   *
   * The cooldown suppresses queue notices only: a background queue failing
   * every job in airplane mode must be told once, but it must not swallow the
   * answer to something the user just tapped.
   */
  function announceDownloadFailed(origin: DownloadOrigin, cause: DownloadFailureCause): void {
    const now = Date.now()
    if (origin === "queue" && now - lastFailureNoticeAt < FAILURE_NOTICE_COOLDOWN_MS) return
    lastFailureNoticeAt = now
    void toast.error(t(downloadFailureKey(cause)))
  }

  return { announceBudgetFull, announceDownloadFailed }
}
