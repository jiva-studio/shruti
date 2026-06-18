import { ref } from "vue"
import { SERVERS, buildServerUrl, type CdnServer } from "@lib/domain/servers.js"
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

/**
 * Local-dev region. Content (S3) + share-* stay on the prod `global`
 * endpoints — only auth + chat point at the locally-running stack
 * (`infra/app/compose/docker-compose.dev.yml`: chat on :11080, auth on
 * :11081 — lectorium's reserved 11xxx port band). It sits FIRST so the
 * startup prober picks it (its `urlTemplate` is prod S3, so the config.json
 * probe succeeds) and routes auth/chat traffic to localhost.
 *
 * Opt-in via `VITE_DEV_REGION=true` (the `local-stack` skill sets it when it
 * launches the dev server). Vite statically inlines `import.meta.env.
 * VITE_DEV_REGION` at build time, so any build that doesn't set the var —
 * every production build, the test runner, the screenshots pipeline, and a
 * plain `npm run dev` for contributors not running the local stack — compiles
 * the comparison to a constant `false` and tree-shakes the literal and
 * `withDev()` away. The dev region never ships and never shows in the Settings
 * region picker. Override the host:port via VITE_DEV_AUTH_URL /
 * VITE_DEV_CHAT_URL if your stack runs elsewhere. Web dev only; a native
 * dev build's `localhost` resolves to the device, not the host machine.
 */
const DEV_REGIONS: readonly CdnServer[] =
  import.meta.env.VITE_DEV_REGION === "true"
    ? [
        {
          id: "dev",
          name: "Local (dev)",
          urlTemplate: SERVERS[0]!.urlTemplate,
          shareAudioUrl: SERVERS[0]!.shareAudioUrl,
          shareVideoUrl: SERVERS[0]!.shareVideoUrl,
          shareTranscriptUrl: SERVERS[0]!.shareTranscriptUrl,
          authBaseUrl:
            (import.meta.env.VITE_DEV_AUTH_URL as string | undefined) ??
            "http://localhost:11081/auth",
          chatBaseUrl:
            (import.meta.env.VITE_DEV_CHAT_URL as string | undefined) ?? "http://localhost:11080",
        },
      ]
    : []

/**
 * Prepend the dev region (if any) to a region list, dropping any incoming
 * entry that collides on id so a published config.json can't shadow it.
 * Identity (returns the list unchanged) in production builds.
 */
function withDev(list: readonly CdnServer[]): readonly CdnServer[] {
  if (DEV_REGIONS.length === 0) return list
  const devIds = new Set(DEV_REGIONS.map((r) => r.id))
  return [...DEV_REGIONS, ...list.filter((r) => !devIds.has(r.id))]
}

// Seed with the compiled-in bootstrap list. Replaced by hydrateRegions()
// (persisted) and setRegions() (freshly fetched). In dev the local region
// is kept pinned at the front through `withDev()`.
const regions = ref<readonly CdnServer[]>(withDev(SERVERS))

// The active region id, mirrored here from the composition root's
// `activeServer` so asset-URL resolution follows server promotions (CDN
// failover) without the registry importing the composition root (which would
// be circular — the root imports the registry). `null` until the root sets it.
const activeRegionId = ref<string | null>(null)

let prefs: IPreferences | null = null

/** Current region list. Always non-empty (bootstrap seed never cleared). */
export function getRegions(): readonly CdnServer[] {
  return regions.value
}

/** Resolve a region by id from the current list, or undefined. */
export function findRegion(id: string): CdnServer | undefined {
  return regions.value.find((s) => s.id === id)
}

/**
 * Mirror the composition root's active server id into the registry so
 * `resolveAssetUrl` builds against the live region. Called from the
 * `activeServer` watch in `initLectorium`.
 */
export function setActiveRegionId(id: string | null): void {
  activeRegionId.value = id
}

/** The active region, or the first as a fallback before the root sets one. */
export function activeRegion(): CdnServer | undefined {
  return (activeRegionId.value ? findRegion(activeRegionId.value) : undefined) ?? regions.value[0]
}

/**
 * Build a full asset URL for an S3 key against the ACTIVE region (so covers,
 * avatars, etc. follow a CDN failover promotion), or undefined for an empty
 * key / no region. Was pinned to `regions[0]`, which ignored the active server
 * and could even start on a different region than streaming used.
 */
export function resolveAssetUrl(key: string | undefined): string | undefined {
  if (!key) return undefined
  const region = activeRegion()
  return region ? buildServerUrl(region, key) : undefined
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
    // shareTranscriptUrl is intentionally NOT required: a published
    // config.json predating this field must stay valid. The composition
    // root derives it from chatBaseUrl when absent.
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
      regions.value = withDev(parsed)
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
  regions.value = withDev(list)
  if (prefs) {
    void prefs
      .set(REGIONS_KEY, JSON.stringify(list))
      .catch((err) => console.warn("[regions] persist failed", err))
  }
  return true
}
