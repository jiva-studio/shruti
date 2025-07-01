import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import * as dto from '@lectorium/api/bucket/dto';
import * as dtoShared from '@lectorium/api/shared/dto';
import { S3Service } from '@lectorium/api/bucket/services/s3.service';
import { Routes, S3Operation } from '@lectorium/protocol';
import { Authentication } from '@lectorium/api/auth/decorators';
import { UserAuthentication } from '@lectorium/api/auth/utils';
import { AuthenticatedUserGuard } from '@lectorium/api/auth/guards';

@Controller()
@ApiTags('🪣 Bucket')
@ApiBearerAuth()
@UseGuards(AuthenticatedUserGuard)
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
    @Authentication() auth: UserAuthentication,
  ): Promise<dto.SignUrlResponse | dtoShared.ErrorResponse> {
    if (
      !auth.roles.includes('contentManager') &&
      !auth.roles.includes('readonly') &&
      !auth.roles.includes('user')
    ) {
      throw new ForbiddenException(
        new dtoShared.ErrorResponse({
          error: 'Forbidden',
          statusCode: HttpStatus.FORBIDDEN,
          message: ['User does not have permission to perform this action.'],
        }),
      );
    }

    if (
      auth.roles.includes('readonly') &&
      request.operation !== S3Operation.GetObject
    ) {
      throw new ForbiddenException(
        new dtoShared.ErrorResponse({
          error: 'Forbidden',
          statusCode: HttpStatus.FORBIDDEN,
          message: [
            'User with readonly role can only perform getObject operation.',
          ],
        }),
      );
    }

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
