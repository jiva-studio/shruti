import { useDAL } from '@/app'
import { usePlayer, usePlayerControls } from '@/player'


export function useSyncPlayerFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const player = usePlayer()
  const playerControls = usePlayerControls()
  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  // Keep trackId of the last track to avoid unnecessary updates
  let lastTrackId = ''

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  player.onProgressChanged(async (progress) => {
    if (!progress.trackId) { return }
    
    // Track has changed, update the title and author
    if (progress.trackId !== lastTrackId) {
      const track = await dal.tracks.getOne(progress.trackId)
      const author = await dal.authors.getOne('author::' + track.author)
      playerControls.author.value = author.fullName['en'] // TODO: add support for other languages
      playerControls.title.value = track.title['en']      // TODO: add support for other languages
    }

    // Update the rest of the player controls
    playerControls.isPlaying.value = progress.playing
    lastTrackId = progress.trackId
  })
}