import { registerAs } from '@nestjs/config';

export default registerAs('otp', () => ({
  alphabet: process.env.LECTORIUM_OTP_ALPHABET || '0123456789',
  length: parseInt(process.env.LECTORIUM_OTP_LENGTH ?? '6', 10),
}));
