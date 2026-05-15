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

      // The cut is "tell the server to start rendering". On AWS the response
      // comes back in ~1 s with `ready: false`; on YC the server holds the
      // response open for ~120 s while it renders inline. Mobile platforms
      // (Capacitor / Android OkHttp) abort idle fetches around 60-100 s by
      // default — that surfaces a misleading network error even though the
      // server is still working and will eventually upload the file.
      //
      // Cap the cut at 8 s with our own AbortController. If it returns by
      // then, surface real 4xx/5xx normally. If not, abort the connection
      // and report `ready:false` — the caller polls the predicted URL
      // anyway, so the abandoned cut request doesn't matter (the server
      // keeps rendering and uploads when done).
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
          return { videoId: req.videoId ?? "", url: "", ready: false }
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
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
