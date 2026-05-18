/**
 * Port over the cloud-side share-video reel renderer (AWS Lambda or YC
 * Cloud Function — picked per the active CDN region). Given a source MP3
 * key, a `[startMs, endMs]` window, the caller's clean transcript, the
 * audio language and a background-pack theme, the service renders a 9:16
 * MP4 reel (Whisper word-level highlight, themed background, app logo at
 * the end), uploads it to `public/share/video/<videoId>.mp4`, and returns
 * the public URL. Idempotent on `videoId`.
 *
 * Sync request/response, mirrors share-audio in shape.
 */
export interface CutVideoRequest {
  /** Full bucket key of the source MP3, e.g. `public/tracks/xxx/audio/original.mp3`. */
  readonly sourceKey: string
  readonly startMs: number
  readonly endMs: number
  /** Exact transcript of the audio fragment (caller-cleaned, with punctuation). */
  readonly text: string
  /** ISO-639-1 language code (e.g. "ru", "en"). Forwarded to Whisper as the language hint. */
  readonly lang: string
  /** Background-pack identifier. Currently only "prabhupada" is provisioned. */
  readonly theme: string
  /** Stable id for idempotency. If omitted, the service generates one. */
  readonly videoId?: string
  /**
   * Optional title shown as a cream-coloured title-card overlay during the
   * first ~0.5s of the reel. Empty / undefined → no title card.
   */
  readonly title?: string
}

export interface CutVideoResponse {
  readonly videoId: string
  /** Public URL of the produced reel mp4. */
  readonly url: string
  readonly ready: boolean
}

export interface IShareVideoService {
  cut(req: CutVideoRequest): Promise<CutVideoResponse>
}
