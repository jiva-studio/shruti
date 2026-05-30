import { buildServerUrl, type CdnServer } from "@lib/domain/servers.js"
import type { IServerProber, ServerProbeResult } from "@ports/app/index.js"

/**
 * HTTP-backed `IServerProber`. Tries each CDN server sequentially,
 * returning the first that responds with valid JSON for `configPath`,
 * plus the parsed body (which is the remote config — reused by the
 * Welcome flow so the successful probe doubles as the config download).
 *
 * `getServers` is injected by the composition root (it reads the runtime
 * region registry) — infra must not reach into the app layer itself.
 */
export function useHttpServerProber(
  getServers: () => readonly CdnServer[],
  timeoutMs = 8000
): IServerProber {
  return {
    async probe(configPath, preferredServerId) {
      const ordered = buildOrderedList(getServers(), preferredServerId)

      for (const server of ordered) {
        const url = buildServerUrl(server, configPath)
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          const response = await fetch(url, { signal: controller.signal })
          clearTimeout(timer)
          if (!response.ok) continue
          const config: unknown = await response.json()
          return { serverId: server.id, config } satisfies ServerProbeResult
        } catch {
          continue
        }
      }

      throw new Error("All CDN servers are unreachable")
    },
  }
}

function buildOrderedList(servers: readonly CdnServer[], preferredServerId?: string): CdnServer[] {
  if (!preferredServerId) return [...servers]
  const preferred = servers.find((s) => s.id === preferredServerId)
  if (!preferred) return [...servers]
  return [preferred, ...servers.filter((s) => s.id !== preferredServerId)]
}
