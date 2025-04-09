import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtConfig } from '@lectorium/api/configs';
import { RefreshToken } from '@lectorium/protocol';
import { v4 as uuidv4 } from 'uuid';

export type Tokens = {
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class AuthService {
  constructor(
    @Inject(JwtConfig.KEY)
    private readonly jwtConfig: ConfigType<typeof JwtConfig>,
    private readonly jwtService: JwtService,
  ) {}

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
