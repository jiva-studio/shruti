/**
 * Welcome region-detect — three-signal heuristic to pick the user's
 * home region on first launch. NOT used for VPN detection (VPN trivially
 * defeats signal 3; signals 1+2 stay accurate). User can always override
 * in Settings → Region.
 *
 * The order is intentional: signals run from strongest (TZ, which a VPN
 * cannot change on the OS) to weakest (IP geolocation, which a VPN
 * does change). Any signal that fires "russia" short-circuits — we
 * never need to ask a weaker source once a stronger one agrees.
 *
 * Designed to be dependency-injected (fetch, prefs, detect) so the
 * tests can drive every branch without touching globals.
 */

import { Device } from "@capacitor/device"

/**
 * IANA timezones used by Russia (Kaliningrad through Kamchatka). Source:
 * tzdata 2024b — Russia's zoneset is stable, but if a future split
 * adds a new one this list is the only place to update.
 */
const RU_TIMEZONES = new Set<string>([
  "Europe/Kaliningrad",
  "Europe/Moscow",
  "Europe/Samara",
  "Europe/Saratov",
  "Europe/Volgograd",
  "Europe/Kirov",
  "Europe/Ulyanovsk",
  "Europe/Astrakhan",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Novosibirsk",
  "Asia/Tomsk",
  "Asia/Novokuznetsk",
  "Asia/Barnaul",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Chita",
  "Asia/Yakutsk",
  "Asia/Khandyga",
  "Asia/Vladivostok",
  "Asia/Magadan",
  "Asia/Srednekolymsk",
  "Asia/Ust-Nera",
  "Asia/Sakhalin",
  "Asia/Anadyr",
  "Asia/Kamchatka",
])

export interface RegionDetectDeps {
  /**
   * Full URL of the global region's `/whoami` endpoint. We always ask
   * the global region (not the current one) so the IP-geo source of
   * truth is stable regardless of where the user might later land —
   * the response is purely advisory and the global region is the
   * canonical observer of the public internet.
   */
  whoamiUrl: string
  /** Override for tests; defaults to global `fetch`. */
  fetch?: typeof fetch
  /** Override for tests; defaults to the value returned by `Intl.DateTimeFormat`. */
  resolvedTimezone?: () => string | null
  /** Override for tests; defaults to `Device.getLanguageCode()`. */
  deviceLanguage?: () => Promise<string | null>
  /** Abort the IP probe after this many ms. Defaults to 2000. */
  timeoutMs?: number
}

/**
 * Probe the three signals in priority order and return a region id.
 * Defaults to `"global"` when nothing points at Russia. Never throws —
 * any internal error degrades silently to the next signal so a botched
 * Intl polyfill or an unreachable `/whoami` doesn't break Welcome.
 */
export async function detectHomeRegion(deps: RegionDetectDeps): Promise<string> {
  // Signal 1 (strongest): timezone. VPN does not change OS TZ.
  try {
    const tz =
      deps.resolvedTimezone?.() ??
      (typeof Intl !== "undefined" && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : null)
    if (tz && RU_TIMEZONES.has(tz)) return "russia"
  } catch {
    // Older runtimes lacking Intl support — fall through to signal 2.
  }

  // Signal 2: device language.
  try {
    const getLang =
      deps.deviceLanguage ??
      (async () => {
        const { value } = await Device.getLanguageCode()
        return value
      })
    const lang = await getLang()
    if (lang === "ru") return "russia"
  } catch {
    // Device plugin missing or rejecting — fall through.
  }

  // Signal 3 (weakest, advisory): IP geolocation. Fail silently on
  // timeout / 4xx / network — VPN/firewall users get the default and
  // can always override in Settings.
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 2000)
    const f = deps.fetch ?? fetch
    try {
      const res = await f(deps.whoamiUrl, { signal: ctl.signal })
      if (res.ok) {
        const body = (await res.json()) as { country?: string } | null
        if (body && body.country === "RU") return "russia"
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // Any failure — timeout, network, malformed JSON — defaults to global.
  }

  return "global"
}

export interface PreferenceStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

export interface WelcomeRegionDeps {
  prefs: PreferenceStore
  /** Region-detect heuristic; pre-wired by the controller with whoamiUrl. */
  detect: () => Promise<string>
  /** Preferences key under which the chosen region is persisted. */
  storageKey: string
}

/**
 * Resolve the home region for the welcome flow, persisting the choice
 * on first launch so subsequent launches honor it. Returning users hit
 * the early-return path — no detection round-trip, no IP probe.
 */
export async function welcomeRegion(deps: WelcomeRegionDeps): Promise<string> {
  const existing = await deps.prefs.get(deps.storageKey)
  if (existing) return existing
  const detected = await deps.detect()
  await deps.prefs.set(deps.storageKey, detected)
  return detected
}
