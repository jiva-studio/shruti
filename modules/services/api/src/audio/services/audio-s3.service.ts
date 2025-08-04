import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { S3, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
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
   * Retrieves an MP3 file stream from S3
   * @param trackId - The track identifier
   * @param audioType - The audio type (e.g., 'original', 'compressed')
   * @returns A readable stream of the MP3 file
   */
  async getAudioStream(trackId: string, audioType: string): Promise<Readable> {
    const key = `library/tracks/${trackId}/audio/${audioType}.mp3`;
    const bucketName = this.s3Config.bucketName || 'lectorium'; // Default bucket

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
}
