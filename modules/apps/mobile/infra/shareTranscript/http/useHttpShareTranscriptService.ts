import type {
  IShareTranscriptService,
  RenderTranscriptRequest,
  RenderTranscriptResponse,
} from "@ports/app/index.js"

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

      const response = await fetch(`${base}/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        throw new Error(`share-transcript returned ${response.status} ${response.statusText}`)
      }
      const parsed = (await response.json()) as { url: string; ready: boolean }
      return { url: parsed.url, ready: parsed.ready }
    },
  }
}
