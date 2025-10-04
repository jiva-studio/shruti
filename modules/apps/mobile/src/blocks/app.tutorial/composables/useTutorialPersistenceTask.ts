import { watch, Ref, toRaw } from 'vue'
import { storeToRefs } from 'pinia'
import { Storage } from '@ionic/storage'
import { useTutorialStore } from './useTutorialStore'

export function useTutorialPersistenceTask() {

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const tutorialStore = storeToRefs(useTutorialStore())
  const persistentStorage = new Storage({ name: 'turorial' })
 
  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */

  async function start() {
    await persistentStorage.create()
    Promise.all([
      bind(tutorialStore.completedSteps, 'tutorial.completedSteps', [])
    ])
  }


  async function bind<T>(
    config: Ref<T>, 
    key: string, 
    defaultValue: T
  ) {
    config.value = await persistentStorage.get(key) ?? defaultValue
    watch(config, async (value) => {
      await persistentStorage.set(key, toRaw(value))
    }, { deep: true })
  }

  return { start }
}
