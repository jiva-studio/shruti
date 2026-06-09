/**
 * Port for the per-note excerpt cache used by the Notes share workflow.
 * Hides the Capacitor Filesystem + HEAD-probe choreography from the
 * view layer; implementations live under `@infra/excerptCache/`.
 *
 * Two reads, one write:
 *  - {@link findLocal}: cheap stat against the platform cache.
 *  - {@link probeRemote}: HEAD on a CDN URL with a hard timeout — used
 *    to skip the server-side cut when a previous user already rendered
 *    the same excerpt and the CDN still has it.
 *  - {@link download}: pull the remote bytes into the cache, return the
 *    canonical file URI the share sheet (or any `<audio src>`) can use.
 */
export interface IExcerptCache {
  /**
   * Return a `file://` URI for a cached excerpt whose canonical name
   * matches `filename` (e.g. `share-audio-note-<id>.mp3`). Resolves to
   * `null` when the file isn't in the cache.
   */
  findLocal(filename: string): Promise<string | null>

  /**
   * HEAD-probe a public URL within a strict timeout. Returns `true`
   * when the CDN has the file and `false` for miss / timeout / network
   * error. Never throws.
   */
  probeRemote(url: string, timeoutMs?: number): Promise<boolean>

  /**
   * Download a remote URL into the platform cache under `filename` and
   * return the canonical `file://` URI of the cached copy.
   */
  download(args: { url: string; filename: string }): Promise<string>

  /**
   * Turn a cached `file://` URI (from {@link findLocal} / {@link download})
   * into a local URL the WebView can actually load in `<audio src>` /
   * `<img src>`. The native WebView rejects a raw `file://` ("Not allowed
   * to load local resource"); the adapter rewrites it to the local
   * app-server URL. Identity on web. The `file://` form stays the one used
   * by the native share sheet — this is only for in-WebView reads.
   */
  toLocalUrl(fileUri: string): string
}
