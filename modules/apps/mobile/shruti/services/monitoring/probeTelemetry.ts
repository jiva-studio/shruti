/**
 * Region-probe telemetry through the existing Sentry channel.
 *
 * Every probe leaves a breadcrumb, so any later error carries how the device
 * reached its region. A probe that did not land on the region it was asked to
 * try first — or on no region at all — is also sent as a warning-level event,
 * at most once per `PROBE_WARNING_INTERVAL_MS` across launches and never while
 * the device is offline, where every region failing says nothing about them.
 *
 * The payload is built from a whitelist of fields: region ids, outcomes,
 * timings and the network type — never a URL, a host or an identity. The event
 * is sent with the user and the breadcrumb trail cleared from its scope, since
 * the trail carries the URLs of the requests the probe just made.
 */
import * as Sentry from "@sentry/capacitor"
import type { IPreferences, RegionProbeReport } from "@ports/app/index.js"

export const PROBE_WARNING_INTERVAL_MS = 6 * 60 * 60_000

/** `IPreferences` key holding when the last probe warning was sent (epoch ms). */
export const PROBE_WARNED_AT_KEY = "regionProbeWarnedAt"

/**
 * The probe as Sentry stores it. Every value is flat: Sentry normalizes an
 * event's contexts to a depth of three, so a nested list of attempts would
 * arrive as `[Object]`. `attempts` reads `a=stalled/5000ms b=ok/400ms`.
 */
export interface ProbeTelemetry {
  readonly chosen_region: string | null
  readonly preferred_region: string | null
  readonly fallback_used: boolean
  readonly attempts: string
  readonly network_type: string
}

export function buildProbeTelemetry(report: RegionProbeReport): ProbeTelemetry {
  return {
    chosen_region: report.chosenRegionId,
    preferred_region: report.preferredRegionId,
    fallback_used: report.fallbackUsed,
    attempts: report.attempts
      .map((a) => `${a.regionId}=${a.outcome}/${Math.round(a.elapsedMs)}ms`)
      .join(" "),
    network_type: report.networkType ?? "unknown",
  }
}

interface NetworkInformationLike {
  readonly type?: string
  readonly effectiveType?: string
}

/** The connection type the WebView exposes through `navigator.connection`, if
 *  it exposes one (Android WebView does; WebKit does not). */
export function readNetworkType(): string | undefined {
  if (typeof navigator === "undefined") return undefined
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection
  return connection?.type ?? connection?.effectiveType
}

function isWarning(report: RegionProbeReport): boolean {
  return report.chosenRegionId === null || report.chosenRegionId !== report.preferredRegionId
}

function stripIdentityAndTrail(event: Sentry.Event): Sentry.Event {
  const stripped = { ...event }
  delete stripped.breadcrumbs
  delete stripped.user
  delete stripped.request
  return stripped
}

export interface ProbeTelemetryDeps {
  readonly preferences: Pick<IPreferences, "get" | "set">
  readonly now?: () => number
  readonly isOnline?: () => boolean
}

const browserIsOnline = (): boolean => typeof navigator === "undefined" || navigator.onLine

export function createProbeTelemetry(
  deps: ProbeTelemetryDeps
): (report: RegionProbeReport) => Promise<void> {
  const now = deps.now ?? Date.now
  const isOnline = deps.isOnline ?? browserIsOnline

  // The persisted stamp is read and written across awaits; these keep two
  // probes reporting at once, or in quick succession, to one warning.
  let isClaiming = false
  let lastSentAt: number | null = null

  const isRecent = (at: number): boolean => now() - at < PROBE_WARNING_INTERVAL_MS

  async function claimWarning(): Promise<boolean> {
    if (isClaiming || (lastSentAt !== null && isRecent(lastSentAt))) return false
    isClaiming = true
    try {
      const raw = await deps.preferences.get(PROBE_WARNED_AT_KEY)
      const persisted = raw === null ? Number.NaN : Number(raw)
      if (Number.isFinite(persisted) && isRecent(persisted)) return false
      lastSentAt = now()
      await deps.preferences.set(PROBE_WARNED_AT_KEY, String(lastSentAt))
      return true
    } finally {
      isClaiming = false
    }
  }

  return async (report) => {
    const payload = buildProbeTelemetry(report)
    const warning = isWarning(report)
    Sentry.addBreadcrumb({
      category: "region.probe",
      level: warning ? "warning" : "info",
      data: payload,
    })
    if (!warning || !isOnline()) return
    if (!(await claimWarning())) return
    Sentry.withScope((scope) => {
      scope.setLevel("warning")
      scope.setTag("scope", "region-probe")
      scope.setContext("region_probe", { ...payload })
      // Breadcrumbs and the user sit on the isolation scope and are merged
      // into the event after this scope's own data; a processor on this
      // scope runs last and is the one place that can drop them for this
      // event alone.
      scope.addEventProcessor(stripIdentityAndTrail)
      Sentry.captureMessage("region probe did not land on the preferred region")
    })
  }
}
