import { useDAL } from '@lectorium/mobile/app'
import { Track } from '@lectorium/dal/models'
import Sqids from 'sqids'

export function useUserSeesSuggestionsScenario() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const sqids = new Sqids({ 
    minLength: 9,
    alphabet: 'abcdefghijklmnopqrstuvwxyz'
  })

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Fetches a specified number of random track suggestions for the user.
   * @param max - The maximum number of track suggestions to fetch. Defaults to 5.
   * @returns A Promise that resolves to an array of track objects. Any tracks that couldn't be found are filtered out.
   */
  async function execute(max: number = 5): Promise<Track[]> {
    // Get total tracks count
    const totalTracksCount = await dal.tracks.getCount()

    // TODO: make the unique
    // Generate array with random ids -> from 1 to tracksCount
    const randomTrackIds = [...new Set(Array.from(
      { length: max }, 
      () => Math.floor(Math.random() * totalTracksCount) + 1
    ))]

    // Load tracks by that ids, filter out if nothing found
    const tracks = await Promise.all(
      randomTrackIds.map(
        async id => await dal.tracks.findOne({ _id: sqids.encode([id]) })
      )
    )

    // List of tracks
    return tracks.filter((track): track is Track => track != undefined)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { execute }
  
}