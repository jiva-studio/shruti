import { useConfig } from '@blocks/app.config'
import { useEventBus } from '@lectorium/mobile/core'


export function setupTutorialFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.tutorialCompleteStep.subscribe(async (event) => {
    if (config.tutorialStepsCompleted.value.includes(event.step)) {
      return
    }
    config.tutorialStepsCompleted.value.push(event.step)
  })
}