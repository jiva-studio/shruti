import axios from 'axios'
import type {
  GetOtpRequest,
  GetOtpResponse,
  OtpSignInRequest,
  OtpSignInResponse,
  RefreshTokensRequest,
  RefreshTokensResponse,
} from '@lectorium/protocol'

export class AuthService {
  constructor(private readonly baseUrl: string) {}

  async requestOtp(request: GetOtpRequest): Promise<GetOtpResponse> {
    try {
      const response = await axios.post<GetOtpResponse>(
        `${this.baseUrl}/auth/otp`,
        request,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
      return response.data
    } catch (error: any) {
      if (error.response) {
        throw new Error(error.response.data.message)
      }
      throw new Error('Failed to request OTP')
    }
  }

  async signInWithOtp(request: OtpSignInRequest): Promise<OtpSignInResponse> {
    try {
      const response = await axios.post<OtpSignInResponse>(
        `${this.baseUrl}/auth/signin/otp`,
        request,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
      return response.data
    } catch (error: any) {
      if (error.response) {
        throw new Error(
          error.response.data.message?.length > 0
            ? error.response.data.message[0]
            : 'Failed to sign in with OTP',
        )
      }
      throw new Error('Failed to sign in with OTP')
    }
  }

  async refreshToken(
    request: RefreshTokensRequest,
  ): Promise<RefreshTokensResponse> {
    try {
      const response = await axios.post<OtpSignInResponse>(
        `${this.baseUrl}/auth/refresh`,
        request,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
      return response.data
    } catch (error: any) {
      if (error.response) {
        throw new Error(error.response.data.message)
      }
      throw new Error('Failed to refresh token')
    }
  }
}
