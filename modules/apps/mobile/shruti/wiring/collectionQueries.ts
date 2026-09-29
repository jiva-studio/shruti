import type {
  CollectionDetail,
  CollectionGroupRow,
  FeaturedCollectionRow,
} from "@infra/repositories/sql/collectionTypes.js"
import { useShruti } from "@shruti/shruti.js"

export interface CollectionQueries {
  listGroups(locale: string): Promise<readonly CollectionGroupRow[]>
  listCollections(locale: string): Promise<readonly FeaturedCollectionRow[]>
  getGroupCollections(groupId: string, locale: string): Promise<readonly FeaturedCollectionRow[]>
  getCollection(collectionId: string, locale: string): Promise<CollectionDetail | null>
  getCollectionName(collectionId: string, locale: string): Promise<string | null>
  getCollectionTrackIds(collectionId: string, locale: string): Promise<readonly string[]>
}

/**
 * The curated collections, read straight off the catalog adapter: the catalog
 * publishes them as rows the screens show as they are, with no rule of the
 * app's own in between. Each read resolves the repositories afresh, so it
 * throws until the databases are open.
 */
export function useCollectionQueries(): CollectionQueries {
  const app = useShruti()
  const collections = () => app.repositories().collections
  return {
    listGroups: (locale) => collections().listGroups(locale),
    listCollections: (locale) => collections().listCollections(locale),
    getGroupCollections: (groupId, locale) => collections().getGroupCollections(groupId, locale),
    getCollection: (collectionId, locale) => collections().getCollection(collectionId, locale),
    getCollectionName: (collectionId, locale) =>
      collections().getCollectionName(collectionId, locale),
    getCollectionTrackIds: (collectionId, locale) =>
      collections().getCollectionTrackIds(collectionId, locale),
  }
}
