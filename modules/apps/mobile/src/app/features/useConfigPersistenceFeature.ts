import { watch, Ref, toRaw } from 'vue'
import { Storage } from '@ionic/storage'
import { useConfig } from '@/app'

export async function useConfigPersistenceFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */

  const storage = new Storage({ name: 'config' })
  await storage.create()

  // Bind config to storage
  await bind(config.appLanguage, 'app.language', 'en')

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  async function bind<T>(
    config: Ref<T>, 
    key: string, 
    defaultValue: T
  ) {
    config.value = await storage.get(key) || defaultValue
    watch(config, async (value) => {
      await storage.set(key, toRaw(value))
    }, { deep: true })
    console.log(`Bound ${key} to storage: ${config.value}`)
  }
}