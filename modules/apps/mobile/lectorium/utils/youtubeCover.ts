/**
 * The cover for a recording that lives on YouTube, worked out from its address.
 *
 * The index stores no image. It does not need to: a YouTube video id is enough
 * to name its poster, and every other archive is a file on a web server with no
 * poster to name. So "does this hit have a picture" is the same question as
 * "is this hit on YouTube", and both are answered here rather than by a column
 * that would have to be crawled, stored and kept fresh.
 *
 * `hqdefault` is the size that always exists. The higher ones (`maxresdefault`)
 * are absent for plenty of older uploads and 404 into a broken image.
 */
const YOUTUBE_ID = new RegExp(
  "(?:youtube\\.com/(?:watch\\?[^\\s]*\\bv=|shorts/|live/|embed/)|youtu\\.be/)([\\w-]{11})",
  "i"
)

/** The 11-character video id in a YouTube address, or null for anything else. */
export function youtubeVideoId(url: string | undefined): string | null {
  if (!url) return null
  const m = YOUTUBE_ID.exec(url)
  return m ? (m[1] ?? null) : null
}

/**
 * Poster URL for the first of the given addresses that is a YouTube one, or
 * null when none is.
 *
 * A hit carries both the media address and the page it was found on, and either
 * can be the YouTube one — a channel crawl yields the watch URL as the media,
 * while a site embedding a video yields its own page and the embed underneath.
 */
export function youtubeCoverUrl(...urls: readonly (string | undefined)[]): string | null {
  for (const url of urls) {
    const id = youtubeVideoId(url)
    if (id) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  }
  return null
}
