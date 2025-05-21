import { watch } from 'vue'
import { useConfig, useDAL } from '@lectorium/mobile/app'
import { usePlayerControls } from '@lectorium/mobile/player'

/**
 * Sets the player controls info (title and author) based on the trackId.
 * It also updates the info when the app language changes.
 */
export function useSetPlayerControlsInfoFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */
  
  const playerControls = usePlayerControls()
  const dal = useDAL()
  const config = useConfig()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(playerControls.trackId, async (value) => {
    await setInfo(value, config.appLanguage.value) 
  })

  watch(config.appLanguage, async (value) => {
    await setInfo(playerControls.trackId.value, value)
  })

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function setInfo(
    trackId: string, 
    language: string
  ) {
    if (!trackId) { return }
    if (!language) { return }

    const track = await dal.tracks.getOne(trackId)
    const author = await dal.authors.getOne('author::' + track.author)

    playerControls.author.value =
      author.fullName[language] 
        || author.fullName['en'] 
        || track.author
    playerControls.title.value =
      track.title[language]
        || track.title['en']
        || track.title[Object.keys(track.title)[0]]
  }
}