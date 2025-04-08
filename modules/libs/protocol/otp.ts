/**
 * Returns the key for storing OTP in Redis for a given login
 * @param login Login of the user OTP is generated for
 * @returns Key for storing OTP in Redis
 */
export const OtpStorageKey = (login: string) => `otp:${login}`;

/**
 * Type of the destination to send the OTP to.
 */
export enum OtpType {
  Email = 'email',
  Sms = 'sms',
}

export type OtpMethod = `${OtpType}`;

export type Otp = {
  code: string;
  type: OtpType;
}