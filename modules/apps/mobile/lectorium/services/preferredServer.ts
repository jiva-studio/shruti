/**
 * `IPreferences` key under which the chosen CDN's `id` is persisted.
 * Written automatically whenever `activeServer` flips (see the watcher
 * inside `initLectorium`) and read by the Welcome flow on cold start
 * to pick the bootstrap region.
 *
 * The Welcome "Check for updates" background probe also persists this
 * directly when the probe lands on a different region but doesn't want
 * to yank the rug out from under in-flight downloads (i.e. it persists
 * for next launch WITHOUT flipping the running activeServer).
 */
export const PREFERRED_SERVER_KEY = "preferredServerId"
