import type { CutExcerptRequest, CutExcerptResponse, IShareAudioService } from "@ports/app/index.js"
import { rebaseShareUrl, type PublicUrlOf } from "../../shareArtifactUrl.js"

/** A request to the active region's share-audio endpoint; `path` is relative to it. */
export type ShareAudioRequest = (path: string, init: RequestInit) => Promise<Response>

/**
 * `IShareAudioService` backed by an HTTP POST to the share-audio cutter of
 * the active region.
 *
 * The server answers fast: either 200 with `ready:true` (S3 cache hit on
 * the excerpt id) or 202 with `ready:false` after dispatching a
 * background worker. Either way the body carries the artifact URL, of
 * which only the object key is used (see `shareArtifactUrl`). Callers that
 * get `ready:false` poll the URL via `pollUntilReady`.
 *
 * The function is idempotent server-side on `excerpt_id`, so this
 * adapter is intentionally thin: no retries, no caching, no client-side
 * deduplication. Callers are expected to either reuse a stable id
 * (e.g. note id, chat-cite-<track>-<start>-<end>) or accept a
 * freshly-generated one.
 */
export function useHttpShareAudioService(
  request: ShareAudioRequest,
  publicUrlOf: PublicUrlOf
): IShareAudioService {
  return {
    async cut(req: CutExcerptRequest): Promise<CutExcerptResponse> {
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
        response = await request("", {
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

      // Callers skip the poll on `ready:true` and play the URL directly, so
      // an answer without a usable key is coerced to `ready:false`: the
      // caller then polls its own predicted URL.
      const url = rebaseShareUrl(parsed.url, publicUrlOf)
      const ready = parsed.ready === true && url.length > 0
      return {
        excerptId: parsed.excerpt_id,
        url,
        ready,
      }
    },

    async exists(url: string): Promise<boolean> {
      // Capped, or a half-open socket would hang the caller for the
      // platform's idle timeout.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4_000)
      try {
        const probe = await fetch(url, { method: "HEAD", signal: ctrl.signal })
        return probe.ok
      } catch {
        // A failed probe is a miss: the caller cuts, and the cut is
        // idempotent on the excerpt id.
        return false
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
