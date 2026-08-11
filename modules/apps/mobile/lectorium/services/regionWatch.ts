import { App as CapApp } from "@capacitor/app"

import { useLectorium } from "@lectorium/lectorium.js"
import { findRegion } from "@lectorium/services/regionsRegistry.js"

/**
 * Keep the active region following the device, not the process.
 *
 * The startup probe runs once, before mount, and nothing re-ran it — so a user
 * who flies somewhere, toggles a VPN or switches networks kept the region they
 * booted with for as long as the process lived, which on mobile is days. That
 * is not cosmetic staleness: a stale region sends API calls to the wrong door
 * and makes the media layer walk (and persist) a region it should not have.
 *
 * Re-probing is cheap enough to hang off resume and reconnect: the prober
 * hedges candidates, so a healthy preferred region still wins alone in a
 * single request and only an unreachable one pays for the walk.
 */

/**
 * Floor between two resume-driven probes.
 *
 * A resume is a weak signal — the network usually did not change — and the
 * cold-start probe has just run, so the clock starts armed: an app switched
 * away from and back to seconds after launch re-probes nothing.
 *
 * An `online` transition is a different signal: the radio genuinely
 * re-attached, which is the moment a relocation or a VPN flip becomes visible.
 * Those bypass the floor and are bounded by the in-flight guard instead, so a
 * flapping radio still cannot stack probes.
 */
const MIN_REPROBE_INTERVAL_MS = 60_000

export interface RegionReprobeDeps {
  /** Run the probe; resolves the id of the region that answered first. */
  probe: () => Promise<string>
  /** Apply a probe result. Called only when the winner differs. */
  onResolved: (serverId: string) => void
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
  /** Test seam — defaults to `MIN_REPROBE_INTERVAL_MS`. */
  minIntervalMs?: number
}

export interface RegionReprobe {
  /**
   * Request a re-probe. Coalesced against one in flight, and rate-limited
   * unless `force` says the caller saw the network itself change. Never throws.
   */
  trigger: (opts?: { force?: boolean }) => void
}

export function createRegionReprobe(deps: RegionReprobeDeps): RegionReprobe {
  const now = deps.now ?? Date.now
  const minIntervalMs = deps.minIntervalMs ?? MIN_REPROBE_INTERVAL_MS

  // Seeded to "just probed": the cold-start probe has already run by the time
  // this is wired, so the first resume seconds later re-probes nothing.
  let lastProbeAt = now()
  let inFlight = false

  function trigger(opts?: { force?: boolean }): void {
    if (inFlight) return
    if (!opts?.force && now() - lastProbeAt < minIntervalMs) return
    inFlight = true
    lastProbeAt = now()
    void deps
      .probe()
      .then((serverId) => deps.onResolved(serverId))
      .catch((err) => {
        // Every candidate was unreachable — the device is offline or behind a
        // captive portal. Keep the region we have; the stamp above means we do
        // not hammer the radio on the next resume.
        console.warn("[lectorium] region re-probe failed:", err)
      })
      .finally(() => {
        inFlight = false
      })
  }

  return { trigger }
}

/**
 * Wire the re-probe to the two signals that mean "the network under us may
 * have changed": the app coming back to the foreground, and the device
 * reporting itself back online.
 */
export function startRegionWatch(): RegionReprobe {
  const lectorium = useLectorium()
  const reprobe = createRegionReprobe({
    probe: async () => {
      const result = await lectorium.serverProber.probe(
        lectorium.appConfig.publicRemoteConfigPath,
        lectorium.activeServer.value.id
      )
      return result.serverId
    },
    onResolved: (serverId) => {
      // A probe can only return an id it was given, but the registry may have
      // been replaced by a fresh config.json in between.
      if (!findRegion(serverId)) return
      // No-op when unchanged; the `activeServer` watcher persists the flip so
      // the next cold start already lands on the right region.
      lectorium.setActiveServerById(serverId)
    },
  })

  void CapApp.addListener("appStateChange", (state) => {
    if (state.isActive) reprobe.trigger()
  })
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => reprobe.trigger({ force: true }))
  }

  return reprobe
}
