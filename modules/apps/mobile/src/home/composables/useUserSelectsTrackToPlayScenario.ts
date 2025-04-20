import { useDAL } from '@/app'
import { usePlayer, usePlayerControls } from '@/player'


export function useUserSelectsTrackToPlayScenario() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const player = usePlayer()
  const playerControls = usePlayerControls()
  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function execute(trackId: string) {
    const track = await dal.tracks.getOne(trackId)
    const author = await dal.authors.getOne('author::' + track.author)

    await player.open({
      trackId: trackId,
      url: track.audio.original.path, // TODO: use audio type [original, normalized, etc]
      title: track.title.en,          // TODO: use localized title
      author: author.fullName['en'],  // TODO: use localized author
    })
    await player.play()

    // TODO: looks like it didn't help
    //       it still update playr controls slowly
    playerControls.isPlaying.value = !playerControls.isPlaying.value
    playerControls.title.value = track.title.en // TODO: use localized title
    playerControls.author.value = author.fullName['en'] // TODO: use localized author
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    execute
  }
}