/**
 * Generic descriptor for a remote content server / endpoint. Apps probe a
 * list of these at startup and pick the first reachable one, then build
 * per-resource URLs from the chosen entry's `urlTemplate`.
 *
 * This is the minimal, framework- and domain-agnostic shape. Apps that need
 * extra per-server fields (auth/chat/share base URLs, regions, etc.) should
 * declare their own interface that EXTENDS this one — kit deliberately keeps
 * only the universal fields here.
 */
export interface CdnServer {
  /** Stable identifier, used to remember the preferred/active server. */
  readonly id: string
  /** Human-readable label (e.g. for a settings picker). */
  readonly name: string
  /**
   * URL template containing a single `{path}` placeholder. `buildServerUrl`
   * substitutes the placeholder with a concrete resource path.
   */
  readonly urlTemplate: string
}

/**
 * Substitute `{path}` in a server's `urlTemplate` with a concrete path.
 * Keeps the "templates carry the host, paths are full keys" rule in one
 * place so every URL is assembled the same way.
 */
export function buildServerUrl(server: Pick<CdnServer, "urlTemplate">, path: string): string {
  return server.urlTemplate.replace("{path}", path)
}

/**
 * Join a base URL and a path with exactly one slash between them. Tolerates
 * either/both sides carrying a slash, and returns the base unchanged when
 * `path` is empty.
 */
export function joinUrl(base: string, path: string): string {
  if (!path) return base
  if (base.endsWith("/") && path.startsWith("/")) return base + path.slice(1)
  if (!base.endsWith("/") && !path.startsWith("/")) return `${base}/${path}`
  return base + path
}
