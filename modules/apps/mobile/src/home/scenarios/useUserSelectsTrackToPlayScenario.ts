import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { useConfig, useDAL } from '@lectorium/mobile/app'
import { usePlayer, usePlayerControls, usePlayerTranscript } from '@lectorium/mobile/player'
import { Filesystem, Directory } from '@capacitor/filesystem'


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
    // Notify user
    await Haptics.impact({ style: ImpactStyle.Light })
    
    const track = await dal.tracks.getOne(trackId)
    const author = await dal.authors.getOne('author::' + track.author)

    // open track with Audio Player plugin and
    // pass required information for media session widget
    const r = await Filesystem.getUri({
      path: track.audio.original.path, // TODO: use audio type [original, normalized, etc]
      directory: Directory.External,
    })

    await player.open({
      trackId: trackId,
      url: r.uri, 
      title: track.title[config.appLanguage.value]
        || track.title['en']
        || track.title[Object.keys(track.title)[0]],
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