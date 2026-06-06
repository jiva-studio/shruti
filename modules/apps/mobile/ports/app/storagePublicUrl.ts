/**
 * Resolves a storage path (full path from the bucket root, including the
 * `public/` prefix, e.g. `"public/tracks/xxx/audio/original.mp3"`) to a
 * publicly-fetchable URL, by substituting `{path}` into the active CDN
 * server's URL template. No prefixes are added by the resolver.
 *
 * The port lives in the shared kit (`@kit/infra`); re-exported here so app
 * code keeps importing it from `@ports/app`.
 */
export type { IStoragePublicUrl } from "@kit/infra"
