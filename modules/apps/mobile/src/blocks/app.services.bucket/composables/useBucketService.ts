import { createSharedComposable } from '@vueuse/core'
import { S3SignedUrlRequest, S3SignedUrlResponse } from '@lectorium/protocol/index'
import { BucketService } from '../library/BucketService'

type InitOptions = {
  apiUrl: string
  authToken: string
}

export const useBucketService = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: InitOptions | null = null
  let service: BucketService | null = null

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(o: InitOptions) {
    options = o
    service = new BucketService(
      options.apiUrl, 
      options.authToken
    )
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function getSignedUrl(
    request: S3SignedUrlRequest
  ): Promise<S3SignedUrlResponse> {
    if (!service) {
      throw new Error('BucketService is not initialized. Call init(options) first.')
    }
    return await service.getSignedUrl(request)
  }

  function setAuthToken(token: string) {
    if (!service) {
      throw new Error('BucketService is not initialized. Call init(options) first.')
    }
    service.setAuthToken(token)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, getSignedUrl, setAuthToken }

})