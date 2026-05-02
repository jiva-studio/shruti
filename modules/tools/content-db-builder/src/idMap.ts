import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { nanoid } from "nanoid"

/**
 * Persistent map: oldCouchId → new prefixed id, per entity type.
 *
 * The point of this file is to keep ids **stable across re-runs** while
 * still being random the first time they are minted. Random + stable is
 * a contradiction unless we remember what we generated, hence this
 * JSON snapshot. It's checked into the repo on purpose — a re-build on
 * any developer's machine, in any environment, must produce the same
 * ids so that media migration is idempotent (same id → same destination
 * key → existing object found via HEAD, skipped).
 *
 * If you ever want to re-roll all ids, delete the file. Anything that
 * was already uploaded under the old ids will become orphaned in the
 * bucket — that is the point.
 */

export type EntityKind = "authors" | "locations" | "sources" | "tags" | "tracks"

const PREFIXES: Record<EntityKind, string> = {
  authors: "author",
  locations: "location",
  sources: "source",
  tags: "tag",
  tracks: "track",
}

interface IdMapFile {
  authors: Record<string, string>
  locations: Record<string, string>
  sources: Record<string, string>
  tags: Record<string, string>
  tracks: Record<string, string>
}

function emptyMap(): IdMapFile {
  return { authors: {}, locations: {}, sources: {}, tags: {}, tracks: {} }
}

export class IdMap {
  private path: string
  private data: IdMapFile
  private dirty = false

  constructor(path: string) {
    this.path = path
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8")
        this.data = { ...emptyMap(), ...(JSON.parse(raw) as Partial<IdMapFile>) }
      } catch (err) {
        throw new Error(
          `failed to parse id map at ${path}: ${(err as Error).message}. ` +
            `Delete the file to start fresh, but be aware that orphans any ` +
            `media already uploaded under the old ids.`
        )
      }
    } else {
      this.data = emptyMap()
    }
  }

  /** Look up by old couch id; mint a new prefixed nanoid if absent. */
  getOrCreate(kind: EntityKind, oldId: string): string {
    const bucket = this.data[kind]
    const existing = bucket[oldId]
    if (existing) return existing
    const fresh = `${PREFIXES[kind]}_${nanoid(12)}`
    bucket[oldId] = fresh
    this.dirty = true
    return fresh
  }

  /** Lookup-only — used when resolving FKs that must already exist. */
  get(kind: EntityKind, oldId: string): string | undefined {
    return this.data[kind][oldId]
  }

  /** Persist if anything changed since load. No-op otherwise. */
  save(): void {
    if (!this.dirty) return
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n", "utf8")
    this.dirty = false
  }

  /** Read-only snapshot of one bucket. */
  snapshot(kind: EntityKind): ReadonlyMap<string, string> {
    return new Map(Object.entries(this.data[kind]))
  }
}
