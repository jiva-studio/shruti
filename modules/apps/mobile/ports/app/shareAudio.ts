/**
 * Port over the cloud-side share-audio cutter (AWS Lambda or YC Cloud
 * Function — picked per the active CDN region). Given a source MP3 key
 * already in the bucket and a `[startMs, endMs]` window, the service
 * returns the public URL of the produced excerpt. Idempotent on
 * `excerptId`.
 */
export interface CutExcerptRequest {
  /** Full bucket key of the source MP3, e.g. `public/tracks/xxx/audio/original.mp3`. */
  readonly sourceKey: string
  readonly startMs: number
  readonly endMs: number
  /** Stable id for idempotency. If omitted, the service generates one. */
  readonly excerptId?: string
}

export interface CutExcerptResponse {
  readonly excerptId: string
  /** Public URL of the produced excerpt mp3. */
  readonly url: string
  readonly ready: boolean
}

export interface IShareAudioService {
  cut(req: CutExcerptRequest): Promise<CutExcerptResponse>
}
