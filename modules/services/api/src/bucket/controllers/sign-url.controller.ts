import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import * as dto from '@lectorium/api/bucket/dto';
import * as dtoShared from '@lectorium/api/shared/dto';
import { S3Service } from '@lectorium/api/bucket/services/s3.service';
import { Routes } from '@lectorium/protocol';

@Controller()
@ApiTags('🪣 Bucket')
export class SignUrlController {
  constructor(private readonly s3Service: S3Service) {}

  /* -------------------------------------------------------------------------- */
  /*                           POST /bucket/sign-url                            */
  /* -------------------------------------------------------------------------- */

  @Post(Routes().bucket.signUrl())
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generates a signed URL for S3 bucket operations',
    operationId: 'bucket::sign-url',
    description:
      `Generates a signed URL for performing operations on an S3 bucket.\n\n` +
      `Returns the signed URL if the request is valid.`,
  })
  @ApiBody({ type: dto.SignUrlRequest })
  @ApiOkResponse({
    type: dto.SignUrlResponse,
    description: 'Signed URL has been generated successfully.',
  })
  @ApiBadRequestResponse({
    type: dtoShared.ErrorResponse,
    description: 'Invalid request parameters.',
  })
  async generateSignedUrl(
    @Body() request: dto.SignUrlRequest,
  ): Promise<dto.SignUrlResponse | dtoShared.ErrorResponse> {
    try {
      // Validate the request
      // TODO: extract validation logic to a validators
      if (!request.bucketName || !request.key || !request.operation) {
        throw new HttpException(
          new dtoShared.ErrorResponse({
            error: 'Bad request.',
            statusCode: HttpStatus.BAD_REQUEST,
            message: ['bucketName, key, and operation are required fields.'],
          }),
          HttpStatus.BAD_REQUEST,
        );
      }

      // Generate the signed URL
      const signedUrl = await this.s3Service.getSignedUrl(
        request.bucketName,
        request.key,
        request.operation,
        request.expiresIn,
      );

      // Return the signed URL
      return new dto.SignUrlResponse({
        success: true,
        signedUrl,
      });
    } catch (error) {
      throw new HttpException(
        new dtoShared.ErrorResponse({
          error: 'Internal server error.',
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: error.message || 'Failed to generate signed URL.',
        }),
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
