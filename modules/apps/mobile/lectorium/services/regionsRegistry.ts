import { ref } from "vue"
import { SERVERS, type CdnServer } from "@lib/domain/servers.js"
import type { IPreferences } from "@ports/app/index.js"

/**
 * Runtime registry of CDN/region endpoints.
 *
 * The list of regions is no longer compiled-in: it lives in the published
 * `public/config.json` (managed via lectorium-mcp `catalog.config.regions.*`)
 * and the app downloads it on startup. But there's a bootstrap chicken-and-egg
 * — the app needs *some* region to know where to fetch config.json from. So:
 *
 *   1. The bundled `SERVERS` (servers.ts) seed the registry — used ONLY on the
 *      very first launch, before any config.json has been fetched.
 *   2. After the first successful fetch, the downloaded regions are persisted
 *      to `IPreferences` and become the bootstrap list on every later launch
 *      ("once overwritten by the file, we use the latest from the file").
 *   3. A fetched `regions` block fully REPLACES the runtime list.
 *
 * Every consumer that used to import `SERVERS` directly (prober, failover
 * clients, download fallback, the Settings picker, `setActiveServerById`)
 * reads through this registry instead, so a region flip / new region takes
 * effect without an app release.
 */

/** `IPreferences` key under which the last-fetched regions list is cached. */
export const REGIONS_KEY = "remoteRegions"

// Seed with the compiled-in bootstrap list. Replaced by hydrateRegions()
// (persisted) and setRegions() (freshly fetched).
const regions = ref<readonly CdnServer[]>(SERVERS)

let prefs: IPreferences | null = null

/** Reactive list for UI (e.g. the Settings server picker). */
export const regionsRef = regions

/** Current region list. Always non-empty (bootstrap seed never cleared). */
export function getRegions(): readonly CdnServer[] {
  return regions.value
}

/** Resolve a region by id from the current list, or undefined. */
export function findRegion(id: string): CdnServer | undefined {
  return regions.value.find((s) => s.id === id)
}

function isValidRegion(r: unknown): r is CdnServer {
  if (typeof r !== "object" || r === null) return false
  const o = r as Record<string, unknown>
  const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0
  return (
    nonEmptyStr(o.id) &&
    nonEmptyStr(o.name) &&
    nonEmptyStr(o.urlTemplate) &&
    (o.urlTemplate as string).includes("{path}") &&
    nonEmptyStr(o.shareAudioUrl) &&
    nonEmptyStr(o.shareVideoUrl) &&
    nonEmptyStr(o.authBaseUrl) &&
    nonEmptyStr(o.chatBaseUrl)
  )
}

/**
 * A region list is usable only if it is a non-empty array of well-formed
 * entries. Rejecting empty/malformed lists is load-bearing: a bad
 * `regions: []` (or a corrupt persisted blob) must NOT replace a working
 * list, or the prober/failover would have nothing to probe and the app
 * would brick — permanently, since the bad value would also be persisted.
 */
function isValidRegionList(v: unknown): v is CdnServer[] {
  return Array.isArray(v) && v.length > 0 && v.every(isValidRegion)
}

/**
 * Hydrate the registry from the persisted (last-fetched) regions. Called
 * once at startup BEFORE the failover clients / prober are built, so the
 * first probe goes to "the latest from the file" rather than the bundled
 * seed. Invalid/absent persisted value → keep the bundled bootstrap.
 */
export async function hydrateRegions(preferences: IPreferences): Promise<void> {
  prefs = preferences
  try {
    const raw = await preferences.get(REGIONS_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (isValidRegionList(parsed)) {
      regions.value = parsed
    } else {
      console.warn("[regions] persisted list invalid — using bundled defaults")
    }
  } catch (err) {
    console.warn("[regions] hydrate failed — using bundled defaults", err)
  }
}

/**
 * Apply a freshly-fetched `regions` block: replace the runtime list and
 * persist it for the next launch. Returns true if applied. An empty /
 * malformed list is ignored (the current list stays), so a bad publish
 * can't strand the client.
 */
export function setRegions(list: unknown): boolean {
  if (!isValidRegionList(list)) return false
  regions.value = list
  if (prefs) {
    void prefs
      .set(REGIONS_KEY, JSON.stringify(list))
      .catch((err) => console.warn("[regions] persist failed", err))
  }
  return true
}
