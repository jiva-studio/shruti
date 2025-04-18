import { S3SignedUrlRequest, S3SignedUrlResponse, Routes } from '@lectorium/protocol/index'

export class BucketService {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async getSignedUrl(
    request: S3SignedUrlRequest
  ): Promise<S3SignedUrlResponse> {
    const response = await fetch(Routes(this.baseUrl).bucket.signUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(request),
    })
    if (response.status !== 200) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`)
    }
    return await response.json() as S3SignedUrlResponse
  }
}