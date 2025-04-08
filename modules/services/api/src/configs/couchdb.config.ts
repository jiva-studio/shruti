import { registerAs } from '@nestjs/config';

export default registerAs('couchDb', () => ({
  host: process.env.SHRUTI_DB_HOST || 'couchdb',
  port: parseInt(process.env.SHRUTI_DB_PORT ?? '5984', 10),
  username: process.env.SHRUTI_DB_USERNAME || 'shruti',
  password: process.env.SHRUTI_DB_PASSWORD || 'shruti',
  logging: (process.env.SHRUTI_DB_LOGGING ?? 'true') === 'true',
}));
