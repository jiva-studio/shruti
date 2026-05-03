/**
 * Resolves a storage path (full path from the bucket root, including the
 * `public/` prefix, e.g. `"public/tracks/xxx/audio/original.mp3"`) to a
 * publicly-fetchable URL, by substituting `{path}` into the active CDN
 * server's URL template. No prefixes are added by the resolver.
 */
export interface IStoragePublicUrl {
  get(path: string): string
}
