/**
 * Type of operations that can be performed on an S3 bucket.
 */
export enum S3Operation {
  GetObject = 'getObject',
  PutObject = 'putObject',
  DeleteObject = 'deleteObject',
}

/**
 * Type representing the details of an S3 signed URL request.
 */
export type S3SignedUrlRequest = {
  bucketName: string;
  key: string;
  operation: S3Operation;
  expiresIn?: number;
};

/**
 * Type representing the response for an S3 signed URL generation.
 */
export type S3SignedUrlResponse = {
  success: boolean;
  signedUrl: string;
};