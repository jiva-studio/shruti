import { registerAs } from '@nestjs/config';

export default registerAs('redis', () => ({
  host: process.env.LECTORIUM_REDIS_HOST || 'redis',
  port: parseInt(process.env.LECTORIUM_REDIS_PORT ?? '6379', 10),
}));
