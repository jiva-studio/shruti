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
    process.env.LECTORIUM_PRIVATE_KEY ||
    readKey(
      '/etc/lectorium/keys/jwt_private_key.pem',
      '/workspaces/lectorium/data/keys/jwt/jwt_private_key.pem',
    ),
  publicKey:
    process.env.LECTORIUM_PUBLIC_KEY ||
    readKey(
      '/etc/lectorium/keys/jwt_public_key.pem',
      '/workspaces/lectorium/data/keys/jwt/jwt_public_key.pem',
    ),
  accessTokenExpiresIn:
    process.env.LECTORIUM_JWT_ACCESS_TOKEN_EXPIRES_IN || '1d',
  refreshTokenExpiresIn:
    process.env.LECTORIUM_JWT_REFRESH_TOKEN_EXPIRES_IN || '7d',
}));
