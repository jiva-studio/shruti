const YT_ID = /(?:youtube\.com\/(?:watch\?[^\s]*\bv=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i

/**
 * The key two source URLs are considered the same lecture under. A YouTube link
 * collapses to its video id, so a watch url, a share link and a Shorts url all
 * address one library item; anything else is matched as the trimmed url.
 */
export function normalizeSource(url: string): string {
  const m = YT_ID.exec(url)
  return m ? `yt:${m[1]}` : url.trim()
}
