import { useDAL } from '@lectorium/mobile/app'
import { Track } from '@lectorium/dal/models'

export type GetRandomTracksRequest = {
  max: number
  selector?: any
}

export function useRandomTracks() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function get(
    request: GetRandomTracksRequest
  ): Promise<Track[]> {
    // TODO: only first 100 tracks that meet criteria will be considered
    const trackIds = await dal.tracks.getIds({ 
      selector: request.selector || {},
      limit: 100
    })

    // get random ids max of request.max
    const randomTrackIds = trackIds
      .sort(() => Math.random() - 0.5)
      .slice(0, request.max)

    // Load tracks by that ids
    return await dal.tracks.getMany({
      selector: { _id: { $in: randomTrackIds } }
    })
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { get }
}
