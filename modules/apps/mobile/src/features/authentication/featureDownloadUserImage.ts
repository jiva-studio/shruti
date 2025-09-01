import { useUserAvatarDownloader } from '@blocks/app.auth'
import { useConfig } from '@blocks/app.config'
import { useEventBus, useLogger } from '@shruti/mobile/core'

export function featureDownloadUserImage() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const logger = useLogger({ module: 'featureDownloadUserImage' })
  const eventBus = useEventBus()
  const userAvatarDownloader = useUserAvatarDownloader()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authSignedIn.subscribe(async (event) => {
    if (event.userImageUrl) {
      logger.info('User authenticated. Downloading user image...')
      const avatar = await userAvatarDownloader.download(event.userImageUrl)
      config.userAvatarUrl.value = avatar || ''
    }
  })

}