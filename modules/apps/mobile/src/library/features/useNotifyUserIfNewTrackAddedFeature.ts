import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { toastController } from '@ionic/vue'
import { useDAL } from '@/app'

export function useNotifyUserIfNewTrackAddedFeature(
  translate: (key: string) => string
) {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.playlistItems.subscribe(async (e) => {
    if (e.event !== 'added') { return }

    // Haptic feedback
    await Haptics.impact({ style: ImpactStyle.Light })

    // Show toast notification
    const toast = await toastController.create({
      message: translate('library.notifications.newTrackAddedToPlaylist'),
      duration: 1500,
      position: 'top',
      color: 'primary',
    })
    await toast.present()
  })

}