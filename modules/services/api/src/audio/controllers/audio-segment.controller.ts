import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import * as dto from '@lectorium/api/audio/dto';
import * as dtoShared from '@lectorium/api/shared/dto';
import {
  AudioProcessingService,
  AudioS3Service,
} from '@lectorium/api/audio/services';
import { S3Service } from '@lectorium/api/bucket/services/s3.service';
import { Routes, S3Operation } from '@lectorium/protocol';
import { AuthenticatedUserGuard } from '@lectorium/api/auth/guards';

@Controller()
@ApiTags('🎵 Audio')
@ApiBearerAuth()
@UseGuards(AuthenticatedUserGuard)
export class AudioSegmentController {
  private readonly logger = new Logger(AudioSegmentController.name);

  constructor(
    private readonly audioProcessingService: AudioProcessingService,
    private readonly audioS3Service: AudioS3Service,
    private readonly s3Service: S3Service,
  ) {}

  /* -------------------------------------------------------------------------- */
  /*                           POST /audio/segment                             */
  /* -------------------------------------------------------------------------- */

  @Post(Routes().audio.segment())
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Extracts a segment from an MP3 audio track or returns cached version',
    operationId: 'audio::segment',
    description:
      `Checks if a cached audio segment exists in S3 at notes/{trackId}_{timeStart}_{timeEnd}_{audioType}.mp3. ` +
      `If it exists, returns a signed URL for download. If not, extracts the segment from the original audio file, ` +
      `uploads it to S3, and returns a signed URL for the newly created segment.`,
  })
  @ApiBody({ type: dto.AudioSegmentRequest })
  @ApiOkResponse({
    type: dto.AudioSegmentUrlResponse,
    description: 'Signed URL to download the audio segment',
  })
  @ApiBadRequestResponse({
    type: dtoShared.ErrorResponse,
    description: 'Invalid request parameters.',
  })
  async extractAudioSegment(
    @Body() request: dto.AudioSegmentRequest,
  ): Promise<dto.AudioSegmentUrlResponse> {
    this.logger.log(
      `Audio segment request: trackId=${request.trackId}, audioType=${request.audioType}, ` +
        `timeStart=${request.timeStart}, timeEnd=${request.timeEnd}`,
    );

    // Validate time parameters
    if (request.timeStart < 0 || request.timeEnd <= request.timeStart) {
      throw new BadRequestException(
        new dtoShared.ErrorResponse({
          error: 'Bad request',
          statusCode: HttpStatus.BAD_REQUEST,
          message: [
            'timeEnd must be greater than timeStart, and timeStart must be non-negative.',
          ],
        }),
      );
    }

    try {
      // Generate the cache key for the segment
      const cacheKey = `notes/${request.trackId}_${request.timeStart}_${request.timeEnd}_${request.audioType}.mp3`;
      const bucketName = this.audioS3Service.getBucketName();

      // Check if the segment already exists in cache
      const segmentExists = await this.audioS3Service.fileExists(cacheKey);
      if (segmentExists) {
        this.logger.log(`Found cached segment: ${cacheKey}`);
        const signedUrl = await this.s3Service.getSignedUrl(
          bucketName,
          cacheKey,
          S3Operation.GetObject,
          3600, // 1 hour expiration
        );
        return new dto.AudioSegmentUrlResponse({ signedUrl });
      }

      // Check if ffmpeg is available
      const ffmpegAvailable =
        await this.audioProcessingService.checkFfmpegAvailability();
      if (!ffmpegAvailable) {
        this.logger.error('FFmpeg is not available on this system');
        throw new HttpException(
          new dtoShared.ErrorResponse({
            error: 'Service unavailable',
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            message: ['Audio processing service is not available.'],
          }),
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      this.logger.log(`Segment not found in cache, generating: ${cacheKey}`);

      // Get the audio file stream from S3
      const audioStream = await this.audioS3Service.getAudioStream(
        request.trackId,
        request.audioType,
      );

      // Extract the segment
      const segmentStream = await this.audioProcessingService.extractSegment(
        audioStream,
        request.timeStart,
        request.timeEnd,
      );

      // Convert stream to buffer for upload
      const chunks: Buffer[] = [];
      for await (const chunk of segmentStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const segmentBuffer = Buffer.concat(chunks);

      // Upload the segment to S3 cache
      await this.audioS3Service.uploadBuffer(cacheKey, segmentBuffer);
      this.logger.log(`Successfully cached segment: ${cacheKey}`);

      // Generate signed URL for the newly uploaded segment
      const signedUrl = await this.s3Service.getSignedUrl(
        bucketName,
        cacheKey,
        S3Operation.GetObject,
        3600, // 1 hour expiration
      );

      return new dto.AudioSegmentUrlResponse({ signedUrl });
    } catch (error) {
      this.logger.error(`Failed to extract audio segment: ${error.message}`);

      const statusCode = error.status || HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(
        new dtoShared.ErrorResponse({
          error: error.message || 'Internal server error',
          statusCode,
          message: [error.message || 'Failed to extract audio segment.'],
        }),
        statusCode,
      );
    }
  }
}
