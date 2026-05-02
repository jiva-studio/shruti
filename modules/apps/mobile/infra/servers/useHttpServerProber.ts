import { buildServerUrl, SERVERS, type CdnServer } from "@lib/domain/servers.js"

export interface ServerProbeResult {
  server: CdnServer
  config: unknown
}

/**
 * Tries each CDN server sequentially, attempting to fetch `configPath`.
 * Returns the first server that responds with valid JSON, plus the parsed
 * response (which is the remote config — reused by the Welcome flow so
 * the successful probe doubles as the config download).
 *
 * @param configPath  Relative path to the remote config, e.g. "public/config.json"
 * @param preferredServerId  Id of the server to try first (from user prefs)
 * @param timeoutMs  Per-server fetch timeout (default 8 000 ms)
 */
export async function probeServers(
  configPath: string,
  preferredServerId?: string,
  timeoutMs = 8000
): Promise<ServerProbeResult> {
  const ordered = buildOrderedList(preferredServerId)

  for (const server of ordered) {
    const url = buildServerUrl(server, configPath)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const response = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (!response.ok) continue
      const config: unknown = await response.json()
      return { server, config }
    } catch {
      continue
    }
  }

  throw new Error("All CDN servers are unreachable")
}

function buildOrderedList(preferredServerId?: string): CdnServer[] {
  if (!preferredServerId) return [...SERVERS]
  const preferred = SERVERS.find((s) => s.id === preferredServerId)
  if (!preferred) return [...SERVERS]
  return [preferred, ...SERVERS.filter((s) => s.id !== preferredServerId)]
}
