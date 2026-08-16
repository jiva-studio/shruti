import type { PluginListenerHandle } from "@capacitor/core"
import { MediaDownloader } from "@shruti/plugin-media-downloader"

/**
 * Abort a download that makes no progress for this long.
 *
 * The plugin settles a transfer with exactly two events, `completed` and
 * `failed`, and a job that never runs emits neither: on Android the work is
 * enqueued under a `NetworkType.CONNECTED` constraint, so offline it is
 * parked indefinitely rather than rejected. A caller awaiting those events
 * therefore waits forever — which is how the transcript reader ended up
 * showing "Loading transcript…" with no error, and how a share held the
 * app-wide single share slot until a force-quit (#1833).
 *
 * 45 s of complete silence, matching `SHORT_POLL_TIMEOUT_MS` on the share
 * pipeline this feeds: long enough that a slow-but-live transfer keeps
 * re-arming the timer on its `progress` events, short enough that a blocked
 * UI recovers while the user is still looking at it. The content-database
 * fetcher — the same defect, fixed there first — uses 60 s because it is a
 * ~54 MB bootstrap download nobody is holding a modal open for.
 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 45_000

export interface StallGuard {
  /** A sign of life — restarts the silence budget. */
  readonly ping: () => void
  /** Disarm. Always call it. */
  readonly cancel: () => void
}

export interface StallGuardOptions {
  /** Silence budget before the transfer is declared dead. */
  readonly stallTimeoutMs?: number
  /** Names the transfer in the stall error, e.g. "Transcript download". */
  readonly label?: string
  /** Fired once, when the budget elapses with no `ping`. */
  readonly onStall: (error: Error) => void
}

/**
 * The rule "give up after this long with no sign of life", on its own.
 *
 * Split out of {@link watchDownload} because not every caller of the media
 * bridge learns about progress from the plugin's own events: the share flows
 * go through the `IMediaDownloader` port and see bytes only via their
 * `onProgress` callback, so they cannot subscribe by task id. They still have
 * to die by the same rule, and a second `setTimeout` with its own number would
 * be two rules pretending to be one.
 *
 * Armed on creation — the interval that matters is the one since the last sign
 * of life, and a transfer that never starts produces none at all. `ping` is
 * what keeps a slow-but-live transfer alive: every progress event pushes the
 * deadline out, so only genuine silence ends it.
 */
export function createStallGuard({
  stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS,
  label = "Download",
  onStall,
}: StallGuardOptions): StallGuard {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
  const ping = (): void => {
    cancel()
    timer = setTimeout(() => {
      timer = undefined
      onStall(new Error(`${label} stalled: no progress for ${stallTimeoutMs / 1000}s`))
    }, stallTimeoutMs)
  }
  ping()
  return { ping, cancel }
}

export interface DownloadWatch {
  /** Resolves with the local `file://` URL, rejects on failure or stall. */
  readonly completion: Promise<string>
  /** Detach listeners and disarm the watchdog. Always call it. */
  readonly cleanup: () => void
}

export interface WatchDownloadOptions {
  /** Silence budget before the transfer is declared dead. */
  readonly stallTimeoutMs?: number
  /** Names the transfer in the stall error, e.g. "Transcript download". */
  readonly label?: string
}

/**
 * Subscribe to the completion of one download identified by `id`, bounded by
 * a no-progress watchdog.
 *
 * Lives at the infra root rather than beside either caller because both
 * adapters over this bridge are the same defect and must settle by the same
 * rule; the eslint sibling-import ban carves it out by name for that reason.
 *
 * Listeners are attached eagerly — the caller awaits this before it calls
 * `download()` — so a fast or already-cached completion cannot fire its event
 * before the handler is in place and strand the promise. The watchdog is
 * armed here for the same reason it is re-armed on every `progress` event:
 * the interval that matters is the one since the last sign of life, and for a
 * job that never starts there is no sign of life at all.
 *
 * A stall also cancels the native task. Left alone, a parked Android job
 * would run whenever connectivity returns and write to a destination whose
 * caller has long since given up and swept the partial away, leaving an
 * orphan temp behind; cancelling with `deletePartial` keeps the on-disk state
 * consistent with what the caller was told.
 */
export async function watchDownload(
  id: string,
  { stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS, label = "Download" }: WatchDownloadOptions = {}
): Promise<DownloadWatch> {
  const handles: PluginListenerHandle[] = []
  let onCompleted!: (localUrl: string) => void
  let onFailed!: (error: Error) => void
  const completion = new Promise<string>((resolve, reject) => {
    onCompleted = resolve
    onFailed = reject
  })
  // The watchdog can reject before the caller reaches its `await completion`
  // (it dispatches `download()` first), which would surface as an unhandled
  // rejection. A no-op handler marks the promise handled without consuming
  // it — the caller's own `await` still sees the rejection.
  void completion.catch(() => {})

  const stall = createStallGuard({
    stallTimeoutMs,
    label,
    onStall: (error) => {
      void MediaDownloader.cancel({ id, deletePartial: true }).catch(() => {
        // The task is already gone, or the platform refuses — the caller is
        // being failed either way, which is the point.
      })
      onFailed(error)
    },
  })

  handles.push(
    await MediaDownloader.addListener("progress", (e) => {
      if (e.id !== id) return
      stall.ping()
    })
  )
  handles.push(
    await MediaDownloader.addListener("completed", (e) => {
      if (e.id !== id) return
      stall.cancel()
      onCompleted(e.localUrl)
    })
  )
  handles.push(
    await MediaDownloader.addListener("failed", (e) => {
      if (e.id !== id) return
      stall.cancel()
      onFailed(new Error(e.error || "Download failed"))
    })
  )

  return {
    completion,
    cleanup: () => {
      stall.cancel()
      for (const h of handles) void h.remove()
    },
  }
}
