import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useEventBus } from '@lectorium/mobile/core'
import { useConfig } from '@blocks/app.config'
import { useDAL } from '@blocks/app.database'
import { usePlaylistStore } from '@blocks/app.playlist'
import { useLocalization } from '@blocks/app.localization'
import router from '../router'

export function setupOnboardingFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const i18n = useLocalization()
  const config = useConfig()
  const eventBus = useEventBus()
  const playlistStore = storeToRefs(usePlaylistStore())

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.playlistItems.subscribe(async ({ event }) => {
    if (config.tutorialStepsCompleted.value.includes('searchPage')) { return }
    if (!playlistStore.isEmpty.value) { return }
    if (event !== 'added') { return }

    playlistStore.hasChanges.value = true
    eventBus.toastShow.notify({
      color: 'warning',
      message: i18n.global.t('search.notifications.newTrackAddedToPlaylist'),
      duration: 5000
    })
    config.tutorialStepsCompleted.value.push('searchPage')
  })

  watch(router.currentRoute, (route) => {
    if (route.name === 'home') {
      playlistStore.hasChanges.value = false
    }
  })
}