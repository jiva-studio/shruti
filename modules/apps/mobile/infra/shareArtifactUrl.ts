/**
 * Share services answer with an absolute URL on whichever storage host they
 * upload to, which is not necessarily one this device can reach. Only the
 * object key is taken from it; the URL the app uses is built from the active
 * region's storage.
 */

/** Builds a public URL for an object key on the active region's storage. */
export type PublicUrlOf = (key: string) => string

/**
 * The object key of a share artifact URL: its path from the first `public/`
 * segment on, whatever host or bucket prefix precedes it. Null for anything
 * that is not an absolute http(s) URL carrying such a segment.
 */
export function extractShareKey(url: unknown): string | null {
  if (typeof url !== "string" || !/^https?:\/\/\S+/i.test(url)) return null
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const at = pathname.indexOf("/public/")
  return at < 0 ? null : pathname.slice(at + 1)
}

/** The artifact URL on the active region, or `""` when the answer has no key. */
export function rebaseShareUrl(url: unknown, publicUrlOf: PublicUrlOf): string {
  const key = extractShareKey(url)
  return key === null ? "" : publicUrlOf(key)
}
