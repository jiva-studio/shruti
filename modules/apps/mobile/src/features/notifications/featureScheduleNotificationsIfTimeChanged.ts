
import { watch } from 'vue'
import { useEventBus } from '@lectorium/mobile/core'
import { useConfig } from '@blocks/app.config'


export function featureScheduleNotificationsIfTimeChanged() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(config.notificationsTime, async (time) => {
    if (config.notificationsEnabled.value && time) { 
      eventBus.notificationsSchedule.notify({ time })
    }
  })
}