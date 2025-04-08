import axios from 'axios'
import type { GetUserProfileResponse } from '@lectorium/protocol'

export class UserProfileService {
  constructor(private readonly baseUrl: string) {}

  async getProfile(): Promise<GetUserProfileResponse> {
    try {
      const response = await axios.get<GetUserProfileResponse>(
        `${this.baseUrl}/auth/profile`,
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
}
