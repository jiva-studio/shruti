import type { IRemoteFilesStorage } from "@kit/infra"

/**
 * Warm the on-device image cache for URLs that will be rendered soon (e.g. the
 * Search landing's collection / topic covers), so they appear instantly on
 * first render instead of placeholder → fade-in.
 *
 * Runs gently in the background: a small concurrency, skips entries that are
 * already cached (`has()`), and never throws — a cover that fails to prewarm
 * just falls back to loading on render. On web `get()` mints a fresh `blob:`
 * URL even though we only want the bytes in CacheStorage, so we revoke it
 * immediately to avoid leaking object URLs; on native `get()` returns a
 * `file://` path with nothing to revoke.
 */
export async function prewarmImageCache(
  filesStorage: IRemoteFilesStorage,
  urls: Iterable<string | undefined>,
  concurrency = 3
): Promise<void> {
  const queue = [...new Set([...urls].filter((u): u is string => !!u))]
  let next = 0

  async function worker(): Promise<void> {
    while (next < queue.length) {
      const url = queue[next++]
      try {
        if (await filesStorage.has(url)) continue
        const local = await filesStorage.get(url)
        if (local.startsWith("blob:")) URL.revokeObjectURL(local)
      } catch {
        // Best-effort: a cover that fails here loads normally on render.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
}
