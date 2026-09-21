/**
 * Featured-collection header row, as returned by the catalog DB.
 *
 * `name` is the label the user sees (e.g. "Лекции о карме и судьбе" /
 * "Lectures on karma and destiny"). `sort_order` is an ASC display key —
 * the repo already orders by it, so consumers can pass the list straight
 * to the UI.
 */
export interface FeaturedCollectionRow {
  readonly id: string
  readonly name: string
  readonly cover: string
  readonly sort_order: number
  readonly description?: string
}

/** Full detail for the collection screen/modal. */
export interface CollectionDetail {
  readonly id: string
  readonly name: string
  readonly cover: string
  readonly description: string
  readonly trackIds: readonly string[]
}

/** A named group (shelf) of collections, as shown on the Search page. */
export interface CollectionGroupRow {
  readonly id: string
  readonly name: string
  readonly description: string
}

/**
 * The author behind a collection (derived from its tracks' dominant author).
 * `image` is an S3 asset key for the avatar; `description` a short bio. Both
 * are empty when not yet published — the UI then shows name only / no avatar.
 */
export interface CollectionAuthor {
  readonly id: string
  readonly name: string
  readonly image: string
  readonly description: string
}

/**
 * One collection a track belongs to, with the track's 1-based place in it.
 * `total` is how many tracks the collection holds, so a lecture can say it is
 * the third of eight without a second query.
 */
export interface TrackCollectionRow {
  readonly id: string
  readonly name: string
  readonly cover: string
  readonly position: number
  readonly total: number
}

export interface ISqlCollectionRepository {
  /**
   * Featured collections for `locale` (carrying the `tag_featured` tag),
   * ordered by `sort_order ASC` then `id ASC`. Returns an empty array (not
   * throws) when the catalog DB has no collection tables — the Home view
   * degrades to its empty-state in that case.
   */
  listFeaturedCollections(locale: string): Promise<readonly FeaturedCollectionRow[]>

  /**
   * All collections for `locale`, ordered by `sort_order ASC` then `id ASC`.
   * Used by the Search page's "other collections" list. Empty array when the
   * tables are missing.
   */
  listCollections(locale: string): Promise<readonly FeaturedCollectionRow[]>

  /**
   * Ordered list of track ids for one collection locale. Empty array when
   * the collection has no members yet, or when the tables are missing.
   * Order is `position ASC`.
   */
  getCollectionTrackIds(collectionId: string, locale: string): Promise<readonly string[]>

  /** Name + cover + description + ordered tracks for the detail surface. */
  getCollection(collectionId: string, locale: string): Promise<CollectionDetail | null>

  /**
   * Localized display name for one collection, or `null` when the collection
   * doesn't exist in `locale` (e.g. removed after a catalog update). Used to
   * label playlist groups from the stored `collection_id` provenance.
   */
  getCollectionName(collectionId: string, locale: string): Promise<string | null>

  /**
   * Distinct authors of a collection, ordered by how many of its tracks each
   * one wrote (dominant first), each with avatar + short bio. Empty when the
   * collection has no tracks / no resolvable authors, or the catalog DB
   * predates the author profile columns. Drives the collection-card avatar
   * pile (overlapping circles) and the detail-sheet header.
   */
  getCollectionAuthors(collectionId: string, locale: string): Promise<readonly CollectionAuthor[]>

  /**
   * The collections one track belongs to, each with the track's place in it.
   * Lets a lecture say which seminar it is part of, and which lecture of it
   * this is. Empty when the track stands alone.
   */
  getCollectionsOfTrack(trackId: string, locale: string): Promise<readonly TrackCollectionRow[]>

  /** Named collection-groups for `locale`, ordered by `sort_order`. */
  listGroups(locale: string): Promise<readonly CollectionGroupRow[]>

  /** Collection headers of one group, in the group's defined order. */
  getGroupCollections(groupId: string, locale: string): Promise<readonly FeaturedCollectionRow[]>
}
