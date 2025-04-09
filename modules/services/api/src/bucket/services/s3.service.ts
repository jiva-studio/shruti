import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import {
  S3,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { S3Operation } from '@lectorium/protocol';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import S3Config from '@lectorium/api/configs/s3.config';

/**
 * Service for interacting with S3-compatible storage, including generating signed URLs.
 */
@Injectable()
export class S3Service {
  private readonly s3: S3;

  constructor(
    @Inject(S3Config.KEY)
    private readonly s3Config: ConfigType<typeof S3Config>,
  ) {
    this.s3 = new S3({
      endpoint: this.s3Config.endpoint,
      credentials: {
        accessKeyId: this.s3Config.accessKeyId,
        secretAccessKey: this.s3Config.secretAccessKey,
      },
      region: this.s3Config.region,
      forcePathStyle: this.s3Config.forcePathStyle,
    });
  }

  /**
   * Generates a signed URL for performing operations on an S3 bucket.
   * @param bucketName The name of the S3 bucket.
   * @param key The object key in the bucket.
   * @param operation The type of operation (e.g., getObject, putObject).
   * @param expiresIn The expiration time for the signed URL in seconds.
   * @returns A promise that resolves to the signed URL.
   */
  async getSignedUrl(
    bucketName: string,
    key: string,
    operation: S3Operation,
    expiresIn: number = 3600,
  ): Promise<string> {
    const command = {
      Bucket: bucketName,
      Key: key,
    };
    const params = { expiresIn };

    switch (operation) {
      case S3Operation.GetObject:
        return await getSignedUrl(
          this.s3,
          new GetObjectCommand(command),
          params,
        );
      case S3Operation.PutObject:
        return await getSignedUrl(
          this.s3,
          new PutObjectCommand(command),
          params,
        );
      case S3Operation.DeleteObject:
        return await getSignedUrl(
          this.s3,
          new DeleteObjectCommand(command),
          params,
        );
      default:
        throw new Error(`Unsupported S3 operation: ${operation}`);
    }
  }
}
