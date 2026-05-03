import type { CdnServer } from "@lib/domain/servers.js"
import type { Lectorium } from "../lectorium.js"

/**
 * `IPreferences` key under which the chosen CDN's `id` is persisted.
 * Shared between the Welcome flow (which writes it after the startup
 * probe) and the runtime download path (which writes it after a
 * fallback succeeds on a different CDN), so both code paths agree on
 * the next-launch starting point.
 */
export const PREFERRED_SERVER_KEY = "preferredServerId"

/**
 * Atomically promote `server` to the active CDN: update the in-memory
 * `activeServer` ref AND persist the id under `PREFERRED_SERVER_KEY`
 * so the next launch starts there.
 *
 * No-op when `server` is already the active one — avoids redundant
 * `preferences.set` writes when the runtime fallback re-confirms the
 * already-active CDN.
 *
 * Persistence failure is swallowed and logged: the in-memory swap is
 * the user-facing win (subsequent downloads in this session work);
 * losing the next-launch hint is a soft regression we don't want to
 * surface as a download error.
 */
export async function promotePreferredServer(
  lectorium: Pick<Lectorium, "activeServer" | "setActiveServer" | "preferences">,
  server: CdnServer
): Promise<void> {
  if (lectorium.activeServer.value.id === server.id) return
  lectorium.setActiveServer(server)
  try {
    await lectorium.preferences.set(PREFERRED_SERVER_KEY, server.id)
  } catch (err) {
    console.warn(`[preferredServer] persist failed for ${server.id}; runtime swap retained:`, err)
  }
}
