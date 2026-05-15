import type { CutVideoRequest, CutVideoResponse, IShareVideoService } from "@ports/app/index.js"

/**
 * `IShareVideoService` backed by a plain HTTP POST to the per-region
 * share-video reel renderer (AWS Lambda HTTP API for `global`, Yandex
 * Cloud Function for `russia`). The endpoint URL is resolved lazily via
 * `getEndpointUrl` so a settings flip routes subsequent calls to the new
 * region without rebuilding the service.
 *
 * The function is already idempotent server-side on `video_id`, so this
 * adapter is intentionally thin: no retries, no caching, no client-side
 * deduplication. Callers are expected to either reuse a stable id (e.g.
 * note id) or accept a freshly-generated one. Render takes ~30-90s on the
 * cold path; surface a spinner accordingly.
 */
export function useHttpShareVideoService(getEndpointUrl: () => string): IShareVideoService {
  return {
    async cut(req: CutVideoRequest): Promise<CutVideoResponse> {
      const endpoint = getEndpointUrl()
      const body: Record<string, unknown> = {
        source_key: req.sourceKey,
        start_ms: req.startMs,
        end_ms: req.endMs,
        text: req.text,
        lang: req.lang,
        theme: req.theme,
      }
      if (req.videoId) body.video_id = req.videoId

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
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
