import { DownloaderService } from '../library/DownloaderService'
import { createSharedComposable } from '@vueuse/core'

 
 export const useDownloaderService = createSharedComposable(() => {
  return new DownloaderService()
 })