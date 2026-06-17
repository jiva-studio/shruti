import type {
  IShareTranscriptService,
  RenderTranscriptRequest,
  RenderTranscriptResponse,
} from "@ports/app/index.js"

/** True iff `url` is a non-empty absolute http(s) URL. */
function isAbsoluteHttpUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\/\S+/i.test(url)
}

/**
 * HTTP adapter over the share-transcript service. `getBaseUrl` resolves
 * the per-region base (`${host}/share/transcripts`) at call time, so a
 * settings region flip routes subsequent renders to the new region.
 * Anonymous like share-audio — Caddy's per-IP rate-limit is the fence.
 */
export function useHttpShareTranscriptService(getBaseUrl: () => string): IShareTranscriptService {
  return {
    async renderPdf(req: RenderTranscriptRequest): Promise<RenderTranscriptResponse> {
      const base = getBaseUrl().replace(/\/+$/, "")
      const body: Record<string, unknown> = {
        track_id: req.trackId,
        lang: req.lang,
        transcript_key: req.transcriptKey,
      }
      if (req.title != null) body.title = req.title
      if (req.author != null) body.author_name = req.author
      if (req.date != null) body.date = req.date
      if (req.location != null) body.location_name = req.location
      if (req.references && req.references.length > 0) {
        body.references = req.references.map((r) => ({
          short_name: r.shortName ?? null,
          full_name: r.fullName ?? null,
          source_id: r.sourceId ?? null,
          tokens: r.tokens ?? null,
        }))
      }
      if (req.tags && req.tags.length > 0) body.tags = req.tags
      if (req.outline && req.outline.length > 0) {
        body.outline = req.outline.map((ch) => ({
          title: ch.title,
          start: ch.startMs,
          end: ch.endMs,
        }))
      }

      // Mobile platforms abort idle fetches around 60-100 s by default —
      // cap at 8 s with our own AbortController so a slow handler doesn't
      // masquerade as a multi-minute network hang. If we abort, fall
      // through to `ready:false`: the caller polls the predicted URL.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8_000)
      let response: Response
      try {
        response = await fetch(`${base}/pdf`, {
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
          return { url: "", ready: false }
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        throw new Error(`share-transcript returned ${response.status} ${response.statusText}`)
      }
      const parsed = (await response.json()) as { url: string; ready: boolean }

      // Guard against a `ready:true` with a dead/empty URL (e.g. server
      // with an unset public base). Coerce to `ready:false` so the caller
      // polls its predicted URL instead of feeding a 404 to the viewer.
      const url = isAbsoluteHttpUrl(parsed.url) ? parsed.url : ""
      const ready = parsed.ready === true && url.length > 0
      return { url, ready }
    },
  }
}
