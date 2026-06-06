import { probeServers } from "@kit/servers"
import type { CdnServer } from "@lib/domain/servers.js"
import type { IServerProber } from "@ports/app/index.js"

/**
 * HTTP-backed `IServerProber`, delegating the race/pick-first-responder
 * mechanism to kit's generic `probeServers`. Tries each CDN server
 * (preferred first), returning the first that responds with valid JSON for
 * `configPath` plus the parsed body (which is the remote config — reused by
 * the Welcome flow so the successful probe doubles as the config download).
 *
 * `getServers` is injected by the composition root (it reads the runtime
 * region registry) — infra must not reach into the app layer itself.
 */
export function useHttpServerProber(
  getServers: () => readonly CdnServer[],
  timeoutMs = 8000
): IServerProber {
  return {
    probe(configPath, preferredServerId) {
      return probeServers<CdnServer>(getServers(), {
        configPath,
        preferredServerId,
        timeoutMs,
      })
    },
  }
}
