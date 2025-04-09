import { registerAs } from '@nestjs/config';

export default registerAs('s3', () => ({
  endpoint: process.env.LECTORIUM_S3_ENDPOINT,
  accessKeyId: process.env.LECTORIUM_S3_ACCESS_KEY || '',
  secretAccessKey: process.env.LECTORIUM_S3_SECRET_KEY || '',
  region: process.env.LECTORIUM_S3_REGION,
  forcePathStyle: process.env.LECTORIUM_S3_FORCE_PATH_STYLE === 'true',
}));
