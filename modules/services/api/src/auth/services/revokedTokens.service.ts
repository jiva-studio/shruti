import { Injectable } from '@nestjs/common';
import { RedisService } from '@lectorium/api/shared/services';
import { RevokedTokenStorageKey } from '@lectorium/protocol';
import { JwtToken } from '@lectorium/protocol';

@Injectable()
export class RevokedTokensService {
  /**
   * Constructs an instance of the service with the provided Redis configuration.
   *
   * @param redisConfig The configuration object for Redis
   */
  constructor(private readonly redis: RedisService) {}

  /**
   * Checks if the given JWT token has been revoked.
   *
   * @param token - The JWT token to check.
   * @returns A promise that resolves to a boolean indicating whether the token is revoked.
   */
  async isRevoked(token: JwtToken): Promise<boolean> {
    return await this.redis.exists(RevokedTokenStorageKey(token));
  }

  /**
   * Revokes a given JWT token by storing it in a storage with an expiration time.
   *
   * @param token - The JWT token to be revoked.
   * @returns A promise that resolves when the token has been successfully revoked.
   */
  async revoke(token: JwtToken): Promise<void> {
    await this.redis.set(
      RevokedTokenStorageKey(token),
      'revoked',
      token.exp - token.iat,
    );
  }
}
