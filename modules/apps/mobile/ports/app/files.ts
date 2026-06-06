/**
 * Port for a remote files cache. Implementations fetch a file from its URL
 * on first access, cache it under a platform-specific store (Cache API on
 * web, Filesystem on Capacitor), and return a local URL the UI can put into
 * `<img src>` / `<audio src>` attributes without re-downloading on subsequent
 * accesses.
 *
 * The port lives in the shared kit (`@kit/infra`); re-exported here so app
 * code keeps importing it from `@ports/app`.
 */
export type { IRemoteFilesStorage } from "@kit/infra"
