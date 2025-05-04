import { useDAL } from '@lectorium/mobile/app'
import { Author } from '@lectorium/dal/models'

export type GetRandomAuthorsRequest = {
  max: number
  selector?: any
}

export function useRandomAuthors() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function get(
    request: GetRandomAuthorsRequest
  ): Promise<Author[]> {
    // TODO: only first 100 tracks that meet criteria will be considered
    const itemIds = await dal.authors.getIds({ 
      selector: request.selector || {},
      limit: 100
    })

    // get random ids max of request.max
    const randomItemIds = itemIds
      .sort(() => Math.random() - 0.5)
      .slice(0, request.max)

    // Load tracks by that ids
    return await dal.authors.getMany({
      selector: { _id: { $in: randomItemIds } }
    })
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { get }
}
