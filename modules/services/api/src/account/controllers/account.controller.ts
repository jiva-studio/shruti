import {
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import * as dtoShared from '@shruti/api/shared/dto';
import { Routes } from '@shruti/protocol';
import { Authentication } from '@shruti/api/auth/decorators';
import { UserAuthentication } from '@shruti/api/auth/utils';
import { AuthenticatedUserGuard } from '@shruti/api/auth/guards';
import { AuthUsersService } from '@shruti/api/auth/services';

@Controller()
@ApiTags('👨🏻‍🦱 Account')
@ApiBearerAuth()
@UseGuards(AuthenticatedUserGuard)
export class AccountController {
  constructor(private readonly users: AuthUsersService) {}

  /* -------------------------------------------------------------------------- */
  /*                           POST /bucket/sign-url                            */
  /* -------------------------------------------------------------------------- */

  @Delete(Routes().account.delete())
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deletes the user account',
    operationId: 'account::delete',
    description:
      'Deletes the user account and all associated data.\n\n' +
      'This action is irreversible and will remove all user data from the system.',
  })
  // @ApiBody({ type: dto.SignUrlRequest })
  // @ApiOkResponse({
  //   type: dto.SignUrlResponse,
  //   description: 'Signed URL has been generated successfully.',
  // })
  @ApiBadRequestResponse({
    type: dtoShared.ErrorResponse,
    description: 'Invalid request parameters.',
  })
  async deleteAccount(
    @Authentication() auth: UserAuthentication,
  ): Promise<any> {
    if (auth.roles.includes('readonly') || auth.userId === 'contentManager') {
      throw new ForbiddenException(
        new dtoShared.ErrorResponse({
          error: 'Forbidden',
          statusCode: HttpStatus.FORBIDDEN,
          message: ['You do not have permission to delete this account.'],
        }),
      );
    }

    try {
      await this.users.deleteByName(auth.userId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}
