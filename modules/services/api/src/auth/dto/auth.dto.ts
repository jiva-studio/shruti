import { ApiProperty } from '@nestjs/swagger';
import * as protocol from '@lectorium/protocol';
import { IsNotEmpty, IsString } from 'class-validator';

/* -------------------------------------------------------------------------- */
/*                                Authentcation                               */
/* -------------------------------------------------------------------------- */

export class OtpSignInRequest implements protocol.OtpSignInRequest {
  @ApiProperty({ example: 'example@example.com' })
  @IsNotEmpty()
  login: string;

  @ApiProperty({ example: '123123' })
  @IsString()
  @IsNotEmpty()
  otp: string;
}

export class OtpSignInResponse implements protocol.OtpSignInResponse {
  constructor(options: { accessToken: string; refreshToken: string }) {
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
  }

  @ApiProperty({ example: 'token' })
  @IsString()
  accessToken: string;

  @ApiProperty({ example: 'token' })
  @IsString()
  refreshToken: string;
}

export class JwtSignInRequest implements protocol.JwtSignInRequest {
  @ApiProperty()
  @IsNotEmpty()
  jwt: string;

  @ApiProperty({ example: 'google' })
  @IsString()
  @IsNotEmpty()
  provider: 'google';
}

export class JwtSignInResponse implements protocol.OtpSignInResponse {
  constructor(options: { accessToken: string; refreshToken: string }) {
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
  }

  @ApiProperty({ example: 'token' })
  @IsString()
  accessToken: string;

  @ApiProperty({ example: 'token' })
  @IsString()
  refreshToken: string;
}

export class RefreshTokensRequest implements protocol.RefreshTokensRequest {
  @ApiProperty({ example: 'refreshToken' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class SignOutRequest implements protocol.SignOutRequest {
  @ApiProperty({ example: 'refreshToken' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class SignOutResponse implements protocol.SignOutResponse {}

/* -------------------------------------------------------------------------- */
/*                                   Tokens                                   */
/* -------------------------------------------------------------------------- */

export class RefreshTokensResponse implements protocol.RefreshTokensResponse {
  constructor(options: { accessToken: string; refreshToken: string }) {
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
  }

  @ApiProperty({ example: 'accessToken' })
  @IsString()
  @IsNotEmpty()
  accessToken: string;

  @ApiProperty({ example: 'refreshToken' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
