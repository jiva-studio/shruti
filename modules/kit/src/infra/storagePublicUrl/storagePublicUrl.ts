/**
 * Resolves a storage path (full path from the bucket root, e.g.
 * `"public/tracks/xxx/audio/original.mp3"`) to a publicly-fetchable URL,
 * by substituting it into the active CDN server's URL template. No
 * prefixes are added by the resolver — the path is used verbatim.
 */
export interface IStoragePublicUrl {
  get(path: string): string
}
