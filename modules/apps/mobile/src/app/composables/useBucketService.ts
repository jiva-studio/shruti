import { createGlobalState } from '@vueuse/core'
import { BucketService, useConfig } from '@/app'

export const useBucketService = createGlobalState(() => {
  const config = useConfig()
  return new BucketService(
    config.apiUrl.value, 
    config.authToken.value)
})