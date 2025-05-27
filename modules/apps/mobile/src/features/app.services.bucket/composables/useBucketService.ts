import { createSharedComposable } from '@vueuse/core'
import { BucketService } from '../library/BucketService'
import { useConfig } from '@lectorium/mobile/features/app.config'

export const useBucketService = createSharedComposable(() => {
  const config = useConfig()
  return new BucketService(
    config.apiUrl.value, 
    config.authToken.value)
})