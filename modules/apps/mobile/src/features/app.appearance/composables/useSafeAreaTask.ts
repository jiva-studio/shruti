
import { SafeArea, SafeAreaInsets } from 'capacitor-plugin-safe-area'
import { useLogger } from '@lectorium/mobile/features/app.core'

/**
 * Task that manages the safe area insets for the application.
 */
export function useSafeAreaTask() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.appearance' })

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */

  /**
   * Starts the safe area task.
   * @returns A promise that resolves when the task is started
   */
  async function start(): Promise<void> {
    logger.info('Starting safe area task...')
    const insets = await SafeArea.getSafeAreaInsets()
    applyInsets(insets)
    await SafeArea.addListener('safeAreaChanged', (data) => {
      applyInsets(data)
    })

    // Eveything is ready...
    logger.info('Safe area task started successfully')
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  function applyInsets(data: SafeAreaInsets) {
    logger.debug(`Applying safe area insets: ${JSON.stringify(data.insets)}`)
    for (const [key, value] of Object.entries(data.insets)) {
      document.documentElement.style.setProperty(
        `--ion-safe-area-${key}`,
        `${value}px`,
      )
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    start,
  }
}
