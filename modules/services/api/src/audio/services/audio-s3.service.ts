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
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import S3Config from '@lectorium/api/configs/s3.config';

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
   * Checks if a file exists in S3
   * @param key - The S3 object key
   * @returns A promise that resolves to true if the file exists, false otherwise
   */
  async fileExists(key: string): Promise<boolean> {
    const bucketName = this.s3Config.bucketName || 'lectorium'; // Default bucket

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
   * Downloads an audio file from S3 to a local file using direct file path
   * @param filePath - The S3 file path (e.g., 'library/tracks/track-123/audio/original.mp3')
   * @param localFilePath - The local file path to save the audio file
   * @returns A promise that resolves when the download is complete
   */
  async downloadAudioFileByPath(
    filePath: string,
    localFilePath: string,
  ): Promise<void> {
    const bucketName = this.s3Config.bucketName || 'lectorium'; // Default bucket

    this.logger.log(
      `Downloading audio file from S3: ${bucketName}/${filePath} to ${localFilePath}`,
    );

    try {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: filePath,
      });

      const response = await this.s3.send(command);

      if (!response.Body) {
        throw new NotFoundException(`Audio file not found: ${filePath}`);
      }

      // Create a write stream and pipe the S3 response to it
      const writeStream = createWriteStream(localFilePath);
      await pipeline(response.Body as Readable, writeStream);

      this.logger.log(
        `Successfully downloaded audio file to: ${localFilePath}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to download audio file ${filePath}: ${error.message}`,
      );
      if (error.name === 'NoSuchKey') {
        throw new NotFoundException(`Audio file not found: ${filePath}`);
      }
      throw error;
    }
  }

  /**
   * Uploads a local file to S3
   * @param key - The S3 object key
   * @param localFilePath - The local file path to upload
   * @returns A promise that resolves when the upload is complete
   */
  async uploadFile(key: string, localFilePath: string): Promise<void> {
    const bucketName = this.s3Config.bucketName || 'lectorium'; // Default bucket

    this.logger.log(
      `Uploading file to S3: ${localFilePath} to ${bucketName}/${key}`,
    );

    try {
      const fileStream = createReadStream(localFilePath);
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: fileStream,
        ContentType: 'audio/mpeg',
      });

      await this.s3.send(command);
      this.logger.log(`Successfully uploaded file: ${bucketName}/${key}`);
    } catch (error) {
      this.logger.error(`Failed to upload file ${key}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets the configured bucket name
   * @returns The bucket name from configuration
   */
  getBucketName(): string {
    return this.s3Config.bucketName || 'lectorium';
  }
}
