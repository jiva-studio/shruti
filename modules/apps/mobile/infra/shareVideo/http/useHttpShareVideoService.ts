import {
  ShareVideoRateLimitError,
  type CutVideoRequest,
  type CutVideoResponse,
  type IShareVideoService,
} from "@ports/app/index.js"

/**
 * `IShareVideoService` backed by a plain HTTP POST to the per-region
 * share-video reel renderer. The endpoint URL is resolved lazily via
 * `getEndpointUrl` so a settings flip routes subsequent calls to the new
 * region without rebuilding the service.
 *
 * Auth: server requires `Authorization: Bearer <jwt>`. The JWT carries
 * the `sub` (user id) used for per-user daily quotas server-side. Token
 * is pulled lazily via `getAccessToken` — auth port refreshes
 * transparently if it's within 60s of expiry.
 *
 * The function is server-side idempotent on `video_id`, so this adapter
 * is intentionally thin: no retries, no caching, no client-side
 * deduplication. Render takes ~30-90s on the cold path; surface a
 * spinner accordingly.
 */
/** The counters off a `rate_limited` 429, or null when the body is not that
 *  shape (an older service, a proxy's own 429). */
async function readRateLimit(
  response: Response
): Promise<{ current: number; limit: number } | null> {
  try {
    const json = (await response.clone().json()) as {
      code?: unknown
      current?: unknown
      limit?: unknown
    } | null
    if (json?.code !== "rate_limited") return null
    if (typeof json.current !== "number" || typeof json.limit !== "number") return null
    return { current: json.current, limit: json.limit }
  } catch {
    return null
  }
}

export function useHttpShareVideoService(
  getEndpointUrl: () => string,
  getAccessToken: () => Promise<string | null>
): IShareVideoService {
  return {
    async cut(req: CutVideoRequest): Promise<CutVideoResponse> {
      const endpoint = getEndpointUrl()
      const token = await getAccessToken()
      if (!token) {
        throw new Error("share-video: auth session unrecoverable (getAccessToken returned null)")
      }
      const body: Record<string, unknown> = {
        source_key: req.sourceKey,
        start_ms: req.startMs,
        end_ms: req.endMs,
        text: req.text,
        lang: req.lang,
        theme: req.theme,
      }
      if (req.videoId) body.video_id = req.videoId
      if (req.title && req.title.trim().length > 0) body.title = req.title.trim()

      // The cut is "tell the server to start rendering". The new
      // container backend returns 202 in ~50-200ms once the row lands
      // in `public.tasks`; the worker picks it up out-of-band. Mobile
      // platforms abort idle fetches around 60-100 s by default — we
      // cap at 8 s with our own AbortController so a slow handler
      // doesn't masquerade as a network error.
      //
      // If we abort, fall through to `ready:false` — the caller polls
      // the predicted URL, and the server keeps the queue row.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8_000)
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
      } catch (err: unknown) {
        // Detect our own timeout via the signal rather than the rejection
        // value: `fetch` surfaces an abort as a DOMException in browsers
        // but as a bare value on some runtimes, so `err.name` is not
        // reliable. `signal.aborted` is the one thing we control.
        if (ctrl.signal.aborted) {
          return { videoId: req.videoId ?? "", url: "", ready: false }
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        // The 429 body is branchable — `{code:"rate_limited", limit, current}`
        // — and throwing it away left both share paths saying "Try again" for
        // a quota that cannot lift before midnight UTC (#1847).
        if (response.status === 429) {
          const quota = await readRateLimit(response)
          if (quota) throw new ShareVideoRateLimitError(quota.current, quota.limit)
        }
        throw new Error(`share-video renderer returned ${response.status} ${response.statusText}`)
      }
      const parsed = (await response.json()) as {
        video_id: string
        url: string
        ready: boolean
      }
      return {
        videoId: parsed.video_id,
        url: parsed.url,
        ready: parsed.ready,
      }
    },
  }
}
