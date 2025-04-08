import { registerAs } from '@nestjs/config';
import { readFileSync, existsSync } from 'fs';

function readKey(primaryPath: string, fallbackPath: string): string | Buffer {
  if (existsSync(primaryPath)) {
    return readFileSync(primaryPath);
  } else if (existsSync(fallbackPath)) {
    return readFileSync(fallbackPath);
  }
  throw new Error(`Key not found in either ${primaryPath} or ${fallbackPath}`);
}

export default registerAs('jwt', () => ({
  privateKey:
    process.env.SHRUTI_PRIVATE_KEY ||
    readKey(
      '/etc/shruti/keys/jwt_private_key.pem',
      '/workspaces/shruti/data/keys/jwt/jwt_private_key.pem',
    ),
  publicKey:
    process.env.SHRUTI_PUBLIC_KEY ||
    readKey(
      '/etc/shruti/keys/jwt_public_key.pem',
      '/workspaces/shruti/data/keys/jwt/jwt_public_key.pem',
    ),
  accessTokenExpiresIn:
    process.env.SHRUTI_JWT_ACCESS_TOKEN_EXPIRES_IN || '1d',
  refreshTokenExpiresIn:
    process.env.SHRUTI_JWT_REFRESH_TOKEN_EXPIRES_IN || '7d',
}));
