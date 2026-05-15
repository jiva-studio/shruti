import type { CutExcerptRequest, CutExcerptResponse, IShareAudioService } from "@ports/app/index.js"

/**
 * `IShareAudioService` backed by a plain HTTP POST to the per-region
 * share-audio cutter (AWS Lambda HTTP API for `global`, Yandex Cloud
 * Function for `russia`). The endpoint URL is resolved lazily via
 * `getEndpointUrl` so a change in the active server (settings flip)
 * routes subsequent calls to the new region without rebuilding the
 * service.
 *
 * The function is already idempotent server-side on `excerpt_id`, so
 * this adapter is intentionally thin: no retries, no caching, no
 * client-side deduplication. Callers are expected to either reuse a
 * stable id (e.g. note id) or accept a freshly-generated one.
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

      // Cap the cut at 8 s with our own AbortController. share-audio is
      // sync stream-copy and almost always returns in <1 s — the abort
      // path basically never fires in practice — but the share-video
      // service uses the same pattern (see useHttpShareVideoService.ts
      // for full reasoning) and consistency keeps the controller's
      // workflow helper provider-agnostic. If the abort fires, return
      // {ready:false}; the caller polls the predicted URL.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort("cut-timeout-fall-through-to-poll"), 8_000)
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
      } catch (err: unknown) {
        if ((err as DOMException | undefined)?.name === "AbortError") {
          return { excerptId: req.excerptId ?? "", url: "", ready: false }
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
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
