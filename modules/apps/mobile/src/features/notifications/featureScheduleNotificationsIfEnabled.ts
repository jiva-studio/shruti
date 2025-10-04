
import { watch } from 'vue'
import { useEventBus } from '@shruti/mobile/core'
import { useConfig } from '@blocks/app.config'


export function featureScheduleNotificationsIfEnabled() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(config.notificationsEnabled, (enabled) => {
    if (enabled && config.notificationsTime.value) { 
      eventBus.notificationsSchedule.notify({ time: config.notificationsTime.value })
    }
  })
}