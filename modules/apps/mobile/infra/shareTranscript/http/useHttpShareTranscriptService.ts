import type {
  IShareTranscriptService,
  RenderTranscriptRequest,
  RenderTranscriptResponse,
} from "@ports/app/index.js"

/** True iff `url` is a non-empty absolute http(s) URL. */
function isAbsoluteHttpUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\/\S+/i.test(url)
}

/** The cover's scalar metadata, each field sent only when the caller knows it. */
const COVER_FIELDS = [
  ["title", "title"],
  ["author", "author_name"],
  ["date", "date"],
  ["location", "location_name"],
] as const

function coverFields(req: RenderTranscriptRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [from, to] of COVER_FIELDS) {
    if (req[from] != null) out[to] = req[from]
  }
  return out
}

/** The structured lists, omitted rather than sent empty. */
function listFields(req: RenderTranscriptRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (req.references?.length) {
    out.references = req.references.map((r) => ({
      short_name: r.shortName ?? null,
      full_name: r.fullName ?? null,
      source_id: r.sourceId ?? null,
      tokens: r.tokens ?? null,
    }))
  }
  if (req.tags?.length) out.tags = req.tags
  if (req.outline?.length) {
    out.outline = req.outline.map((ch) => ({ title: ch.title, start: ch.startMs, end: ch.endMs }))
  }
  return out
}

function buildRenderBody(req: RenderTranscriptRequest): Record<string, unknown> {
  return {
    track_id: req.trackId,
    lang: req.lang,
    transcript_key: req.transcriptKey,
    ...coverFields(req),
    ...listFields(req),
  }
}

/** A `ready:true` with a dead or empty URL (a server with an unset public
 *  base) is coerced to `ready:false`, so the caller polls its predicted URL
 *  instead of feeding a 404 to the viewer. */
function readRenderResponse(parsed: { url: unknown; ready: unknown }): RenderTranscriptResponse {
  const url = isAbsoluteHttpUrl(parsed.url) ? parsed.url : ""
  return { url, ready: parsed.ready === true && url.length > 0 }
}

/**
 * HTTP adapter over the share-transcript service. `getBaseUrl` resolves the
 * per-region base (`${host}/share/transcripts`) at call time, so a settings
 * region flip routes subsequent renders to the new region. Anonymous like
 * share-audio — Caddy's per-IP rate limit is the fence.
 */
export function useHttpShareTranscriptService(getBaseUrl: () => string): IShareTranscriptService {
  return {
    async renderPdf(req: RenderTranscriptRequest): Promise<RenderTranscriptResponse> {
      const base = getBaseUrl().replace(/\/+$/, "")

      // Mobile platforms abort idle fetches around 60-100s, so an 8s cap of
      // our own keeps a slow handler from masquerading as a multi-minute
      // network hang. On abort we fall through to `ready:false` — the caller
      // polls the predicted URL.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8_000)
      let response: Response
      try {
        response = await fetch(`${base}/pdf`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildRenderBody(req)),
          signal: ctrl.signal,
        })
      } catch (err: unknown) {
        // Detect our own timeout via the signal, not the rejection value:
        // `fetch` surfaces an abort as a DOMException in browsers but as a
        // bare value on some runtimes, so `err.name` is not reliable.
        if (ctrl.signal.aborted) return { url: "", ready: false }
        throw err
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        throw new Error(`share-transcript returned ${response.status} ${response.statusText}`)
      }
      return readRenderResponse((await response.json()) as { url: unknown; ready: unknown })
    },
  }
}
