import { watch } from 'vue'
import { NavigationBar } from '@squareetlabs/capacitor-navigation-bar'
import { usePlayerTranscript } from '@/player'

export async function useNavigationBarFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const { isOpen: isPlayerPageOpen } = usePlayerTranscript()

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */
  
  await NavigationBar.setColor({ color: '#ffffff', darkButtons: true })
  await NavigationBar.setTransparency({ isTransparent: true })

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(isPlayerPageOpen, async (value) => {
    if (value) {
      await NavigationBar.setColor({ color: '#833ad4', darkButtons: false })
    } else {
      await NavigationBar.setColor({ color: '#ffffff', darkButtons: true })
    }
  })
}