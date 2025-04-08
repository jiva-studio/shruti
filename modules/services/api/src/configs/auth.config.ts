import { registerAs } from '@nestjs/config';

export default registerAs('auth', () => ({
  /**
   * Saves user permissions in the JWT token. This will allow
   * to keep the permissions in the token itself and avoid
   * querying the database for each request.
   */
  savePermissionsInJwtToken:
    process.env.LECTORIUM_AUTH_SAVE_PERMISSIONS_IN_JWT_TOKEN === 'true',

  /**
   * Time to live for the user permissions cache in seconds.
   * Set to 0 to disable caching for development purposes
   * for example.
   *
   * If `LECTORIUM_AUTH_SAVE_PERMISSIONS_IN_JWT_TOKEN` is set to `false`,
   * then user permissions will be fetched from the database for each
   * request and stored in cache for the specified time.
   *
   * If `LECTORIUM_AUTH_SAVE_PERMISSIONS_IN_JWT_TOKEN` is set to `true`,
   * this will be ignored and user permissions will be stored in the
   * JWT token itself.
   */
  userPermissionsCacheTtl: parseInt(
    process.env.LECTORIUM_AUTH_USER_PERMISSIONS_CACHE_TTL ?? '0',
    10,
  ),
}));
