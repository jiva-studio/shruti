import { mapTrackToPlaylistItem } from '../mappers/tracks'
import { useDAL } from '@lectorium/mobile/app'


export function useUserSeesUpNextTracksScenario() {
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  async function execute(
    language: string = 'en'
  ) {
    // Get next 10 tracks from the playlist
    const playlistItems = await dal.playlistItems.getMany({
      limit: 10,
      sort: ['addedAt'],
      selector: { 
        type: 'playlistItem', 
        addedAt: { $gte: null } 
      },
    })
    const upNextTrackIds = playlistItems.map(item => item.trackId)
    const upNextTracks = await dal.tracks.getMany({
      selector: { _id : { $in: upNextTrackIds } },
    })

    
    const trackMappers = upNextTrackIds
      .map(x => upNextTracks.find(t => t._id === x)!)  
      .filter(x => x !== undefined)
      .map(x => mapTrackToPlaylistItem(x, language))
    
    return await Promise.all(trackMappers)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    execute
  }
}