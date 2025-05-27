import { Ref } from 'vue'
import { NavigationBar } from '@squareetlabs/capacitor-navigation-bar'
import { Capacitor } from '@capacitor/core'
import { watchPausable } from '@vueuse/core'
import { useLogger } from '@lectorium/mobile/features/app.core'

type Options = {
  isTranscriptDialogOpen: Ref<boolean>
}

/**
 * A task that manages the navigation bar appearance based on the state of
 * the transcript dialog.
 *  
 * @param options.isTranscriptDialogOpen - A ref that indicates whether
 *        the transcript dialog is open
 */
export function useNavigationBarAppearanceTask({ 
  isTranscriptDialogOpen 
}: Options) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.appearance' })

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  const hook = watchPausable(isTranscriptDialogOpen, async (value) => {
    logger.debug(`Changing navigation bar appearance: { isTranscriptDialogOpen: ${value} }`)
    if (value) {
      await NavigationBar.setColor({ color: '#833ad4', darkButtons: false })
    } else {
      await NavigationBar.setColor({ color: '#ffffff', darkButtons: true })
    }
  }, { initialState: 'paused' })

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */
  
  /**
   * Starts the navigation bar appearance task.
   * @returns A promise that resolves when the task is started
   */
  async function start(): Promise<void> {
    if (Capacitor.getPlatform() !== 'android') { 
      logger.info('Skipping navigation bar task on non-Android platform')
      return 
    }
    
    // Starting the task
    logger.info('Starting navigation bar appearance task...')
    await NavigationBar.setColor({ color: '#ffffff', darkButtons: true })
    await NavigationBar.setTransparency({ isTransparent: true })
    hook.resume()

    // Everything is ready
    logger.info('Navigation bar appearance task started')
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Interf                                   */
  /* -------------------------------------------------------------------------- */

  return {
    start
  }
}