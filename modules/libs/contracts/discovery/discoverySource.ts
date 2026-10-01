import type { DiscoveryHit } from "./discoveryClient.js"

export interface DiscoverySourceInfo {
  readonly name: string
  readonly isYoutube: boolean
  readonly url?: string
}

/**
 * Resolves the display name and type (YouTube vs general web) for an external recording.
 */
export function resolveDiscoverySource(hit: DiscoveryHit): DiscoverySourceInfo {
  const targetUrl = hit.page_url || hit.media_url || ""
  let isYoutube = false
  if (
    targetUrl.includes("youtube.com") ||
    targetUrl.includes("youtu.be") ||
    Boolean(hit.source?.toLowerCase().includes("youtube"))
  ) {
    isYoutube = true
  }

  if (hit.source && hit.source.trim()) {
    return {
      name: hit.source.trim(),
      isYoutube,
      url: targetUrl || undefined,
    }
  }

  if (targetUrl) {
    try {
      const parsed = new URL(targetUrl)
      const host = parsed.hostname.replace(/^www\./, "")
      if (isYoutube) {
        return { name: "YouTube", isYoutube: true, url: targetUrl }
      }
      return { name: host, isYoutube: false, url: targetUrl }
    } catch {
      // Ignored: not a parseable absolute URL
    }
  }

  return {
    name: isYoutube ? "YouTube" : "Web",
    isYoutube,
    url: targetUrl || undefined,
  }
}
