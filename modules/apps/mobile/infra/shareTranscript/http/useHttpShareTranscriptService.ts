import type {
  IShareTranscriptService,
  RenderTranscriptRequest,
  RenderTranscriptResponse,
} from "@ports/app/index.js"
import { rebaseShareUrl, type PublicUrlOf } from "../../shareArtifactUrl.js"

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

/** A request to the active region's share-transcript base; `path` is relative to it. */
export type ShareTranscriptRequest = (path: string, init: RequestInit) => Promise<Response>

/**
 * HTTP adapter over the share-transcript service of the active region.
 * Anonymous like share-audio — Caddy's per-IP rate limit is the fence.
 */
export function useHttpShareTranscriptService(
  request: ShareTranscriptRequest,
  publicUrlOf: PublicUrlOf
): IShareTranscriptService {
  return {
    async renderPdf(req: RenderTranscriptRequest): Promise<RenderTranscriptResponse> {
      // Mobile platforms abort idle fetches around 60-100s, so an 8s cap of
      // our own keeps a slow handler from masquerading as a multi-minute
      // network hang. On abort we fall through to `ready:false` — the caller
      // polls the predicted URL.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8_000)
      let response: Response
      try {
        response = await request("/pdf", {
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
      const parsed = (await response.json()) as { url: unknown; ready: unknown }
      // An answer without a usable key is coerced to `ready:false`, so the
      // caller polls its own predicted URL instead of opening a dead one.
      const url = rebaseShareUrl(parsed.url, publicUrlOf)
      return { url, ready: parsed.ready === true && url.length > 0 }
    },
  }
}
