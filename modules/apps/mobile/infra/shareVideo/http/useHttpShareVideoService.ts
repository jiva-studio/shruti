import {
  ShareVideoRateLimitError,
  type CutVideoRequest,
  type CutVideoResponse,
  type IShareVideoService,
} from "@ports/app/index.js"
import { rebaseShareUrl, type PublicUrlOf } from "../../shareArtifactUrl.js"

/** A request to the active region's share-video endpoint; `path` is relative to it. */
export type ShareVideoRequest = (path: string, init: RequestInit) => Promise<Response>

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

/** The 429 body is branchable — `{code:"rate_limited", limit, current}` — and
 *  throwing it away leaves both share paths saying "Try again" for a quota
 *  that cannot lift before midnight UTC. */
async function throwForStatus(response: Response): Promise<never> {
  if (response.status === 429) {
    const quota = await readRateLimit(response)
    if (quota) throw new ShareVideoRateLimitError(quota.current, quota.limit)
  }
  throw new Error(`share-video renderer returned ${response.status} ${response.statusText}`)
}

function buildCutBody(req: CutVideoRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    source_key: req.sourceKey,
    start_ms: req.startMs,
    end_ms: req.endMs,
    text: req.text,
    lang: req.lang,
    theme: req.theme,
  }
  if (req.videoId) body.video_id = req.videoId
  const title = req.title?.trim() ?? ""
  if (title) body.title = title
  return body
}

/**
 * `IShareVideoService` backed by an HTTP POST to the share-video reel
 * renderer of the active region.
 *
 * Auth: server requires `Authorization: Bearer <jwt>`. The JWT carries
 * the `sub` (user id) used for per-user daily quotas server-side. Token
 * is pulled lazily via `getAccessToken` — auth port refreshes
 * transparently if it's within 60s of expiry.
 *
 * The function is server-side idempotent on `video_id`, so this adapter is
 * intentionally thin: no retries, no caching, no client-side deduplication.
 * Render takes ~30-90s on the cold path; surface a spinner accordingly. Only
 * the object key of the answered URL is used (see `shareArtifactUrl`).
 */
export function useHttpShareVideoService(
  request: ShareVideoRequest,
  getAccessToken: () => Promise<string | null>,
  publicUrlOf: PublicUrlOf
): IShareVideoService {
  return {
    async cut(req: CutVideoRequest): Promise<CutVideoResponse> {
      const token = await getAccessToken()
      if (!token) {
        throw new Error("share-video: auth session unrecoverable (getAccessToken returned null)")
      }

      // The cut tells the server to start rendering; it answers 202 in
      // ~50-200ms once the row lands in `public.tasks` and a worker picks it
      // up out-of-band. Mobile platforms abort idle fetches around 60-100s, so
      // an 8s cap of our own keeps a slow handler from masquerading as a
      // network error. On abort we fall through to `ready:false` — the caller
      // polls the predicted URL and the server keeps the queue row.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8_000)
      let response: Response
      try {
        response = await request("", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(buildCutBody(req)),
          signal: ctrl.signal,
        })
      } catch (err: unknown) {
        // Detect our own timeout via the signal, not the rejection value:
        // `fetch` surfaces an abort as a DOMException in browsers but as a
        // bare value on some runtimes, so `err.name` is not reliable.
        if (ctrl.signal.aborted) return { videoId: req.videoId ?? "", url: "", ready: false }
        throw err
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) await throwForStatus(response)
      const parsed = (await response.json()) as { video_id: string; url: string; ready: boolean }
      const url = rebaseShareUrl(parsed.url, publicUrlOf)
      return { videoId: parsed.video_id, url, ready: parsed.ready && url.length > 0 }
    },
  }
}
