import { useEventBus } from '@lectorium/mobile/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { useLocalization } from '@blocks/app.localization'


export function featureScheduleDailyNotification() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const i18n = useLocalization() 
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.notificationsSchedule.subscribe(async (event) => {
    let permissions = await LocalNotifications.checkPermissions()
    if (permissions.display !== 'granted') {
      permissions = await LocalNotifications.requestPermissions()
    }
    if (permissions.display !== 'granted') { return }

    const [hours, minutes] = event.time
    await LocalNotifications.schedule({
      notifications: [
        {
          id: 1000, 
          title: i18n.global.t('app.listenToSadhu'),
          body: i18n.global.t('notifications.timeToListen'),
          schedule: {
            on: { hour: hours, minute: minutes },
            allowWhileIdle: true,            
          },
        }
      ]
    })
  })
}