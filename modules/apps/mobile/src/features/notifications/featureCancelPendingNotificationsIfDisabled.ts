import { watch } from 'vue'
import { LocalNotifications } from '@capacitor/local-notifications'
import { useConfig } from '@blocks/app.config'


export function featureCancelPendingNotificationsIfDisabled() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(config.notificationsEnabled, async (enabled) => {
    if (!enabled) { 
      const pending = await LocalNotifications.getPending() 
      const pendingIds = pending.notifications.map(x => ({ id: x.id }))
      LocalNotifications.cancel({ notifications: pendingIds })
    }
  })
}