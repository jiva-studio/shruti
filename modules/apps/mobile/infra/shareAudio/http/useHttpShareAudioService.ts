import type { CutExcerptRequest, CutExcerptResponse, IShareAudioService } from "@ports/app/index.js"

/** True iff `url` is a non-empty absolute http(s) URL. */
function isAbsoluteHttpUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\/\S+/i.test(url)
}

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

      // Mobile platforms abort idle fetches around 60-100 s by default —
      // cap at 8 s with our own AbortController so a slow handler doesn't
      // masquerade as a multi-minute network hang. If we abort, fall
      // through to `ready:false`: the caller polls the predicted URL and
      // the server keeps its idempotent (on `excerpt_id`) work.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8_000)
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
      } catch (err: unknown) {
        // Detect our own timeout via the signal rather than the rejection
        // value: `fetch` surfaces an abort as a DOMException in browsers
        // but as a bare value on some runtimes, so `err.name` is not
        // reliable. `signal.aborted` is the one thing we control.
        if (ctrl.signal.aborted) {
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

      // Guard against a `ready:true` with a dead/empty URL — happens when
      // the server has an unset `SHRUTI_S3_PUBLIC_BASE` and emits a
      // bogus URL. Callers skip the poll guard on `ready:true` and feed
      // the URL straight to <audio>, so a falsy/relative URL there is a
      // silent 404 with no retry. Coerce to `ready:false` so the caller
      // falls back to its predicted URL and polls it.
      const url = isAbsoluteHttpUrl(parsed.url) ? parsed.url : ""
      const ready = parsed.ready === true && url.length > 0
      return {
        excerptId: parsed.excerpt_id,
        url,
        ready,
      }
    },
  }
}
