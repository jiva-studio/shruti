import { OtpType } from "./otp";

export const UserPermissionsStorageKey = (userId: string) => `users:permissions:${userId}`;

/* -------------------------------------------------------------------------- */
/*                              One Time Password                             */
/* -------------------------------------------------------------------------- */

/**
 * Request to get OTP for the specified destination.
 */
export interface GetOtpRequest {
  /** Type of the destination */
  type: OtpType;

  /** Destination to send the OTP to */
  destination: string;
}

/**
 * Response to get OTP for the specified email.
 */
export interface GetOtpResponse {
  /** True if the OTP has been successfully sent. */
  success: boolean;

  /** Message describing the result of the operation. */
  message: string;
}

/* -------------------------------------------------------------------------- */
/*                                   Tokens                                   */
/* -------------------------------------------------------------------------- */

export interface JwtToken {
  sub: string;
  exp: number;
  iat: number;
  jti: string;
}

export interface AccessToken extends JwtToken {
}

export interface RefreshToken extends JwtToken {
}

/**
 * Generates a storage key for a revoked JWT token.
 * @param token - The JWT token object containing the `jti` (JWT ID) property.
 * @returns A string representing the storage key for the revoked token.
 */
export const RevokedTokenStorageKey = (token: JwtToken) => `tokens:revoked:${token.jti}`;

/* -------------------------------------------------------------------------- */
/*                               Authentication                               */
/* -------------------------------------------------------------------------- */

export interface OtpSignInRequest {
  /** Login to sign up with */
  login: string;

  /** OTP to validate */
  otp: string;
}

export interface OtpSignInResponse {
  /** Access token to authenticate user */
  accessToken: string;

  /** Refresh token to refresh the access token */
  refreshToken: string;
}

export interface RefreshTokensRequest {
  /** Refresh token */
  refreshToken: string;
}

export interface RefreshTokensResponse {
  /** New access token */
  accessToken: string;

  /** Optional refresh token */
  refreshToken: string;
}

export interface SignOutRequest {
  /** Refresh token */
  refreshToken: string;
}

export interface SignOutResponse {
}
