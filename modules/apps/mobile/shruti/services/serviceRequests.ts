import { Device } from "@capacitor/device"
import type { FailoverRequestInit } from "@kit/servers"
import type { CdnServer } from "@lib/domain/servers.js"
import { useShruti } from "@shruti/shruti.js"
import { getRegions } from "@shruti/services/regionsRegistry.js"
import {
  createRegionFailoverClient,
  isReplayableAuthPath,
  withCrossServerReplay,
} from "@shruti/services/regionFailover.js"
import { withNetworkErrorContext } from "@shruti/services/http/networkError.js"
import { createUnauthorizedRetry } from "@shruti/services/http/unauthorizedRetry.js"
import { isChatStreamPath, withRequestTimeout } from "@shruti/services/http/requestTimeout.js"

/**
 * One decorated request function per backend, built together so they share a
 * single 401 interceptor: N simultaneous 401s collapse into one
 * `/auth/refresh` instead of one per client.
 *
 * `withRequestTimeout` sits innermost, on the raw failover call, so the budget
 * bounds ONE socket rather than a refresh plus its replay.
 */
export function createServiceRequests() {
  // Two failover-aware HTTP clients — one for the auth service, one for
  // chat. Both walk the runtime region list (regionsRegistry) in
  // preferred-first order on transient failures; if the preferred has been
  // unreachable for >5 min and a fallback succeeds, the active server is
  // promoted (which persists preferredServerId via the watcher in
  // initShruti). `getServers` is read per request, so a region list
  // refreshed from the remote config is picked up without rebuilding.
  const authHttp = createRegionFailoverClient({
    getServers: () => getRegions(),
    getPreferredId: () => useShruti().activeServer.value.id,
    pickBaseUrl: (s) => s.authBaseUrl,
    onPromoteFallback: (id) => useShruti().setActiveServerById(id),
  })
  const chatHttp = createRegionFailoverClient({
    getServers: () => getRegions(),
    getPreferredId: () => useShruti().activeServer.value.id,
    pickBaseUrl: (s) => s.chatBaseUrl,
    onPromoteFallback: (id) => useShruti().setActiveServerById(id),
  })

  // One 401 interceptor for every authenticated service client. The state that
  // makes N simultaneous 401s collapse into a single /auth/refresh lives on this
  // factory, so it must be created once and shared — wrapping each client with
  // its own `createUnauthorizedRetry` would refresh once per client.
  //
  // `authHttp` is deliberately NOT wrapped: a 401 from /auth/refresh IS the
  // answer (the refresh token is dead), and retrying it would recurse.
  const withUnauthorizedRetry = createUnauthorizedRetry({
    refreshAccessToken: () => useShruti().auth.refreshAccessToken(),
    onSessionChange: (listener) => useShruti().auth.onSessionChange(listener),
  })

  // Shared by the SSE turn stream and the proactive service — one decorated fn
  // rather than two, so both go through the same interceptor instance. A turn
  // carries an `Idempotency-Key` and lands in one shared turn store whichever
  // edge accepts it, so it may be re-issued elsewhere; `/chat/feedback` and the
  // per-turn calls keep the method default.
  //
  // `withRequestTimeout` sits innermost, on the raw failover call, so the budget
  // bounds ONE socket rather than a 401 refresh plus its replay. `/chat` opts out
  // — that path IS the turn stream, and it carries its own header + stall
  // deadlines (see `isChatStreamPath`).
  const chatRequest = withUnauthorizedRetry(
    withNetworkErrorContext(
      withCrossServerReplay(
        withRequestTimeout((path, init) => chatHttp.request(path, init), {
          skip: isChatStreamPath,
        }),
        (path) => path === "/chat"
      )
    )
  )

  // Stable device id (Capacitor Device.getId()), memoized. The single source of
  // this device's identity for the HLC tiebreak + `sync_state` key (via the
  // repository bundle) and the cursor-ack `device_id`. Matches how the auth
  // adapter obtains it, so they agree.
  const getDeviceId = (() => {
    let cached: Promise<string> | null = null
    return () => (cached ??= Device.getId().then((r) => r.identifier))
  })()

  // Profile-sync failover client. Routes ONLY on `profileBaseUrl` — no fallback
  // to chat. A region whose published config predates the `profile` service has
  // no `profileBaseUrl`; the sync engine is then disabled at runtime (the
  // `useSyncEngine` composable gates on it) and this client is never invoked.
  const profileHttp = createRegionFailoverClient({
    getServers: () => getRegions(),
    getPreferredId: () => useShruti().activeServer.value.id,
    pickBaseUrl: (s) => s.profileBaseUrl ?? "",
    onPromoteFallback: (id) => useShruti().setActiveServerById(id),
  })
  // pull / push / cursor are HLC + LWW against one profile DB — a repeat
  // converges — so they may be re-issued against another edge.
  const profileRequest = withUnauthorizedRetry(
    withNetworkErrorContext(
      withCrossServerReplay(
        withRequestTimeout((path, init) => profileHttp.request(path, init)),
        (path) => path.startsWith("/profile/sync/")
      )
    )
  )

  // Orchestrator ingest control-plane failover client.
  const orchestratorHttp = createRegionFailoverClient({
    getServers: () => getRegions(),
    getPreferredId: () => useShruti().activeServer.value.id,
    pickBaseUrl: (s) => s.orchestratorBaseUrl ?? "",
    onPromoteFallback: (id) => useShruti().setActiveServerById(id),
  })
  // `POST /orchestrator/run` creates-or-dedups a run under an id derived from
  // the verified user and the source, in the one orchestrator every edge
  // forwards to, so a replay of a submit that landed finds the same run.
  const ingestRequest = withUnauthorizedRetry(
    withNetworkErrorContext(
      withCrossServerReplay(
        withRequestTimeout((path, init) => orchestratorHttp.request(path, init)),
        (path) => path === "/orchestrator/run"
      )
    )
  )

  // share-* renders run on each region's own share services and upload to that
  // region's storage, while the app builds the artifact URL on the active
  // region. So a render is never replayed elsewhere: it goes to the active
  // region, and a failure reaches the user, who can retry. The failover client
  // still resolves the active region's door and fails at once while a
  // fallback-only region is active. The adapters carry their own 8 s cap.
  const shareRequest = (pickBaseUrl: (s: CdnServer) => string) => {
    const http = createRegionFailoverClient({
      getServers: () => getRegions(),
      getPreferredId: () => useShruti().activeServer.value.id,
      pickBaseUrl,
    })
    return withNetworkErrorContext((path, init) => {
      const activeOnly: FailoverRequestInit = { ...init, crossServerReplay: false }
      return http.request(path, activeOnly)
    })
  }
  const shareAudioRequest = shareRequest((s) => s.shareAudioUrl)
  const shareVideoRequest = shareRequest((s) => s.shareVideoUrl)
  const shareTranscriptRequest = shareRequest(
    (s) => s.shareTranscriptUrl ?? `${s.chatBaseUrl}/share/transcripts`
  )

  // Discovery search failover client. A published config.json predating the
  // field omits it — fall back to chatBaseUrl, since /discovery/search sits
  // behind the same Caddy as chat, the way shareTranscriptUrl does.
  const discoveryHttp = createRegionFailoverClient({
    getServers: () => getRegions(),
    getPreferredId: () => useShruti().activeServer.value.id,
    pickBaseUrl: (s) => s.discoveryBaseUrl ?? s.chatBaseUrl ?? "",
    onPromoteFallback: (id) => useShruti().setActiveServerById(id),
  })
  // `/discovery/search` is a POST only because its filter does not fit in a
  // query string — it writes nothing, so it walks the candidate list like a
  // read. Distinct doors only: `createRegionFailoverClient` collapses the
  // regions that resolve to one discovery host, so a 503 does not fan one
  // search out into several requests against it.
  const discoveryRequest = withUnauthorizedRetry(
    withNetworkErrorContext(
      withCrossServerReplay(
        withRequestTimeout((path, init) => discoveryHttp.request(path, init)),
        () => true
      )
    )
  )

  // `/auth/refresh` itself is never retried on a 401 — that answer IS the
  // verdict, and asking again would recurse.
  const authRequest = withNetworkErrorContext(
    withCrossServerReplay(
      withRequestTimeout((path, init) => authHttp.request(path, init)),
      isReplayableAuthPath
    )
  )

  return {
    authRequest,
    chatRequest,
    profileRequest,
    ingestRequest,
    discoveryRequest,
    shareAudioRequest,
    shareVideoRequest,
    shareTranscriptRequest,
    getDeviceId,
  }
}
