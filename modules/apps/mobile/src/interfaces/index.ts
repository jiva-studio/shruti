import { S3SignedUrlRequest, S3SignedUrlResponse } from '@lectorium/protocol/index'

export interface IBucketService {
  getSignedUrl(request: S3SignedUrlRequest): Promise<S3SignedUrlResponse>;
}

export type GetMediaRequest = {
  trackId: string,
  url: string
  destination: string
}

export interface IMediaService {
  get(request: GetMediaRequest): Promise<void>;
}
