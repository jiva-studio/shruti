/**
 * Generic remote-config loader MECHANISM. Fetches a config URL, parses the
 * JSON body into `T`, and (optionally) caches the parsed value with a
 * staleness window so repeated reads within the window reuse the in-memory
 * copy instead of re-fetching.
 *
 * Deliberately schema-agnostic: kit knows nothing about what's inside the
 * config. Apps supply the URL (or a lazy getter), an optional `parse`/
 * validate step over the raw JSON, and the `T` shape. No framework, no
 * domain, no app fields.
 */

export interface ConfigLoaderOptions<T> {
  /** The config URL, or a lazy getter read at each (uncached) fetch so a
   *  runtime change of endpoint takes effect without rebuilding the loader. */
  url: string | (() => string)
  /**
   * Validate / transform the raw parsed JSON into `T`. Throw to reject an
   * invalid payload (the rejection propagates out of `load`). Defaults to an
   * unchecked cast.
   */
  parse?: (raw: unknown) => T
  /**
   * How long (ms) a successfully-loaded value stays fresh. Within the
   * window, `load()` returns the cached value without fetching. `0`
   * (default) disables caching — every `load()` fetches.
   */
  staleAfterMs?: number
  /** Extra fetch options (headers, credentials, signal, …) merged into the
   *  request. */
  fetchInit?: RequestInit
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
}

export interface ConfigLoader<T> {
  /**
   * Return the config. Serves a fresh cached value when one is available
   * (and `staleAfterMs > 0`); otherwise fetches, parses, caches, and
   * returns. Concurrent calls during an in-flight fetch share that fetch.
   */
  load(): Promise<T>
  /** Force a network fetch, bypassing and refreshing the cache. */
  refresh(): Promise<T>
  /** Last cached value, or `undefined` if never loaded / expired-and-cleared. */
  peek(): T | undefined
  /** Drop any cached value so the next `load()` fetches. */
  invalidate(): void
}

export function createConfigLoader<T>(opts: ConfigLoaderOptions<T>): ConfigLoader<T> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const staleAfterMs = opts.staleAfterMs ?? 0
  const parse = opts.parse ?? ((raw: unknown) => raw as T)

  let cached: T | undefined
  let cachedAt = -1
  let inFlight: Promise<T> | null = null

  function resolveUrl(): string {
    return typeof opts.url === "function" ? opts.url() : opts.url
  }

  function isFresh(): boolean {
    return staleAfterMs > 0 && cachedAt !== -1 && now() - cachedAt < staleAfterMs
  }

  async function fetchAndParse(): Promise<T> {
    const response = await fetchImpl(resolveUrl(), opts.fetchInit)
    if (!response.ok) {
      throw new Error(`config: HTTP ${response.status}`)
    }
    const raw: unknown = await response.json()
    const value = parse(raw)
    cached = value
    cachedAt = now()
    return value
  }

  function refresh(): Promise<T> {
    // Coalesce concurrent fetches into a single in-flight request.
    if (inFlight) return inFlight
    inFlight = fetchAndParse().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function load(): Promise<T> {
    if (isFresh()) return cached as T
    return refresh()
  }

  return {
    load,
    refresh,
    peek: () => cached,
    invalidate: () => {
      cached = undefined
      cachedAt = -1
    },
  }
}
