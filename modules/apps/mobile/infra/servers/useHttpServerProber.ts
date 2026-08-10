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
 *
 * Deliberately passes no `timeoutMs` / `hedgeDelayMs`: the probe budget and
 * the hedge schedule are properties of the probe protocol (a ~3 KB JSON off
 * the CDN), which kit owns end to end. This file used to pin 8000 ms, which
 * is exactly why kit's move to a 2500 ms default plus hedging changed nothing
 * for the app. Restating any number here — even today's — would re-arm the
 * same trap for the next tuning pass.
 */
export function useHttpServerProber(getServers: () => readonly CdnServer[]): IServerProber {
  return {
    probe(configPath, preferredServerId) {
      return probeServers<CdnServer>(getServers(), { configPath, preferredServerId })
    },
  }
}
