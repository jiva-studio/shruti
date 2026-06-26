import type { IPreferences } from "@ports/app/index.js"

/**
 * `IPreferences` key under which the chosen CDN's `id` is persisted.
 * Written automatically whenever `activeServer` flips (see the watcher
 * inside `initShruti`) and read by `readPreferredServerId` at cold
 * start (in `main.ts`) to seed the active region before the bootstrap
 * probe runs, so the probe tries the user's last choice first.
 *
 * The background content refresh (`startup.ts`) also persists this
 * directly so the next launch lands on the region that last worked.
 */
export const PREFERRED_SERVER_KEY = "preferredServerId"

/**
 * Read the persisted preferred-server id, or null if absent/unreadable.
 * The caller validates it against the live region registry before use —
 * a stale id (region dropped from a newer config.json) is treated as
 * "no preference" and falls back to the bootstrap default.
 */
export async function readPreferredServerId(preferences: IPreferences): Promise<string | null> {
  try {
    const stored = await preferences.get(PREFERRED_SERVER_KEY)
    return stored && stored.length > 0 ? stored : null
  } catch (err) {
    console.warn("[shruti] read preferredServerId failed", err)
    return null
  }
}
