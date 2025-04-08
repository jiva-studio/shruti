import { registerAs } from '@nestjs/config';

export default registerAs('redis', () => ({
  host: process.env.SHRUTI_REDIS_HOST || 'redis',
  port: parseInt(process.env.SHRUTI_REDIS_PORT ?? '6379', 10),
}));
