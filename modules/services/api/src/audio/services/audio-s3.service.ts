import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import {
  S3,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import S3Config from '@shruti/api/configs/s3.config';

@Injectable()
export class AudioS3Service {
  private readonly logger = new Logger(AudioS3Service.name);
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
   * Retrieves an MP3 file stream from S3
   * @param trackId - The track identifier
   * @param audioType - The audio type (e.g., 'original', 'compressed')
   * @returns A readable stream of the MP3 file
   */
  async getAudioStream(trackId: string, audioType: string): Promise<Readable> {
    const key = `library/tracks/${trackId}/audio/${audioType}.mp3`;
    const bucketName = this.s3Config.bucketName || 'shruti'; // Default bucket

    this.logger.log(`Fetching audio file: ${bucketName}/${key}`);

    try {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      });

      const response = await this.s3.send(command);

      if (!response.Body) {
        throw new NotFoundException(`Audio file not found: ${key}`);
      }

      // Convert the S3 response body to a readable stream
      return response.Body as Readable;
    } catch (error) {
      this.logger.error(`Failed to fetch audio file ${key}: ${error.message}`);
      if (error.name === 'NoSuchKey') {
        throw new NotFoundException(`Audio file not found: ${key}`);
      }
      throw error;
    }
  }

  /**
   * Checks if a file exists in S3
   * @param key - The S3 object key
   * @returns A promise that resolves to true if the file exists, false otherwise
   */
  async fileExists(key: string): Promise<boolean> {
    const bucketName = this.s3Config.bucketName || 'shruti'; // Default bucket

    this.logger.log(`Checking if file exists: ${bucketName}/${key}`);

    try {
      const command = new HeadObjectCommand({
        Bucket: bucketName,
        Key: key,
      });

      await this.s3.send(command);
      return true;
    } catch (error) {
      if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
        return false;
      }
      this.logger.error(
        `Failed to check file existence ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Uploads a stream to S3
   * @param key - The S3 object key
   * @param buffer - The buffer to upload
   * @returns A promise that resolves when the upload is complete
   */
  async uploadBuffer(key: string, buffer: Buffer<ArrayBuffer>): Promise<void> {
    const bucketName = this.s3Config.bucketName || 'shruti'; // Default bucket

    this.logger.log(`Uploading buffer to: ${bucketName}/${key}`);

    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: 'audio/mpeg',
      });

      await this.s3.send(command);
      this.logger.log(`Successfully uploaded: ${bucketName}/${key}`);
    } catch (error) {
      this.logger.error(`Failed to upload stream ${key}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets the configured bucket name
   * @returns The bucket name from configuration
   */
  getBucketName(): string {
    return this.s3Config.bucketName || 'shruti';
  }
}
