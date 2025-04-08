import { registerAs } from '@nestjs/config';

export default registerAs('couchDb', () => ({
  host: process.env.LECTORIUM_DB_HOST || 'couchdb',
  port: parseInt(process.env.LECTORIUM_DB_PORT ?? '5984', 10),
  username: process.env.LECTORIUM_DB_USERNAME || 'lectorium',
  password: process.env.LECTORIUM_DB_PASSWORD || 'lectorium',
  logging: (process.env.LECTORIUM_DB_LOGGING ?? 'true') === 'true',
}));
