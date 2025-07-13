import { useEventBus } from '@lectorium/mobile/core'
import { toastController } from '@ionic/vue'

export function setupToastFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.toastShow.subscribe(async (event) => {
    const toast = await toastController.create({
      header: event.header,
      message: event.message,
      color: event.color || 'primary',
      duration: event.duration || 3000,
      position: 'top',
      swipeGesture: 'vertical',
    })
    
    await toast.present()
  })
}