import type { IExcerptCache } from "@ports/app/index.js"
import { pollUntilReady } from "./pollUntilReady.js"

export interface ResolveShareArtifactArgs {
  readonly cache: IExcerptCache
  /** Flat cache filename (e.g. `share-audio-note-<id>.mp3`). */
  readonly filename: string
  /** Predicted public CDN URL for a prior render of this artifact —
   *  tried before paying for a fresh cut, and used as the poll target. */
  readonly predictedUrl: string
  /**
   * Kick off the server-side cut. May resolve to `{ url, ready }` (the
   * audio cutter returns the URL and a ready flag) or to nothing (the
   * video renderer just dispatches and we poll the predicted URL). When
   * `ready !== true` the predicted/returned URL is polled until live.
   */
  readonly cut: () => Promise<{ url?: string; ready?: boolean } | void>
  /**
   * Optional wrapper around the cold cut+poll, so a caller can drive
   * progress UI for a long render (Studio's timed "rendering…/almost
   * ready…" labels). Notes omits it — its cut is fast.
   */
  readonly wrapCut?: <T>(work: Promise<T>) => Promise<T>
  /** Called right before the final download (Studio flips its status to
   *  "downloading…" here). */
  readonly onBeforeDownload?: () => void
  /**
   * Hard cap (ms) for the predicted-URL poll on the cold path. Defaults
   * to `pollUntilReady`'s 8-min Studio-video budget; the fast audio /
   * transcript cutters pass `SHORT_POLL_TIMEOUT_MS` so a dead URL fails
   * fast instead of hanging for minutes.
   */
  readonly pollTimeoutMs?: number
}

/**
 * Shared "produce a shareable local file" pipeline behind the Notes
 * audio-share and Studio video-share flows:
 *
 *   local cache hit → CDN warm hit → cold cut + poll → download
 *
 * Returns the local `file://` URI ready for the share sheet. The
 * surface-specific progress UX (Notes' 3-second handoff vs Studio's
 * timed render labels + busy spinner) stays in the caller; only this
 * cache/probe/cut/poll/download core is shared.
 */
export async function resolveShareArtifact(args: ResolveShareArtifactArgs): Promise<string> {
  // 1. Local cache hit — no HTTP at all.
  const cached = await args.cache.findLocal(args.filename)
  if (cached) return cached

  // 2. CDN warm hit (prior render still on the bucket).
  let publicUrl = (await args.cache.probeRemote(args.predictedUrl)) ? args.predictedUrl : null

  // 3. Cold path: cut, then poll the predicted/returned URL until live.
  if (!publicUrl) {
    const run = (async () => {
      const result = await args.cut()
      const url = (result && result.url) || args.predictedUrl
      if (!result || result.ready !== true) {
        await pollUntilReady(url, { timeoutMs: args.pollTimeoutMs })
      }
      return url
    })()
    publicUrl = args.wrapCut ? await args.wrapCut(run) : await run
  }

  args.onBeforeDownload?.()
  return args.cache.download({ url: publicUrl, filename: args.filename })
}
