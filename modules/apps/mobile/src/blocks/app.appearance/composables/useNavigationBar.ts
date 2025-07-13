import { NavigationBar } from '@squareetlabs/capacitor-navigation-bar'
import { Capacitor } from '@capacitor/core'
import { createSharedComposable } from '@vueuse/core'
import { useLogger } from '@shruti/mobile/core'

export const useNavigationBar = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.appearance' })

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  /**
   * Starts the navigation bar appearance task.
   * @returns A promise that resolves when the task is started
   */
  async function init() {
    if (Capacitor.getPlatform() !== 'android') { 
      logger.info('Skipping navigation bar task on non-Android platform')
      return 
    }
    
    // Starting the task
    logger.info('Starting navigation bar appearance task...')
    await NavigationBar.setColor({ color: '#ffffff', darkButtons: true })
    await NavigationBar.setTransparency({ isTransparent: true })

    // Everything is ready
    logger.info('Navigation bar appearance task started')
  }


  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  async function setState(state: 'normal' | 'transcript') {
    if (Capacitor.getPlatform() !== 'android') { return }
    
    logger.debug(`Changing navigation bar appearance ${state}`)
    if (state === 'transcript') {
      await NavigationBar.setColor({ color: '#833ad4', darkButtons: false })
    } else {
      await NavigationBar.setColor({ color: '#ffffff', darkButtons: true })
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Interf                                   */
  /* -------------------------------------------------------------------------- */

  return { init, setState }
})