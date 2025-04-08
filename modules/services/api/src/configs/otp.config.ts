import { registerAs } from '@nestjs/config';

export default registerAs('otp', () => ({
  alphabet: process.env.SHRUTI_OTP_ALPHABET || '0123456789',
  length: parseInt(process.env.SHRUTI_OTP_LENGTH ?? '6', 10),
}));
