import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import * as dto from '@lectorium/api/auth/dto';
import * as dtoShared from '@lectorium/api/shared/dto';
import { AuthenticatedUserGuard } from '@lectorium/api/auth/guards';
import {
  AuthService,
  AuthUsersService,
  OtpService,
  RevokedTokensService,
} from '@lectorium/api/auth/services';
import { Routes } from '@lectorium/protocol';
import { OAuth2Client } from 'google-auth-library';

import { Authentication } from '../decorators';
import { UserAuthentication } from '../utils';
import { AuthConfig } from '@lectorium/api/configs';
import { ConfigType } from '@nestjs/config';

@Controller()
@ApiTags('🔐 Authentication')
export class UserAuthenticationController {
  constructor(
    private readonly otpService: OtpService,
    private readonly usersService: AuthUsersService,
    private readonly authService: AuthService,
    private readonly revokedTokensService: RevokedTokensService,
    @Inject(AuthConfig.KEY)
    private readonly authConfig: ConfigType<typeof AuthConfig>,
  ) {}

  /* -------------------------------------------------------------------------- */
  /*                            POST /auth/signin/otp                           */
  /* -------------------------------------------------------------------------- */

  @Post(Routes().auth.signIn('otp'))
  @HttpCode(200)
  @ApiOperation({
    summary: 'Signs user in with OTP',
    operationId: 'auth::signIn::otp',
    description:
      `Signs user in with one-time password.\n\n` +
      `Returns access and refresh tokens if the user has been authenticated.`,
  })
  @ApiOkResponse({
    type: dto.OtpSignInResponse,
    description: 'User has been authenticated.',
  })
  @ApiUnauthorizedResponse({
    type: dtoShared.ErrorResponse,
    description: 'OTP is invalid.',
  })
  @ApiTooManyRequestsResponse({
    type: dtoShared.ErrorResponse,
    description: 'Too many requests',
  })
  async signinWithOtp(
    @Body() request: dto.OtpSignInRequest,
  ): Promise<dto.OtpSignInResponse> {
    // TODO rate limit login attempts by login

    // validate OTP, if invalid send 401 Unauthorized response
    const otp = await this.otpService.validate(request.login, request.otp);
    if (!otp) {
      throw new UnauthorizedException(
        new dtoShared.ErrorResponse({
          message: ['Invalid OTP'],
          statusCode: 401,
          error: 'Unauthorized',
        }),
      );
    }

    // get or create user by login and start new session
    const user = await this.usersService.findByName(request.login);
    if (!user) {
      throw new UnauthorizedException(
        new dtoShared.ErrorResponse({
          message: ['Unauthorized'],
          statusCode: 401,
          error: 'Unauthorized',
        }),
      );
    }
    const tokens = await this.authService.generateTokens(user.name, user.roles);

    return new dto.OtpSignInResponse({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  }

  /* -------------------------------------------------------------------------- */
  /*                           POST /auth/signin/google                         */
  /* -------------------------------------------------------------------------- */

  @Post(Routes().auth.signIn('jwt'))
  @HttpCode(200)
  @ApiOperation({
    summary: 'Signs user in with third-party JWT token',
    operationId: 'auth::signIn::jwt',
    description:
      `Signs user in with third-party JWT token.\n\n` +
      `Returns access and refresh tokens if the user has been authenticated.`,
  })
  @ApiOkResponse({
    type: dto.JwtSignInResponse,
    description: 'User has been authenticated.',
  })
  @ApiUnauthorizedResponse({
    type: dtoShared.ErrorResponse,
    description: 'JWT is invalid.',
  })
  @ApiTooManyRequestsResponse({
    type: dtoShared.ErrorResponse,
    description: 'Too many requests',
  })
  async signinWithJWT(
    @Body() request: dto.JwtSignInRequest,
  ): Promise<dto.JwtSignInResponse> {
    // TODO rate limit login attempts by login

    // validate JWT token using Google OAuth2 client
    let userEmail = '';
    try {
      if (request.provider === 'google') {
        const oauthClientId = this.authConfig.googleOAuthClientId;
        const client = new OAuth2Client(oauthClientId);
        const ticket = await client.verifyIdToken({
          idToken: request.jwt,
        });
        const payload = ticket.getPayload();

        // validate payload
        if (!payload?.email_verified || !payload.email) {
          throw new UnauthorizedException(
            new dtoShared.ErrorResponse({
              message: ['No email provided or it is not verified yet'],
              statusCode: 401,
              error: 'Unauthorized',
            }),
          );
        }
        userEmail = payload.email;
      } else {
        throw new Error('Unsupported provider');
      }
    } catch (error: any) {
      throw new UnauthorizedException(
        new dtoShared.ErrorResponse({
          message: [error.message || 'Invalid JWT token'],
          statusCode: 401,
          error: 'Unauthorized',
        }),
      );
    }

    // get or create user by login and start new session
    const user = await this.usersService.findOrCreateByName(userEmail);

    // generate new JWT tokens
    const tokens = await this.authService.generateTokens(user.name, user.roles);
    return new dto.JwtSignInResponse({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  }

  /* -------------------------------------------------------------------------- */
  /*                              POST /auth/logout                             */
  /* -------------------------------------------------------------------------- */

  @Post(Routes().auth.signOut())
  @UseGuards(AuthenticatedUserGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Signs user out',
    operationId: 'auth::signOut',
    description:
      `Signs user out.\n\n` +
      `Revokes the refresh token and signs the user out.`,
  })
  @ApiOkResponse({
    type: dto.SignOutResponse,
    description: 'User has been logged out.',
  })
  @ApiBadRequestResponse({
    type: dtoShared.ErrorResponse,
    description: 'Invalid request.',
  })
  @ApiUnauthorizedResponse({
    type: dtoShared.ErrorResponse,
    description: 'Unauthorized request.',
  })
  async logoutUser(
    @Body() request: dto.SignOutRequest,
    @Authentication() auth: UserAuthentication,
  ): Promise<dto.SignOutResponse> {
    // revoke access token to prevent reusing it
    await this.revokedTokensService.revoke(auth.accessToken);

    // revoke refresh token if still valid
    const token = await this.authService.verifyToken(request.refreshToken);
    if (token) {
      await this.revokedTokensService.revoke(token);
    }

    // user logged out
    return new dto.SignOutResponse();
  }
}
