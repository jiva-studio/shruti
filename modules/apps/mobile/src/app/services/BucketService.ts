import { S3SignedUrlRequest, S3SignedUrlResponse, Routes } from '@lectorium/protocol/index'

export class BucketService {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async getSignedUrl(
    request: S3SignedUrlRequest
  ): Promise<S3SignedUrlResponse> {
    try {
      const response = await fetch(Routes(this.baseUrl).bucket.signUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify(request),
      })
      console.log(
        `Signing URL at ${Routes(this.baseUrl).bucket.signUrl()} ` +
        `with payload ${JSON.stringify(request)}`)
      if (response.status !== 200) {
        console.error('Filed to sign url', response.status, this.token)
        throw new Error(`Failed to get signed URL: ${response.statusText}`)
      }
      const responseData = await response.json() as S3SignedUrlResponse
      console.log(`Signed url: ${JSON.stringify(responseData)}`)
      return responseData
    } catch (e) {
      console.error('Unhandled exception while signing URL', JSON.stringify(e))
      throw e
    }
  }
}