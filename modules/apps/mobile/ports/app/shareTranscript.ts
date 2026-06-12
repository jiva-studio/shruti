/**
 * Boundary for the share-transcript service — renders (or reuses a
 * cached) transcript PDF for one track and returns its public URL. Same
 * client-initiated shape as `IShareAudioService.cut`: the caller assembles
 * the cover metadata + the transcript S3 key, the service does the rest.
 *
 * The output format is a path segment on the service (`/pdf` today); the
 * adapter targets `${shareTranscriptUrl}/pdf`.
 */

export interface RenderTranscriptReference {
  readonly shortName?: string | null
  readonly fullName?: string | null
  readonly sourceId?: string | null
  readonly tokens?: string | null
}

export interface RenderTranscriptRequest {
  readonly trackId: string
  /** Transcript language (drives labels, outline, and the output key). */
  readonly lang: string
  /** Bucket key of the transcript JSON to render, e.g.
   *  `public/tracks/<id>/transcript.ru.json`. */
  readonly transcriptKey: string
  // Cover metadata — all optional; the renderer degrades to id-only.
  readonly title?: string | null
  readonly author?: string | null
  readonly date?: string | null
  readonly location?: string | null
  readonly references?: readonly RenderTranscriptReference[]
  readonly tags?: readonly string[]
}

export interface RenderTranscriptResponse {
  /** Public URL of the produced PDF. */
  readonly url: string
  readonly ready: boolean
}

export interface IShareTranscriptService {
  renderPdf(req: RenderTranscriptRequest): Promise<RenderTranscriptResponse>
}
