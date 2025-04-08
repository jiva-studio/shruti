import { registerAs } from '@nestjs/config';

export default registerAs('mailer', () => ({
  host: process.env.SHRUTI_MAILER_HOST ?? 'localhost',
  port: parseInt(process.env.SHRUTI_MAILER_PORT ?? '1025', 10),
  username: process.env.SHRUTI_MAILER_USERNAME ?? 'mailer',
  password: process.env.SHRUTI_MAILER_PASSWORD ?? 'password',
  from: {
    name: process.env.SHRUTI_MAILER_FROM_NAME ?? 'shruti',
    address: process.env.SHRUTI_MAILER_FROM_ADDRESS ?? 'test@shruti.dev',
  },
}));
