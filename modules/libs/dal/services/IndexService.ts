import { Database } from '../persistence'
import Sqids from 'sqids'

/**
 * Schema of the Source documents in the Library collection.
 */
type IndexDBSchema = {
  _id: string
  tracks: number[]
}

export type SearchResult = {
  ids: Array<string>
}

export class IndexService {
  private readonly sqids = new Sqids({
    minLength: 9,
    alphabet: 'abcdefghijklmnopqrstuvwxyz'
  })

  constructor(
    private readonly database: Database
  ) {}

  /**
   * Searches for Tracks with specified query
   * @param query Query
   * @param language Language
   */
  async search(
    query: string,
  ): Promise<SearchResult> {
    const documentIds: string[][] = []

    // Get stems of words provided
    const terms: string[] = query
      .toLowerCase()
      .split(" ")
      .filter(x => x !== "")

    // Retrieve all documents containing the specified term.
    for (const term of terms) {
      const loadedIndex = await this.database.db.allDocs<IndexDBSchema>({
        startkey: `${term}`,
        endkey: `${term}\uffff`,
        include_docs: true,
      })

      documentIds.push(loadedIndex.rows
        .flatMap(x => x.doc?.tracks || [])
        .map(x => this.sqids.encode([x]))
      )
    }

    // Get common documents ids for all terms
    let commonIds = documentIds[0];
    for (let i = 1; i < documentIds.length; i++) {
      //const currentSet = new Set<string>(documentIds[i] || [])
      //commonIds = new Set([...commonIds].filter(id => currentSet.has(id)));
      commonIds = commonIds.filter(id => documentIds[i].includes(id));
    }
    return {
      ids: [...new Set(commonIds)]
    }
  }
}