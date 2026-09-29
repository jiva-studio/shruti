# Task Specification: Region probe that sees stalls, fallback-only regions, ingest failover, share URLs on the active region

**Branch / Worktree**: `feat-region-probe-fallback`
**Status**: `IN_PROGRESS`
**Target Modules**: `modules/libs/domain`, `modules/apps/mobile` (infra/servers, infra/share*, shruti/services, shruti/stores/downloads). `modules/kit` and the native plugins are not changed.

---

## 0. Prior art

- [RFC 8305 — Happy Eyeballs v2](https://www.rfc-editor.org/rfc/rfc8305) and the [Happy Eyeballs v3 draft](https://datatracker.ietf.org/doc/draft-ietf-happy-happyeyeballs-v3/): stagger attempts by a short delay rather than racing flat out or walking serially, and key the delay on the step that decides reachability. Adopted: the next region joins when the latest one has made no progress — no config, then no verdict — within the hedge delay, and the whole race shares one budget.
- [Dean & Barroso, *The Tail at Scale* (CACM)](https://cacm.acm.org/research/the-tail-at-scale/): hedge only past the expected latency and cancel the losers once one answers, so a healthy primary costs one request stream. Adopted: losing regions are cancelled the moment one fully passes.
- [Apple, HLS Content Steering (WWDC21)](https://developer.apple.com/videos/play/wwdc2021/10141/) and [a dash.js/hls.js steering write-up](https://dev.to/masonwritescode/build-multi-cdn-failover-with-hls-content-steering-hlsjs-and-a-40-line-server-1l8i): clients keep an ordered list of pathways and rank them by what actually worked. Adopted in the ranking of regions by how far their check got. Server-driven steering is rejected: there is no steering server and the catalog is a single config file.
- [RFC 9110 §14 — Range requests](https://www.rfc-editor.org/rfc/rfc9110#section-14): a `bytes=0-65535` request exercises the same connection path as a download while bounding its cost. Throttled connections in some networks pass the first ~16 KB of a TLS session and then stall, so a probe that only downloads a ~10 KB JSON cannot tell a working path from a throttled one; reading 64 KiB can.

Rejected: probing by downloading a whole media file (cost); making the range read or the API check a hard gate on applying the config (one refused header or one rate-limited endpoint would freeze the catalog and region list everywhere).

## 1. Business Context & User Value (JTBD)

### Problem Statement & Trigger
- **Trigger**: a user on a network where some connections are throttled after the first kilobytes, or where a region's storage answers while its API does not.
- **Pain Point**: the probe picks a region that serves `config.json` but cannot carry a download; API calls on a dead API host hang while another region could serve them; there is no region the app can hold in reserve for storage only; share artifacts are fetched from whatever host the share service names, which may be unreachable.
- **Current Workaround**: switching region by hand in Settings.

### User Journey
- **Before**: launch → probe picks a throttled region → downloads hang.
- **After**: the probe prefers a region that passed every check; if none did, it still applies the freshest config from the region that got furthest; if no regular region answers at all, a storage-only fallback region keeps catalog and downloads alive while API features show their offline state.

### Value & Success Criteria
- **Observable verification**: region-probe breadcrumbs and rate-limited warnings in the existing monitoring channel show per-region outcomes, so stalls and dead APIs become measurable.

## 2. Goals, Non-Goals

### In-Scope
- Optional `fallbackOnly` on a region; probe, API failover and download/asset promotion honour it.
- Probe = config + 64 KiB Range read of the current content DB + API `/healthz` (regular regions only), ranked, app-side.
- share-audio / share-video / share-transcript stay on the active region (they upload to that region's storage); orchestrator submissions may replay on another region.
- Share artifact URLs built from the active region's storage and the object key.
- Probe telemetry through the existing monitoring channel (Sentry), no PII.

### Non-Goals
- No change to `modules/kit`, the native plugins, server code, Caddy, or any published `config.json`.
- No playback changes: audio is downloaded (hedged across regions) before it plays.
- No new dependency (network type read from `navigator.connection` when present).

## 3. Observable Acceptance Criteria

- [ ] **AC-1** `setRegions` accepts a list whose regions carry `fallbackOnly: true` alongside the currently required fields; a list without the field is accepted exactly as before; every existing rejection still rejects; any value other than `true` means a regular region.
- [ ] **AC-2** The probe never contacts a `fallbackOnly` region while any regular region reaches storage; when none does (all stalled, refused the ranged read, or sent no config) it checks `fallbackOnly` regions, storage only, and prefers one whose storage answers over a regular region that only delivered a config.
- [ ] **AC-3** A region whose 64 KiB Range read does not complete within the budget (16 KB then silence) loses to a region that fully passes; its outcome is `stalled`.
- [ ] **AC-4** A regular region whose `/healthz` fails or does not answer loses to a region that fully passes; its outcome is `api-down`. A 429 from `/healthz` counts as an API that is up.
- [ ] **AC-5** When every regular region is `api-down` with storage working, the config is still applied and a regular region is chosen (not a fallback-only one).
- [ ] **AC-6** When every Range read throws (a refused preflight), the config is still applied; the outcome is `range-failed`.
- [ ] **AC-7** Regions are ranked full pass > storage without API > config only; the first full pass wins at once.
- [ ] **AC-8** With a healthy preferred region that completes within the hedge delay after its config, only that region is contacted. A region is added when the latest one has not fetched its config within the hedge delay, has its config but no verdict within another hedge delay, or ended short of a full pass. The race of regular regions ends within one budget even when every API or storage read hangs.
- [ ] **AC-9** Regions still in flight when one fully passes are cancelled and reported `cancelled`.
- [ ] **AC-10** While the active region is `fallbackOnly`, every API failover client (auth, chat, profile, orchestrator, discovery, share-*) rejects at once with a `NetworkError`, without any fetch; when a regular region is active, `fallbackOnly` regions are never a failover candidate.
- [ ] **AC-11** Download success and asset failover on a `fallbackOnly` region do not promote it to active; `tryServers` restores the starting region when only a `fallbackOnly` region succeeded; `fallbackOnly` regions come last in download candidates.
- [ ] **AC-12** share-audio, share-video and share-transcript are sent to the active region only and never replayed elsewhere; a failure reaches the user. `POST /orchestrator/run` may replay on another region. Anything else keeps the method default.
- [ ] **AC-13** A share artifact URL is always the active region's storage URL for the object key taken from the service's answer; an answer without a `public/` key yields no URL and `ready:false`.
- [ ] **AC-14** Every probe leaves a breadcrumb with chosen and preferred region, per-region outcome and elapsed ms, fallback used, and network type when available. A warning event is sent only when the chosen region is not the preferred one or no region was chosen, at most once per 6 h (persisted), never while offline, with the user and the breadcrumb trail stripped from the event as the real Sentry scopes assemble it; the event carries no URL, host, user id or IP. Two probes reporting at once send one warning. Attempts are one flat string, so Sentry's context depth does not truncate them.
- [ ] **AC-16** A config without a non-empty, well-formed `databases` list, or with a `regions` list the registry would refuse, counts as no config (`failed`).
- [ ] **AC-17** The Settings region picker lists only regular regions; a `fallbackOnly` region never appears in it.
- [ ] **AC-15** A re-probe that finds a regular region delivering a config while a `fallbackOnly` region is active switches back to it.

## 4. Risks & Edge Cases

| Risk | Impact | Mitigation |
| :--- | :---: | :--- |
| Range header needs a CORS preflight on some storage | High | A refused or erroring read is `range-failed`, which ranks below a pass but never discards the config (AC-6). |
| `/healthz` rate-limited or down while storage works | High | 429 = up; `api-down` ranks below a pass but never discards the config (AC-4, AC-5). |
| Heavier probe triggers hedges on a healthy region | Medium | Hedge keyed on progress (AC-8); losers cancelled (AC-9). |
| Probe too slow when APIs or storage are blackholed | Medium | One shared budget per race (AC-8); fallback-only regions get one more only when no regular region reached storage. |
| Captive portal answering JSON | Medium | A config counts only with a valid `databases` list and, when present, a valid `regions` list (AC-16). |
| Share rendered in another region's storage | High | Share requests never leave the active region (AC-12). |
| Telemetry volume | Medium | Event only when the region moved or none answered, once per 6 h, never offline (AC-14). |
| All regions `fallbackOnly` | Low | Accepted (old clients accept it too); API stays off — publisher's responsibility. |
| Config lists no DB compatible with this build | Low | Range check targets the latest listed DB of any scheme; with no DB at all the check is skipped. |
| Wire contract | High | **Wire-contract change**: `regions[].fallbackOnly` is a new optional boolean in `public/config.json`. Additive; clients that do not read it ignore it (their `isValidRegion` checks only the fields they know), so a fallback region must still carry every currently required field, including API URLs. |

## 5. Blast Radius

| File | Action | Purpose |
| :--- | :---: | :--- |
| `modules/libs/domain/servers.ts` | MODIFY | `fallbackOnly?` + `isFallbackOnly` |
| `apps/mobile/infra/servers/regionCheck.ts` | CREATE | one region's config + range + healthz check, ranked verdict |
| `apps/mobile/infra/servers/regionRace.ts` | CREATE | progress-hedged race in one budget, cancellation, ranking |
| `apps/mobile/infra/servers/probeOrder.ts` | CREATE | regular / fallback split, preferred first |
| `apps/mobile/infra/servers/useHttpServerProber.ts` | MODIFY | two-tier probe, report |
| `apps/mobile/ports/app/serverProber.ts` | MODIFY | probe report types |
| `apps/mobile/shruti/services/regionFailover.ts` | MODIFY | exclude `fallbackOnly`; fail fast while on one |
| `apps/mobile/shruti/services/serviceRequests.ts` | MODIFY | share-* transports; orchestrator replay |
| `apps/mobile/infra/shareArtifactUrl.ts` | CREATE | object key from a share answer |
| `apps/mobile/infra/share{Audio,Video,Transcript}/http/*` | MODIFY | active-region transport; URLs on the active region |
| `apps/mobile/shruti/regionClients.ts` | CREATE | builds prober and share clients for the composition root |
| `apps/mobile/shruti/shruti.ts`, `services/shrutiTypes.ts`, `main.ts` | MODIFY | wiring |
| `apps/mobile/shruti/services/monitoring/probeTelemetry.ts` | CREATE | Sentry sink |
| `apps/mobile/shruti/stores/downloads/useServerFallback.ts`, `downloadDecisions.ts`, `downloadAttempt.ts` | MODIFY | no promotion to `fallbackOnly` |
| `apps/mobile/shruti/services/withAssetRegionFailover.ts` | MODIFY | no promotion to `fallbackOnly` |
| unchanged, reviewed: `startup.ts`, `regionWatch.ts`, `bootSequence.ts`, `preferredServer.ts`, `outboxFlush.ts`, `useSyncEngine.ts`, `useIngestPollingStore.ts`, `usePlaylistQueueBuilder.ts`, `usePlayerOpenTrack.ts`, `libs/domain/config.ts`, kit `useStoragePublicUrl` | — | read the active region; behave correctly with a `fallbackOnly` active region (storage) and fail fast on API |

## 6. Phased Plan

### Phase 1: Red
- [ ] Contract: `fallbackOnly`, probe report types, share service signatures.
- [ ] Tests for AC-1…AC-17; run, capture failing output.

### Phase 2: Green
- [ ] Implement until the tests pass without editing their assertions.

### Phase 3: Wiring
- [ ] Composition root builds prober, share clients and telemetry sink.

### Phase 4: Gate
- [ ] No TODO/stubs; hand mutation-check every new test; mutation score on the diff.

## 7. Verification Gate

```bash
cd modules/apps/mobile && npx vitest run && npx vue-tsc --noEmit && npm run lint && npx prettier --check <changed files>
make mutate-diff
```
