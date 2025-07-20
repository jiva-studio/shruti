import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthConfig, JwtConfig } from '@lectorium/api/configs';
import { RefreshToken } from '@lectorium/protocol';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export type Tokens = {
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class AuthService {
  constructor(
    @Inject(JwtConfig.KEY)
    private readonly jwtConfig: ConfigType<typeof JwtConfig>,
    @Inject(AuthConfig.KEY)
    private readonly authConfig: ConfigType<typeof AuthConfig>,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Converts email to user ID.
   * @param email Email to convert to user ID.
   * @returns Resulting user ID.
   */
  getUserIdFromEmail(email: string): string {
    return crypto
      .createHash('sha256')
      .update(email.toLowerCase().trim() + this.authConfig.userIdGenerationSalt)
      .digest('hex');
  }

  /**
   * Generates access and refresh tokens for the user.
   * @param userId User ID
   * @param roles User roles
   * @returns Access and refresh tokens
   */
  async generateTokens(userId: string, roles: string[]): Promise<Tokens> {
    const accessToken = await this.jwtService.signAsync(
      {
        jti: uuidv4(),
        sub: userId,
        roles,
      },
      {
        expiresIn: this.jwtConfig.accessTokenExpiresIn,
        privateKey: this.jwtConfig.privateKey,
      },
    );
    const refreshToken = await this.jwtService.signAsync(
      {
        jti: uuidv4(),
        sub: userId,
      },
      {
        expiresIn: this.jwtConfig.refreshTokenExpiresIn,
        privateKey: this.jwtConfig.privateKey,
      },
    );

    return {
      accessToken,
      refreshToken,
    };
  }

  /**
   * Verifies token and returns its payload.
   * @param token Token to verify
   * @returns Token payload if the token is valid, otherwise undefined
   */
  async verifyToken(token: string): Promise<RefreshToken | undefined> {
    try {
      const payload = await this.jwtService.verifyAsync<RefreshToken>(token, {
        publicKey: this.jwtConfig.publicKey,
      });
      return payload;
    } catch {
      return undefined;
    }
  }
}
