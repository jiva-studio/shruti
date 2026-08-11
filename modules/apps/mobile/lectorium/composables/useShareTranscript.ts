import type { RenderTranscriptRequest } from "@ports/app/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { resolveShareArtifact } from "@lectorium/services/resolveShareArtifact.js"
import { transcriptPdfCacheKey } from "@lectorium/services/shareArtifactKeys.js"
import { SHORT_POLL_TIMEOUT_MS } from "@lib/chat/utils/pollUntilReady.js"

export interface UseShareTranscriptReturn {
  /**
   * Render (or reuse a cached) transcript PDF on the share-transcript
   * service and return a local `file://` URI ready for the share sheet.
   * Goes through `resolveShareArtifact`, so a warm CDN copy is downloaded
   * without ever calling the service. Shared by the Library share menu and
   * the chat share card.
   */
  prepareLocalPdf: (req: RenderTranscriptRequest) => Promise<string>
}

export function useShareTranscript(): UseShareTranscriptReturn {
  const app = useLectorium()

  async function prepareLocalPdf(req: RenderTranscriptRequest): Promise<string> {
    // The PDF lands at a deterministic public key; probing it lets a warm
    // copy skip the render call entirely. The service writes to (and the
    // CDN serves) this exact URL, so probe + download target the same one.
    const predictedUrl = app.storagePublicUrl.get(
      `public/tracks/${req.trackId}/exports/${req.lang}.pdf`
    )
    return resolveShareArtifact({
      cache: app.excerptCache,
      // Keyed like the public URL — by track and language, never by the
      // display title, which two languages of one lecture can share.
      filename: transcriptPdfCacheKey(req.trackId, req.lang),
      predictedUrl,
      cut: () => app.shareTranscriptService.renderPdf(req),
      // A transcript PDF renders in seconds; a dead URL must fail fast
      // rather than spin toward the 8-min Studio-video default.
      pollTimeoutMs: SHORT_POLL_TIMEOUT_MS,
    })
  }

  return { prepareLocalPdf }
}
