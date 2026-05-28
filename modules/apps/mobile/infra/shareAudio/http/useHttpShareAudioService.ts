import type { CutExcerptRequest, CutExcerptResponse, IShareAudioService } from "@ports/app/index.js"

/**
 * `IShareAudioService` backed by a plain HTTP POST to the per-region
 * share-audio cutter (AWS Lambda HTTP API for `global`, Yandex Cloud
 * Function for `russia`). The endpoint URL is resolved lazily via
 * `getEndpointUrl` so a change in the active server (settings flip)
 * routes subsequent calls to the new region without rebuilding the
 * service.
 *
 * The server answers fast: either 200 with `ready:true` (S3 cache hit on
 * the excerpt id) or 202 with `ready:false` after dispatching a
 * background worker. Either way the body carries the predicted URL.
 * Callers that get `ready:false` poll the URL via `pollUntilReady`.
 *
 * The function is idempotent server-side on `excerpt_id`, so this
 * adapter is intentionally thin: no retries, no caching, no client-side
 * deduplication. Callers are expected to either reuse a stable id
 * (e.g. note id, chat-cite-<track>-<start>-<end>) or accept a
 * freshly-generated one.
 */
export function useHttpShareAudioService(getEndpointUrl: () => string): IShareAudioService {
  return {
    async cut(req: CutExcerptRequest): Promise<CutExcerptResponse> {
      const endpoint = getEndpointUrl()
      const body: Record<string, unknown> = {
        source_key: req.sourceKey,
        start_ms: req.startMs,
        end_ms: req.endMs,
      }
      if (req.excerptId) body.excerpt_id = req.excerptId

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        throw new Error(`share-audio cutter returned ${response.status} ${response.statusText}`)
      }
      const parsed = (await response.json()) as {
        excerpt_id: string
        url: string
        ready: boolean
      }
      return {
        excerptId: parsed.excerpt_id,
        url: parsed.url,
        ready: parsed.ready,
      }
    },
  }
}
