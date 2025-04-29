import { registerAs } from '@nestjs/config';

export default registerAs('mailer', () => ({
  host: process.env.LECTORIUM_MAILER_HOST ?? 'localhost',
  port: parseInt(process.env.LECTORIUM_MAILER_PORT ?? '1025', 10),
  username: process.env.LECTORIUM_MAILER_USERNAME ?? 'mailer',
  password: process.env.LECTORIUM_MAILER_PASSWORD ?? 'password',
  from: {
    name: process.env.LECTORIUM_MAILER_FROM ?? 'lectorium',
    address: process.env.LECTORIUM_MAILER_FROM_ADDRESS ?? 'test@lectorium.dev',
  },
}));
