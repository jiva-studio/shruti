/**
 * Keys that address a shared artifact (cache filename + render id).
 *
 * `resolveShareArtifact` returns a local cache hit before it probes or
 * renders anything — correctly, since a hit is by definition the same
 * artifact. That makes the key the whole contract: everything that makes
 * two artifacts different has to appear in it, or the previous file is
 * shared forever. Keeping the derivations pure and together is what makes
 * that reviewable.
 */

// Anything outside the share-video `video_id` alphabet
// (`^[A-Za-z0-9_-]{1,64}$`) is also unsafe in a cache filename.
const UNSAFE = /[^A-Za-z0-9_-]+/g

function slug(value: string): string {
  return value.replace(UNSAFE, "-")
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Cache key for a rendered transcript PDF. A PDF is per (track, language)
 * — the display title is neither unique across two languages of one
 * lecture (a single variant makes both titles identical) nor across two
 * undated lectures that share a name. The pretty title stays the share
 * sheet's display name; it never keys the cache.
 */
export function transcriptPdfCacheKey(trackId: string, lang: string): string {
  return `transcript-${slug(trackId)}-${slug(lang)}.pdf`
}

export type StudioVideoSubject =
  | { readonly kind: "note"; readonly noteId: string }
  | {
      readonly kind: "citation"
      readonly trackId: string
      readonly startMs: number
      readonly endMs: number
    }

export interface StudioVideoContent {
  /** Trimmed quote text as it will be rendered. */
  readonly text: string
  /** Trimmed title-card text; empty string means "no title card". */
  readonly title: string
}

export interface StudioVideoArtifact {
  /** Opaque idempotency key: the share-video service uses it as both the
   *  S3 key and the request dedupe key, so it must be deterministic in
   *  everything the render depends on and match `[A-Za-z0-9_-]{1,64}`. */
  readonly videoId: string
  /** Flat local cache filename for the same artifact. */
  readonly filename: string
}

// 40 + `_` + 12 leaves the id well inside the service's 64-char limit.
const SUBJECT_MAX = 40
const CONTENT_HASH_LEN = 12
const LOCATION_HASH_LEN = 28

/**
 * Render id + cache filename for a Studio video. The caption and the
 * title card are what the screen exists to edit, so they belong in the
 * key: an edit addresses a different artifact, and reverting the edit
 * hits the original cache entry again.
 */
export async function studioVideoArtifact(
  subject: StudioVideoSubject,
  content: StudioVideoContent
): Promise<StudioVideoArtifact> {
  // JSON-encoded pair, so moving a word between the caption and the
  // title can't collapse to the same hash.
  const contentHash = (await sha256Hex(JSON.stringify([content.text, content.title]))).slice(
    0,
    CONTENT_HASH_LEN
  )
  const base =
    subject.kind === "note"
      ? slug(subject.noteId).slice(0, SUBJECT_MAX)
      : `cit_${(await sha256Hex(`${subject.trackId}|${subject.startMs}|${subject.endMs}`)).slice(
          0,
          LOCATION_HASH_LEN
        )}`
  const videoId = `${base}_${contentHash}`
  return { videoId, filename: `share-video-${videoId}.mp4` }
}
