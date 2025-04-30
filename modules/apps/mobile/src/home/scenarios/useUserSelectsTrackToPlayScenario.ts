import { useConfig, useDAL } from '@lectorium/mobile/app'
import { usePlayer, usePlayerControls, usePlayerTranscript } from '@lectorium/mobile/player'


export function useUserSelectsTrackToPlayScenario() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const player = usePlayer()
  const playerTranscript = usePlayerTranscript()
  const playerControls = usePlayerControls()
  const dal = useDAL()
  const config = useConfig()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function execute(trackId: string) {
    const track = await dal.tracks.getOne(trackId)
    const author = await dal.authors.getOne('author::' + track.author)

    // open track with Audio Player plugin and
    // pass required information for media session widget
    await player.open({
      trackId: trackId,
      url: track.audio.original.path, // TODO: use audio type [original, normalized, etc]
      title: track.title[config.appLanguage.value]
        || track.title['en'],
      author: author.fullName[config.appLanguage.value] 
        || author.fullName['en'] 
        || track.author
    })

    // Start playing the track
    await player.play()

    // Set the trackId in the player controls and transcript
    // whey will update their state accordingly
    playerControls.trackId.value = trackId
    playerTranscript.trackId.value = trackId
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    execute
  }
}