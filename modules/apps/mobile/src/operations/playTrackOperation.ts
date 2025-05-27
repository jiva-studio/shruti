import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { useDAL } from '@lectorium/mobile/features/app.database'
import { useConfig } from '@lectorium/mobile/features/app.config'
import { usePlayer, usePlayerControls, usePlayerTranscript } from '../features/player'

export function playTrackOperation() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const config = useConfig()
  const player = usePlayer()
  const playerControls = usePlayerControls()
  const playerTranscript = usePlayerTranscript()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function execute(
    playlistItemId: string
  ) {
    // Notify user
    await Haptics.impact({ style: ImpactStyle.Light })
    
    const playlistItem = await dal.playlistItems.getOne(playlistItemId)
    const track = await dal.tracks.getOne(playlistItem.trackId)
    const author = await dal.authors.getOne('author::' + track.author)

    // open track with Audio Player plugin and
    // pass required information for media session widget
    const r = await Filesystem.getUri({
      path: track.audio.original.path, // TODO: use audio type [original, normalized, etc]
      directory: Directory.External,
    })

    await player.open({
      trackId: track._id,
      url: r.uri, 
      title: track.title[config.appLanguage.value]
        || track.title['en']
        || track.title[Object.keys(track.title)[0]]
        || 'No title',
      author: author.fullName[config.appLanguage.value] 
        || author.fullName['en'] 
        || author.fullName[Object.keys(author.fullName)[0]]
        || track.author
        || 'Unknown author',
    })

    // Start playing the track
    await player.play()

    // Set the trackId in the player controls and transcript
    // whey will update their state accordingly
    playerControls.trackId.value = track._id
    playerControls.playlistItemId.value = playlistItem._id
    playerTranscript.trackId.value = track._id
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    execute
  }
}