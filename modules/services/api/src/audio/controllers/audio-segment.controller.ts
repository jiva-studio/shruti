import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
  Res,
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
  ApiProduces,
} from '@nestjs/swagger';
import { Response } from 'express';
import * as dto from '@lectorium/api/audio/dto';
import * as dtoShared from '@lectorium/api/shared/dto';
import {
  AudioProcessingService,
  AudioS3Service,
} from '@lectorium/api/audio/services';
import { Routes } from '@lectorium/protocol';
import { Authentication } from '@lectorium/api/auth/decorators';
import { UserAuthentication } from '@lectorium/api/auth/utils';
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
  ) {}

  /* -------------------------------------------------------------------------- */
  /*                           POST /audio/segment                             */
  /* -------------------------------------------------------------------------- */

  @Post(Routes().audio.segment())
  @HttpCode(200)
  @ApiOperation({
    summary: 'Extracts a segment from an MP3 audio track',
    operationId: 'audio::segment',
    description:
      `Fetches an MP3 file from S3 storage, extracts a specific time segment, ` +
      `and returns it as an MP3 stream. The audio file is expected to be stored ` +
      `at library/tracks/{trackId}/audio/{audioType}.mp3 in S3.`,
  })
  @ApiBody({ type: dto.AudioSegmentRequest })
  @ApiProduces('audio/mpeg')
  @ApiOkResponse({
    description: 'MP3 audio segment stream',
    schema: {
      type: 'string',
      format: 'binary',
    },
  })
  @ApiBadRequestResponse({
    type: dtoShared.ErrorResponse,
    description: 'Invalid request parameters.',
  })
  async extractAudioSegment(
    @Body() request: dto.AudioSegmentRequest,
    @Authentication() auth: UserAuthentication,
    @Res() response: Response,
  ): Promise<void> {
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

      // Set response headers
      response.setHeader('Content-Type', 'audio/mpeg');
      response.setHeader(
        'Content-Disposition',
        `attachment; filename="${request.trackId}_${request.audioType}_${request.timeStart}-${request.timeEnd}.mp3"`,
      );

      // Pipe the segment stream to the response
      segmentStream.pipe(response);

      // Handle stream errors
      segmentStream.on('error', (error) => {
        this.logger.error(`Segment stream error: ${error.message}`);
        if (!response.headersSent) {
          response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(
            new dtoShared.ErrorResponse({
              error: 'Internal server error',
              statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
              message: ['Failed to process audio segment.'],
            }),
          );
        }
      });
    } catch (error) {
      this.logger.error(`Failed to extract audio segment: ${error.message}`);

      if (!response.headersSent) {
        const statusCode = error.status || HttpStatus.INTERNAL_SERVER_ERROR;
        response.status(statusCode).json(
          new dtoShared.ErrorResponse({
            error: error.message || 'Internal server error',
            statusCode,
            message: [error.message || 'Failed to extract audio segment.'],
          }),
        );
      }
    }
  }
}
